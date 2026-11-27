const { MSG, STATE } = globalThis.LIVE_SUBS;
const DIAG = globalThis.LIVE_DIAG;
DIAG.install();

const TARGET_SAMPLE_RATE = 16000;
const VAD_FRAME_SAMPLES = 512;
const VAD_CONTEXT_SAMPLES = 64; // Silero v5 reference wrapper carries 64 samples of left context
const VAD_SPEECH_THRESHOLD = 0.25; // Recovers quiet & BGM-layered speech; CTC confidence gate filters non-speech
const VAD_CONTINUE_THRESHOLD = 0.20; // Keeps soft sentence endings and particles attached
const VAD_SPEECH_ONSET_FRAMES = 3; // 3 consecutive frames (~96ms) to trigger onset
// Endpoint = pure latency: the final decode cannot start until this much
// silence is seen, and the user is staring at a stale line meanwhile. 15
// frames = 480 ms keeps ~15 frames of hysteresis below VAD_CONTINUE_THRESHOLD.
const END_SILENCE_FRAMES = 15;
const END_SILENCE_SAMPLES = END_SILENCE_FRAMES * VAD_FRAME_SAMPLES;
const SPECULATIVE_SILENCE_FRAMES = 11; // 11 * 32ms = 352ms > TAIL_PAD_SAMPLES (350ms)
const SPECULATIVE_SILENCE_SAMPLES = SPECULATIVE_SILENCE_FRAMES * VAD_FRAME_SAMPLES;
const INTERIM_SILENCE_SUPPRESS_SAMPLES = 6 * VAD_FRAME_SAMPLES; // 192ms: avoid doomed interim before speculative final
const VAD_ZERO_SILENCE_HANGOVER = 16; // ~512ms of exact zero audio lets Silero LSTM state decay safely
const ANCHOR_PREROLL_SAMPLES = Math.round(0.40 * TARGET_SAMPLE_RATE); // 0.40s preroll (6,400 samples, 0ms added latency)
const TAIL_PAD_SAMPLES = Math.round(0.35 * TARGET_SAMPLE_RATE); // 0.35s tail pad (5,600 samples, inside 480ms endpoint)
// Decode window floor. The window spans preroll + speech + tail pad. A shorter
// window widens backwards into the ring (using real preceding audio masked by
// emitFrom, or left-padded with silence at stream start) rather than dropped.
const MIN_UTTERANCE_SAMPLES = Math.round(1.0 * TARGET_SAMPLE_RATE);
const MIN_POST_SPLIT_NEW_SAMPLES = Math.round(0.40 * TARGET_SAMPLE_RATE);
const SPLIT_SEARCH_MIN_SAMPLES = Math.round(4.5 * TARGET_SAMPLE_RATE);
const SPLIT_TRIGGER_SAMPLES = Math.round(7.4 * TARGET_SAMPLE_RATE);
const SPLIT_LEFT_CONTEXT_SAMPLES = Math.round(0.60 * TARGET_SAMPLE_RATE); // 0.60s left context for bidirectional encoder
const MAX_UTTERANCE_SAMPLES = Math.round(8.0 * TARGET_SAMPLE_RATE); // 8.0s hard cap per utterance
const LFR_FRAME_SAMPLES = 160 * 6; // 10ms STFT shift * LFR stride 6 = 960 samples (60ms) per CTC output frame
const DECODE_STEP_MS = 500;
const HOLDBACK_CHARS = 4; // 4 characters holdback for local agreement
const ASR_STOP_TIMEOUT_MS = 2000; // upper bound on awaiting a decode during stop
const RING_BUFFER_SECONDS = 20;
const RING_BUFFER_SAMPLES = RING_BUFFER_SECONDS * TARGET_SAMPLE_RATE;
const ASR_WASM_THREADS = globalThis.crossOriginIsolated
  ? Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 4) - 1))
  : 1;

// Engine identity, recorded once: every "it is slow" report needs the thread
// count and isolation state, because 1 thread versus 4 is a 3x difference and
// both are silent in the UI.
DIAG.set("engine.sampleRate", TARGET_SAMPLE_RATE);
DIAG.set("engine.threads", ASR_WASM_THREADS);
DIAG.set("engine.crossOriginIsolated", Boolean(globalThis.crossOriginIsolated));
DIAG.set("engine.decodeStepMs", DECODE_STEP_MS);
DIAG.set("engine.maxWindowS", MAX_UTTERANCE_SAMPLES / TARGET_SAMPLE_RATE);

let session = null;
let intentionalStop = false;
let offscreenState = STATE.IDLE;
let nextSessionId = 1;
let globalVadChain = Promise.resolve();
let globalAsrChain = Promise.resolve();
let activePcmDrain = Promise.resolve();
let pendingConfigHotwords;
let ortEnvReady = false;

function initOrtEnv() {
  if (ortEnvReady) return;
  ortEnvReady = true;
  ort.env.wasm.wasmPaths = chrome.runtime.getURL("lib/");
  ort.env.wasm.numThreads = ASR_WASM_THREADS;
}

function withVadLock(task) {
  const run = globalVadChain.then(task, task);
  globalVadChain = run.then(() => {}, () => {});
  return run;
}

// ─── Silero VAD (Fixed 576-sample layout with 64-sample rolling context) ───
let vadSession = null, vadState = null, vadSr = null, vadContext = null, vadLoaded = false;
let vadInputTensor = null;
const vadInputBuffer = new Float32Array(VAD_CONTEXT_SAMPLES + VAD_FRAME_SAMPLES);
const vadFloatFrame = new Float32Array(VAD_FRAME_SAMPLES);

async function loadVad() {
  if (vadLoaded) return;
  const startedAt = performance.now();
  initOrtEnv();
  vadSession = await ort.InferenceSession.create(
    chrome.runtime.getURL("lib/silero_vad.onnx"), { executionProviders: ["wasm"] }
  );
  resetVadState();
  vadSr = new ort.Tensor("int64", BigInt64Array.from([BigInt(TARGET_SAMPLE_RATE)]), []);
  vadInputTensor = new ort.Tensor("float32", vadInputBuffer, [1, vadInputBuffer.length]);
  vadLoaded = true;
  DIAG.set("vad.loadMs", Math.round(performance.now() - startedAt));
  DIAG.mark("vad", "loaded");
}

function resetVadState() {
  vadState = new ort.Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
  vadContext = new Float32Array(VAD_CONTEXT_SAMPLES);
}

function runVad(float32Audio) {
  if (!vadSession) return Promise.resolve(1.0);
  return withVadLock(async () => {
    if (!vadSession) return 1.0;
    vadInputBuffer.set(vadContext, 0);
    vadInputBuffer.set(float32Audio, VAD_CONTEXT_SAMPLES);
    if (!vadInputTensor) {
      vadInputTensor = new ort.Tensor("float32", vadInputBuffer, [1, vadInputBuffer.length]);
    }
    const r = await vadSession.run({
      input: vadInputTensor,
      state: vadState,
      sr: vadSr
    });
    vadState = r.stateN;
    vadContext.set(float32Audio.subarray(float32Audio.length - VAD_CONTEXT_SAMPLES));
    return r.output.data[0];
  });
}

// ─── SenseVoice ONNX Engine ────────────────────────────────────────
let asrSession = null, asrFrontend = null, asrTokens = null, asrTextToId = null, asrLoaded = false;
let asrSpaceId = -1;
let asrIsWordToken = null;
let asrLangTensor = null;
let asrTextNormTensor = null;
const asrLengthBuf = new Int32Array(1);
let asrLengthTensor = null;
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;
const SENSEVOICE_MODEL = "models/sensevoice/model.int8.onnx";
const SENSEVOICE_TOKENS = "models/sensevoice/tokens.txt";
const SENSEVOICE_FRONTEND = "models/sensevoice/frontend.json";

function parseTokenTable(text) {
  const map = new Map();
  const reverse = new Map();
  let maxId = 0;
  for (const line of text.split(/\r?\n/)) {
    const idx = line.lastIndexOf(" ");
    if (idx !== -1) {
      const token = line.slice(0, idx);
      const id = Number(line.slice(idx + 1));
      if (!Number.isNaN(id)) {
        map.set(id, token);
        if (id > maxId) maxId = id;
        // Preserve leading "▁" so word-initial tokens do not collide with
        // mid-word subwords, and exclude special control tokens (<unk>/<s>/</s>/<|...|>)
        if (id > 2 && token && !token.startsWith("<|") && !reverse.has(token)) {
          reverse.set(token, id);
        }
      }
    }
  }
  const wordMask = new Uint8Array(maxId + 1);
  for (const [id, token] of map) {
    if (id > 0 && token && !token.startsWith("<|") && WORD_CHAR_RE.test(token)) {
      wordMask[id] = 1;
    }
  }
  return { map, reverse, wordMask, spaceId: reverse.get("▁") ?? -1 };
}

function parseHotwordsInput(raw) {
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : String(raw).split(/[\r\n,、]+/);
  return items.map((s) => String(s || "").trim().normalize("NFKC")).filter((s) => s.length >= 2);
}

function tokenizeHotwordVariant(chars, initialWordStart) {
  if (!asrTextToId) return null;
  const ids = [];
  let i = 0;
  let wordStart = initialWordStart;
  while (i < chars.length) {
    if (/\s/.test(chars[i])) {
      wordStart = true;
      i += 1;
      continue;
    }
    let matched = false;
    for (let len = Math.min(8, chars.length - i); len >= 1; len -= 1) {
      const sub = chars.slice(i, i + len).join("");
      const id = (wordStart ? asrTextToId.get("▁" + sub) : undefined) ?? asrTextToId.get(sub);
      if (id !== undefined) {
        ids.push(id);
        i += len;
        wordStart = false;
        matched = true;
        break;
      }
    }
    if (!matched) return null;
  }
  return ids.length ? ids : null;
}

function tokenizeHotword(word) {
  return tokenizeHotwordVariant(Array.from(word), true);
}

function buildHotwordTrie(rawHotwords) {
  const list = parseHotwordsInput(rawHotwords);
  if (!list.length || !asrTextToId) return null;
  let nextNodeId = 1;
  const makeNode = (depth) => ({
    id: depth === 0 ? 0 : nextNodeId++,
    depth,
    children: new Map(),
    fail: null,
    isEnd: false,
    bank: 0,
    hitBank: 0,
    pot: 0,
    minToEnd: Infinity
  });
  const root = makeNode(0);
  let count = 0;

  const insertSeq = (seq) => {
    let node = root;
    for (let d = 0; d < seq.length; d += 1) {
      const id = seq[d];
      let child = node.children.get(id);
      if (!child) {
        child = makeNode(d + 1);
        node.children.set(id, child);
      }
      node = child;
    }
    node.isEnd = true;
  };

  for (const word of list) {
    const chars = Array.from(word);
    const seqSpaced = tokenizeHotwordVariant(chars, true);
    const seqRaw = tokenizeHotwordVariant(chars, false);
    if (!seqSpaced && !seqRaw) continue;
    if (seqSpaced) insertSeq(seqSpaced);
    if (seqRaw && (!seqSpaced || seqRaw.length !== seqSpaced.length || seqRaw.some((v, i) => v !== seqSpaced[i]))) {
      insertSeq(seqRaw);
    }
    count += 1;
  }
  if (count === 0) return null;

  // Compute min distance from each node to its nearest deeper terminal node,
  // then assign telescoping potentials: each non-end branch carries pot in (0, 1)
  // that reaches 1 and banks on isEnd (resetting pot to 0 so extending a prefix
  // hotword never inverts potential or double-charges prior tokens).
  const computeMinToEnd = (node) => {
    let best = node.isEnd ? 0 : Infinity;
    for (const child of node.children.values()) {
      const childDist = 1 + computeMinToEnd(child);
      if (childDist < best) best = childDist;
    }
    node.minToEnd = best;
    return best;
  };
  computeMinToEnd(root);

  const assignPotentials = (node, depthSinceAnchor, hasAncestorEnd) => {
    for (const child of node.children.values()) {
      const nextSince = depthSinceAnchor + 1;
      if (child.isEnd) {
        child.bank = hasAncestorEnd ? Math.min(1.0, nextSince / child.depth) : 1.0;
        child.pot = 0;
        assignPotentials(child, 0, true);
      } else {
        const denom = nextSince + child.minToEnd;
        child.bank = 0;
        child.pot = Number.isFinite(denom) && denom > 0 ? nextSince / denom : 0;
        assignPotentials(child, nextSince, hasAncestorEnd);
      }
    }
  };
  assignPotentials(root, 0, false);

  // Build Aho-Corasick failure links so suffix-prefix overlaps transition smoothly.
  root.fail = root;
  const queue = [];
  for (const child of root.children.values()) {
    child.fail = root;
    child.hitBank = child.isEnd ? child.bank : 0;
    queue.push(child);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const u = queue[head];
    for (const [tokId, v] of u.children) {
      let f = u.fail;
      while (f !== root && !f.children.has(tokId)) {
        f = f.fail;
      }
      v.fail = f.children.get(tokId) || root;
      v.hitBank = v.isEnd ? v.bank : (v.fail.hitBank || 0);
      queue.push(v);
    }
  }

  return root;
}

function stepHotwordTrie(root, node, c, hwScale) {
  if (asrSpaceId >= 0 && c === asrSpaceId && node !== root && !node.children.has(c)) {
    return { nt: node, delta: 0 };
  }
  let cur = node;
  while (cur !== root && !cur.children.has(c)) {
    cur = cur.fail;
  }
  const nt = cur.children.get(c) || root;
  const delta = (nt.hitBank + nt.pot - node.pot) * hwScale;
  return { nt, delta };
}

async function loadAsr() {
  if (asrLoaded) return;
  const startedAt = performance.now();
  initOrtEnv();

  const [frontendResp, tokensResp] = await Promise.all([
    fetch(chrome.runtime.getURL(SENSEVOICE_FRONTEND)),
    fetch(chrome.runtime.getURL(SENSEVOICE_TOKENS))
  ]);
  if (!frontendResp.ok || !tokensResp.ok) throw new Error("Unable to load SenseVoice assets");

  asrFrontend = new SenseVoiceFrontend(await frontendResp.json());
  const parsed = parseTokenTable(await tokensResp.text());
  asrTokens = parsed.map;
  asrTextToId = parsed.reverse;
  asrIsWordToken = parsed.wordMask;
  asrSpaceId = parsed.spaceId;
  asrLangTensor = new ort.Tensor("int32", Int32Array.of(asrFrontend.language), [1]);
  asrTextNormTensor = new ort.Tensor("int32", Int32Array.of(asrFrontend.textNorm), [1]);
  asrLengthTensor = new ort.Tensor("int32", asrLengthBuf, [1]);

  asrSession = await ort.InferenceSession.create(
    chrome.runtime.getURL(SENSEVOICE_MODEL),
    { executionProviders: ["wasm"], graphOptimizationLevel: "all" }
  );
  asrLoaded = true;
  DIAG.set("asr.model", SENSEVOICE_MODEL);
  DIAG.set("asr.loadMs", Math.round(performance.now() - startedAt));
  DIAG.set("asr.inputs", asrSession.inputNames.join(","));
  DIAG.mark("asr", "session created");
}

function passesConfidenceGate(tokenCount, probSum, eventTag) {
  if (tokenCount === 0) return false;
  const meanP = probSum / tokenCount;
  if (meanP < 0.50) return false;
  if (tokenCount <= 6 && meanP < 0.60) return false;
  if ((eventTag === "<|BGM|>" || eventTag === "<|nospeech|>") && tokenCount <= 8 && meanP < 0.65) {
    return false;
  }
  return true;
}

function frameTokenProb(data, base, vocab, bestScore) {
  if (!Number.isFinite(bestScore)) return 0;
  let sum = 0;
  const cutoff = bestScore - 15;
  for (let id = 0; id < vocab; id += 1) {
    const s = data[base + id];
    if (s > cutoff) sum += Math.exp(s - bestScore);
  }
  return sum > 0 ? 1 / sum : 0;
}

function hotwordBeamIds(data, startFrame, frames, vocab, trieRoot, beamWidth = 8, topK = 8, hwScale = 2.5) {
  const NEG_INF = -1e30;
  const VOCAB_STRIDE = Math.max(65536, vocab + 1);
  const logAdd = (a, b) => (a <= NEG_INF ? b : b <= NEG_INF ? a : (a > b ? a + Math.log1p(Math.exp(b - a)) : b + Math.log1p(Math.exp(a - b))));
  const topIdx = new Int32Array(topK);
  const topRaw = new Float32Array(topK);
  const topVal = new Float32Array(topK);
  const edgeCache = new Map();
  let nextPrefixId = 1;
  const getPrefixId = (parentPrefixId, c) => {
    const k = parentPrefixId * VOCAB_STRIDE + c;
    let pid = edgeCache.get(k);
    if (pid === undefined) {
      pid = nextPrefixId++;
      edgeCache.set(k, pid);
    }
    return pid;
  };

  let beams = [{
    prefixId: 0, parent: null, token: -1,
    pb: 0, pnb: NEG_INF, total: 0,
    trie: trieRoot, lp: 0, bestExt: 0
  }];

  for (let t = startFrame; t < frames; t += 1) {
    const base = t * vocab;
    let maxL = -Infinity;
    for (let v = 0; v < vocab; v += 1) {
      const s = data[base + v];
      if (s > maxL) maxL = s;
    }
    if (!Number.isFinite(maxL)) continue;

    const cut = maxL - 15;
    const rawBlank = data[base];
    let sumExp = rawBlank > cut ? Math.exp(rawBlank - maxL) : 0;
    topIdx.fill(-1);
    topRaw.fill(-Infinity);
    for (let v = 1; v < vocab; v += 1) {
      const s = data[base + v];
      if (s > cut) sumExp += Math.exp(s - maxL);
      if (!Number.isFinite(s) || s <= topRaw[topK - 1]) continue;
      let pos = topK - 1;
      while (pos > 0 && topRaw[pos - 1] < s) {
        topRaw[pos] = topRaw[pos - 1];
        topIdx[pos] = topIdx[pos - 1];
        pos -= 1;
      }
      topRaw[pos] = s;
      topIdx[pos] = v;
    }
    if (!(sumExp > 0) || !Number.isFinite(sumExp)) continue;
    const lse = maxL + Math.log(sumExp);
    const blankLp = Number.isFinite(rawBlank) ? rawBlank - lse : NEG_INF;
    for (let i = 0; i < topK; i += 1) {
      topVal[i] = topIdx[i] >= 0 ? topRaw[i] - lse : -Infinity;
    }

    const next = new Map();
    const ensure = (prefixId, parent, token, trie, lp, extScore) => {
      let b = next.get(prefixId);
      if (!b) {
        b = { prefixId, parent, token, pb: NEG_INF, pnb: NEG_INF, total: NEG_INF, trie, lp, bestExt: extScore };
        next.set(prefixId, b);
      } else if (extScore > b.bestExt) {
        b.bestExt = extScore;
        b.parent = parent;
        b.trie = trie;
        b.lp = lp;
      }
      return b;
    };

    for (let bi = 0; bi < beams.length; bi += 1) {
      const beam = beams[bi];
      const same = ensure(beam.prefixId, beam.parent, beam.token, beam.trie, beam.lp, beam.total);
      same.pb = logAdd(same.pb, beam.total + blankLp);

      for (let i = 0; i < topK; i += 1) {
        const c = topIdx[i];
        if (c < 0) continue;
        if (c === beam.token) {
          same.pnb = logAdd(same.pnb, beam.pnb + topVal[i]);
          if (beam.pnb > NEG_INF && topVal[i] > same.lp) {
            same.lp = topVal[i];
          }
          // CTC allows repeating `c` after a blank frame (`[c, blank, c]`).
          if (beam.pb > NEG_INF) {
            const { nt, delta } = stepHotwordTrie(trieRoot, beam.trie, c, hwScale);
            const npid = getPrefixId(beam.prefixId, c);
            const score = beam.pb + topVal[i] + delta;
            const nb = ensure(npid, beam, c, nt, topVal[i], score);
            nb.pnb = logAdd(nb.pnb, score);
          }
        } else {
          const { nt, delta } = stepHotwordTrie(trieRoot, beam.trie, c, hwScale);
          const npid = getPrefixId(beam.prefixId, c);
          const score = beam.total + topVal[i] + delta;
          const nb = ensure(npid, beam, c, nt, topVal[i], score);
          nb.pnb = logAdd(nb.pnb, score);
        }
      }
    }

    const candidates = [];
    for (const b of next.values()) {
      b.total = logAdd(b.pb, b.pnb);
      candidates.push(b);
    }
    candidates.sort((a, b) => b.total - a.total);
    if (candidates.length > beamWidth) candidates.length = beamWidth;
    beams = candidates;
  }

  const best = beams[0];
  const out = [];
  for (let cur = best; cur && cur.token !== -1; cur = cur.parent) {
    out.push({ id: cur.token, p: Math.exp(cur.lp) });
  }
  return out.reverse();
}

function decodeSenseVoice(logits, options = {}) {
  if (!logits || !asrTokens) return "";
  const dims = logits.dims;
  const frames = dims[dims.length - 2];
  const vocab = dims[dims.length - 1];
  const data = logits.data;
  const prefixFrames = Math.max(0, options.prefixFrames || 0);
  const skipFrames = Math.max(0, options.skipFrames || 0);
  const startFrame = prefixFrames + skipFrames;

  let eventTag = "";
  if (frames > 2) {
    const base2 = 2 * vocab;
    let best2 = 0;
    let bestS2 = -Infinity;
    for (let id = 0; id < vocab; id += 1) {
      const s = data[base2 + id];
      if (s > bestS2) { bestS2 = s; best2 = id; }
    }
    eventTag = asrTokens.get(best2) || "";
  }

  let text = "";
  let tokenCount = 0;
  let probSum = 0;

  const countsForGate = (id, tok) => (
    asrIsWordToken && id < asrIsWordToken.length
      ? asrIsWordToken[id] === 1
      : (!tok.startsWith("<|") && WORD_CHAR_RE.test(tok))
  );

  if (options.hotwordTrie) {
    const items = hotwordBeamIds(data, startFrame, frames, vocab, options.hotwordTrie);
    for (const item of items) {
      const tok = asrTokens.get(item.id) || "";
      if (tok.startsWith("<|")) continue;
      text += tok;
      if (countsForGate(item.id, tok)) {
        probSum += item.p;
        tokenCount += 1;
      }
    }
  } else {
    // Seed CTC duplicate suppression from the last context frame before emitFrom
    // so tokens held across a split boundary are not emitted twice.
    let previous = -1;
    if (startFrame > prefixFrames && startFrame <= frames) {
      const prevBase = (startFrame - 1) * vocab;
      let prevBest = 0;
      let prevBestScore = -Infinity;
      for (let id = 0; id < vocab; id += 1) {
        const score = data[prevBase + id];
        if (score > prevBestScore) { prevBestScore = score; prevBest = id; }
      }
      previous = prevBest;
    }

    for (let frame = startFrame; frame < frames; frame += 1) {
      const base = frame * vocab;
      let best = 0;
      let bestScore = -Infinity;
      for (let id = 0; id < vocab; id += 1) {
        const score = data[base + id];
        if (score > bestScore) { bestScore = score; best = id; }
      }
      if (best !== 0 && best !== previous) {
        const tok = asrTokens.get(best) || "";
        if (!tok.startsWith("<|")) {
          if (countsForGate(best, tok)) {
            probSum += frameTokenProb(data, base, vocab, bestScore);
            tokenCount += 1;
          }
          text += tok;
        }
      }
      previous = best;
    }
  }

  const cleaned = text.replace(/▁/g, " ").replace(/<\|[^|]*\|>/g, "").trim();
  if (!cleaned) return "";
  if (!passesConfidenceGate(tokenCount, probSum, eventTag)) {
    DIAG.bump("asr.gated");
    return "";
  }
  return cleaned;
}

async function runAsr(pcm, options = {}) {
  if (!asrSession || !asrFrontend) return null;
  const features = asrFrontend.computeFeatures(pcm, options.cacheKey ?? null);
  if (!features?.frames) return null;

  if (!asrLangTensor || asrLangTensor.data[0] !== asrFrontend.language) {
    asrLangTensor = new ort.Tensor("int32", Int32Array.of(asrFrontend.language), [1]);
  }
  if (!asrTextNormTensor || asrTextNormTensor.data[0] !== asrFrontend.textNorm) {
    asrTextNormTensor = new ort.Tensor("int32", Int32Array.of(asrFrontend.textNorm), [1]);
  }
  asrLengthBuf[0] = features.frames;
  if (!asrLengthTensor) {
    asrLengthTensor = new ort.Tensor("int32", asrLengthBuf, [1]);
  }

  const feeds = {
    x: new ort.Tensor("float32", features.data, [1, features.frames, features.dim]),
    x_length: asrLengthTensor,
    language: asrLangTensor,
    text_norm: asrTextNormTensor
  };
  // Timed inside the lock, so this separates inference cost from time spent
  // queued behind the previous decode. Those are different backlog problems.
  const startedAt = performance.now();
  const result = await asrSession.run(feeds);
  const inferMs = performance.now() - startedAt;
  DIAG.sample("asr.inferMs", inferMs);
  // Window size dominates cost and moves with the scene, so a session mean is
  // only comparable to another session with the same utterance-length mix: two
  // runs on this machine differed by 51% in mean purely from speech density.
  // Bucketing makes each sample attributable, and gives the bench a row with the
  // same window to compare against.
  const windowSec = pcm.length / TARGET_SAMPLE_RATE;
  const bucket = windowSec <= 2 ? "<=2s" : windowSec <= 4 ? "<=4s" : windowSec <= 6 ? "<=6s" : "<=8s";
  DIAG.sample(`asr.inferMs ${bucket}`, inferMs);
  DIAG.set("asr.frames", features.frames);
  DIAG.set("asr.dim", features.dim);
  DIAG.bump("asr.decodes");

  const cur = options.session;
  if (cur) {
    const rtf = inferMs / Math.max(1, windowSec * 1000);
    cur.emaInferMs = cur.emaInferMs == null ? inferMs : (0.7 * cur.emaInferMs + 0.3 * inferMs);
    cur.emaRtf = cur.emaRtf == null ? rtf : (0.7 * cur.emaRtf + 0.3 * rtf);
    if (cur.emaRtf > 0.14) {
      cur.effectiveDecodeStepMs = Math.max(DECODE_STEP_MS, Math.min(1200, Math.round(cur.emaInferMs * 1.4)));
    } else {
      cur.effectiveDecodeStepMs = DECODE_STEP_MS;
    }
    if (cur.emaRtf > 0.22) {
      cur.effectiveSplitTriggerSamples = Math.round(5.5 * TARGET_SAMPLE_RATE);
      cur.effectiveMaxUtteranceSamples = Math.round(6.0 * TARGET_SAMPLE_RATE);
    } else {
      cur.effectiveSplitTriggerSamples = SPLIT_TRIGGER_SAMPLES;
      cur.effectiveMaxUtteranceSamples = MAX_UTTERANCE_SAMPLES;
    }
  }

  const totalOutFrames = result.logits.dims[result.logits.dims.length - 2];
  const prefixFrames = Math.max(0, totalOutFrames - features.frames);
  const skipFrames = options.emitOffsetSamples > 0
    ? Math.round(options.emitOffsetSamples / LFR_FRAME_SAMPLES)
    : 0;
  return decodeSenseVoice(result.logits, {
    prefixFrames,
    skipFrames,
    hotwordTrie: options.hotwordTrie || null
  });
}

function createRingBuffer(capacity) {
  return {
    data: new Int16Array(capacity),
    head: 0,
    size: 0,
    total: 0,
    append(chunk) {
      if (!chunk?.length) return;
      const cap = this.data.length;
      if (chunk.length >= cap) {
        this.data.set(chunk.subarray(chunk.length - cap));
        this.head = 0;
        this.size = cap;
        this.total += chunk.length;
        return;
      }
      const first = Math.min(chunk.length, cap - this.head);
      this.data.set(chunk.subarray(0, first), this.head);
      if (first < chunk.length) {
        this.data.set(chunk.subarray(first), 0);
      }
      this.head = (this.head + chunk.length) % cap;
      this.size = Math.min(cap, this.size + chunk.length);
      this.total += chunk.length;
    },
    read(startAbs, endAbs, outBuf) {
      const cap = this.data.length;
      const oldest = this.total - this.size;
      const start = Math.max(oldest, startAbs);
      const end = Math.min(this.total, endAbs);
      if (end <= start) return null;
      const len = end - start;
      const startOffset = (this.head - (this.total - start) + cap) % cap;
      if (outBuf) {
        const dst = outBuf.length >= len ? outBuf : new Int16Array(len);
        if (startOffset + len <= cap) {
          dst.set(this.data.subarray(startOffset, startOffset + len), 0);
        } else {
          const first = cap - startOffset;
          dst.set(this.data.subarray(startOffset), 0);
          dst.set(this.data.subarray(0, len - first), first);
        }
        return dst.subarray(0, len);
      }
      if (startOffset + len <= cap) {
        return this.data.slice(startOffset, startOffset + len);
      }
      const out = new Int16Array(len);
      const first = cap - startOffset;
      out.set(this.data.subarray(startOffset));
      out.set(this.data.subarray(0, len - first), first);
      return out;
    }
  };
}

function createSegmenter() {
  return {
    speechActive: false,
    candidateStart: -1,
    speechRun: 0,
    speechStart: 0,
    anchorStart: 0,
    lastSpeechEnd: 0,
    silenceSamples: 0
  };
}

function clampSurrogateBoundary(str, idx) {
  if (idx <= 0 || idx >= str.length) return idx;
  const code = str.charCodeAt(idx);
  const prev = str.charCodeAt(idx - 1);
  if (code >= 0xdc00 && code <= 0xdfff && prev >= 0xd800 && prev <= 0xdbff) {
    return idx - 1;
  }
  return idx;
}

function getLongestCommonPrefix(a, b) {
  if (!a || !b) return 0;
  const maxLen = Math.min(a.length, b.length);
  let i = 0;
  while (i < maxLen && a[i] === b[i]) i++;
  return clampSurrogateBoundary(a, i);
}

// Lookbehind rather than a capture group: a consuming pattern only matches
// every *other* gap in a run like `そう だ ね`, because the character after the
// first gap is eaten as group 2 and can no longer serve as the next lookbehind
// anchor. Zero-width assertions keep every gap independently matchable.
// U+30FC (ー), U+30FB (・), U+301C/FF5E (〜/～) are Script=Common, not Katakana,
// so listing them keeps words like `コーヒー を` or `ナルト ・ サスケ` free of spaces.
const JP_CHAR = "[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\u30FC\\u30FB\\u301C\\uFF5E]";
const JP_SPACE_RE = new RegExp(`(?<=${JP_CHAR})\\s+(?=${JP_CHAR})`, "gu");
// Only collapse the gap after Japanese punctuation when Japanese follows, so
// mixed text like `え？ What` keeps its space.
const JP_AFTER_PUNCT_RE = new RegExp(`([、。！？!?])\\s+(?=${JP_CHAR})`, "gu");

function normalizeTranscript(text) {
  let value = String(text || "").normalize("NFKC").trim();
  value = value.replace(/<\|[^|]*\|>/g, "");
  value = value.replace(/\s+/g, " ");
  value = value.replace(JP_SPACE_RE, "");
  value = value.replace(/\s+([、。！？!?])/g, "$1");
  value = value.replace(JP_AFTER_PUNCT_RE, "$1");
  return value.trim();
}

function isUsableTranscript(text) {
  if (!text) return false;
  if (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}0-9A-Za-z]/u.test(text)) return false;
  if (/(.)\1{6,}/u.test(text)) return false;
  return true;
}

// ─── Anchored Committer Pipeline ───────────────────────────────────
// Every ASR call is serialized through one module-global promise chain so even
// across rapid Stop -> Start transitions two ORT runs never overlap on `asrSession`.
function withAsrLock(task) {
  const run = globalAsrChain.then(task, task);
  globalAsrChain = run.then(() => {}, () => {});
  return run;
}

// One telemetry shape for every emission. `audioSamples` is the absolute ring
// position the decode actually covers (the end of speech audio, excluding right pad).
function telemetryFor(current, audioSamples, captureEpoch, asrDurationMs) {
  const droppedSeconds = (current.droppedAudioSamples || 0) / TARGET_SAMPLE_RATE;
  return {
    audioSeconds: Math.round(((audioSamples / TARGET_SAMPLE_RATE) + droppedSeconds) * 100) / 100,
    capturedAt: captureEpoch,
    streamStartEpoch: current.streamStartEpoch || null,
    asrDurationMs,
    wallClock: new Date().toLocaleTimeString()
  };
}

function clearDecodeTimer(u) {
  if (!u?.timer) return;
  clearTimeout(u.timer);
  clearInterval(u.timer);
  u.timer = null;
}

function scheduleNextTick(current, u, delayMs) {
  clearDecodeTimer(u);
  if (!u || u.closed || current.utterance !== u || u.speculativeTask ||
      session !== current || intentionalStop || current.stopping) {
    return;
  }
  u.timer = setTimeout(() => {
    u.timer = null;
    void tickAnchoredUtterance(current);
  }, Math.max(0, Math.round(delayMs)));
}

function scheduleFirstTick(current) {
  const u = current.utterance;
  const scheduledAt = performance.now();
  const readyAt = Math.max(
    u.anchorStart + MIN_UTTERANCE_SAMPLES,
    (u.emitFrom ?? u.anchorStart) + MIN_POST_SPLIT_NEW_SAMPLES
  );
  const minimum = () => readyAt - current.ring.total;

  const waitForMinimum = () => {
    if (u.closed || current.utterance !== u || session !== current || intentionalStop || current.stopping) return;
    const shortfall = minimum();
    if (shortfall > 0) {
      const waitMs = Math.max(1, Math.ceil((shortfall / TARGET_SAMPLE_RATE) * 1000));
      u.timer = setTimeout(waitForMinimum, waitMs);
      return;
    }
    DIAG.set("engine.firstTickDelayMs", Math.round(performance.now() - scheduledAt));
    void tickAnchoredUtterance(current);
  };

  u.timer = setTimeout(waitForMinimum, Math.max(0, Math.round((minimum() / TARGET_SAMPLE_RATE) * 1000)));
}

async function tickAnchoredUtterance(current) {
  const u = current.utterance;
  if (!u || u.isDecoding || u.closed || u.speculativeTask ||
      !asrLoaded || session !== current || intentionalStop || current.stopping) {
    return;
  }

  // Trailing silence well into the tail: avoid starting an interim decode that
  // would queue behind itself right when speculative finalization fires.
  if (current.segmenter.silenceSamples >= INTERIM_SILENCE_SUPPRESS_SAMPLES) {
    scheduleNextTick(current, u, 96);
    return;
  }

  u.isDecoding = true;
  const tickStart = performance.now();
  let res = null;
  try {
    res = await withAsrLock(async () => {
      if (u.closed || u.speculativeTask || session !== current || intentionalStop || current.stopping) {
        return null;
      }
      const now = current.ring.total;
      const decodeStart = u.anchorStart;
      const maxWin = current.effectiveMaxUtteranceSamples || MAX_UTTERANCE_SAMPLES;
      const windowLen = Math.min(now - decodeStart, maxWin);
      if (windowLen < MIN_UTTERANCE_SAMPLES) return null;

      if (!current.pcmScratch || current.pcmScratch.length < windowLen) {
        current.pcmScratch = new Int16Array(Math.max(windowLen, maxWin));
      }
      const oldest = current.ring.total - current.ring.size;
      const actualStart = Math.max(oldest, decodeStart);
      const actualEnd = Math.min(current.ring.total, decodeStart + windowLen);
      const pcm = current.ring.read(actualStart, actualEnd, current.pcmScratch);
      if (!pcm || pcm.length < MIN_UTTERANCE_SAMPLES) return null;

      const decodedEnd = actualStart + pcm.length;
      const emitOffsetSamples = Math.max(0, (u.emitFrom ?? decodeStart) - actualStart);
      const tAsrStart = performance.now();
      const captureEpoch = Date.now();
      const raw = await runAsr(pcm, {
        emitOffsetSamples,
        cacheKey: `${current.id}:${actualStart}:0`,
        session: current
      });
      const asrDurationMs = Math.round((performance.now() - tAsrStart) * 10) / 10;
      return {
        raw,
        decodeStart: actualStart,
        decodedEnd,
        emitOffsetSamples,
        captureEpoch,
        asrDurationMs
      };
    });
  } catch (err) {
    console.warn("[AnchoredCommitter] Decode error:", err);
  } finally {
    u.isDecoding = false;
  }

  if (res && !u.closed && session === current && !intentionalStop) {
    const text = normalizeTranscript(res.raw);
    if (!isUsableTranscript(text)) {
      if (u.hasEmittedInterim) {
        u.hasEmittedInterim = false;
        await forwardTranscript(current.tabId, {
          action: MSG.TRANSCRIPT_INTERIM,
          lineId: u.lineId,
          text: "",
          tail: "",
          isFinal: false,
          telemetry: telemetryFor(current, res.decodedEnd, res.captureEpoch, res.asrDurationMs)
        });
      }
    } else {
      u.lastCleanInterim = {
        text,
        decodeStart: res.decodeStart,
        decodedEnd: res.decodedEnd,
        emitOffsetSamples: res.emitOffsetSamples,
        captureEpoch: res.captureEpoch,
        asrDurationMs: res.asrDurationMs
      };

      const k = getLongestCommonPrefix(u.prevText, text);
      const upTo = clampSurrogateBoundary(text, Math.min(k, Math.max(0, text.length - HOLDBACK_CHARS)));
      const agreed = getLongestCommonPrefix(text, u.committed);

      let nextCommitted = u.committed;
      let action = MSG.TRANSCRIPT_INTERIM;
      if (upTo > u.committed.length) {
        nextCommitted = text.slice(0, upTo);
        action = MSG.TRANSCRIPT_GROW;
      } else if (agreed < u.committed.length) {
        nextCommitted = text.slice(0, agreed);
        action = MSG.TRANSCRIPT_REVISE;
      }

      const interimTail = text.slice(nextCommitted.length);
      const telemetry = telemetryFor(current, res.decodedEnd, res.captureEpoch, res.asrDurationMs);
      u.hasEmittedInterim = Boolean(interimTail || nextCommitted);

      if (action === MSG.TRANSCRIPT_INTERIM) {
        await forwardTranscript(current.tabId, {
          action,
          lineId: u.lineId,
          text: interimTail,
          tail: interimTail,
          isFinal: false,
          telemetry
        });
      } else {
        u.committed = nextCommitted;
        await forwardTranscript(current.tabId, {
          action,
          lineId: u.lineId,
          text: u.committed,
          tail: interimTail,
          isFinal: false,
          telemetry
        });
      }

      u.prevText = text;
    }
  }

  const elapsed = performance.now() - tickStart;
  const stepMs = current.effectiveDecodeStepMs || DECODE_STEP_MS;
  scheduleNextTick(current, u, stepMs - elapsed);
}

function emitFinalFallback(current, u, audioSamples, captureEpoch, asrDurationMs) {
  if (!u || session !== current || intentionalStop) return Promise.resolve();
  return forwardTranscript(current.tabId, {
    action: MSG.TRANSCRIPT_FINAL,
    lineId: u.lineId,
    text: u.committed || "",
    isFinal: true,
    telemetry: telemetryFor(current, audioSamples, captureEpoch, asrDurationMs)
  });
}

function prepareFinalWindowPlan(current, u, endAbs, isSplit) {
  const maxWin = current.effectiveMaxUtteranceSamples || MAX_UTTERANCE_SAMPLES;
  const end = isSplit
    ? Math.min(endAbs, u.anchorStart + maxWin, current.ring.total)
    : Math.min(endAbs + TAIL_PAD_SAMPLES, u.anchorStart + maxWin, current.ring.total);
  const telemetryEnd = isSplit ? end : Math.min(endAbs, end);
  const emitFrom = Math.max(u.emitFrom ?? u.anchorStart, current.lastFlushEnd || 0);
  if (end <= emitFrom) {
    return { empty: true, end, telemetryEnd };
  }

  // Widen short windows backwards into real preceding audio aligned to LFR stride
  // so SenseVoice receives >=1s context with exact skipFrames alignment.
  let decodeStart = u.anchorStart;
  if (end - decodeStart < MIN_UTTERANCE_SAMPLES) {
    const targetDecodeStart = Math.max(0, end - MIN_UTTERANCE_SAMPLES);
    if (emitFrom > targetDecodeStart && emitFrom <= end) {
      const backFrames = Math.ceil((emitFrom - targetDecodeStart) / LFR_FRAME_SAMPLES);
      decodeStart = Math.max(0, emitFrom - backFrames * LFR_FRAME_SAMPLES);
    } else {
      decodeStart = targetDecodeStart;
    }
  }

  const oldest = current.ring.total - current.ring.size;
  const readStart = Math.max(oldest, decodeStart);
  const availLen = Math.max(0, end - readStart);
  if (availLen === 0) {
    return { empty: true, end, telemetryEnd };
  }
  const padLeft = availLen < MIN_UTTERANCE_SAMPLES ? MIN_UTTERANCE_SAMPLES - availLen : 0;
  const actualStart = readStart;
  const emitOffsetSamples = padLeft + Math.max(0, emitFrom - actualStart);

  const adopted = (!current.hotwordTrie &&
    u.lastCleanInterim &&
    padLeft === 0 &&
    u.lastCleanInterim.decodeStart === actualStart &&
    u.lastCleanInterim.decodedEnd === end &&
    u.lastCleanInterim.emitOffsetSamples === emitOffsetSamples)
    ? u.lastCleanInterim
    : null;

  return {
    empty: false,
    end,
    telemetryEnd,
    actualStart,
    padLeft,
    emitOffsetSamples,
    adopted,
    cacheKey: `${current.id}:${actualStart}:${padLeft}`
  };
}

function decodeWindowPlan(current, plan, isCancelled) {
  if (plan.empty) {
    return Promise.resolve({ empty: true, end: plan.end, telemetryEnd: plan.telemetryEnd });
  }
  if (plan.adopted) {
    return Promise.resolve({
      empty: false,
      text: plan.adopted.text,
      end: plan.end,
      telemetryEnd: plan.telemetryEnd,
      captureEpoch: plan.adopted.captureEpoch,
      asrDurationMs: plan.adopted.asrDurationMs
    });
  }
  const captureEpoch = Date.now();
  return withAsrLock(async () => {
    if (isCancelled && isCancelled()) return null;
    if (!current.pcmScratch || current.pcmScratch.length < MIN_UTTERANCE_SAMPLES) {
      current.pcmScratch = new Int16Array(Math.max(MAX_UTTERANCE_SAMPLES, MIN_UTTERANCE_SAMPLES));
    }
    const rawLen = Math.max(0, plan.end - plan.actualStart);
    if (rawLen === 0) {
      return { empty: true, end: plan.end, telemetryEnd: plan.telemetryEnd };
    }
    let pcm;
    if (plan.padLeft > 0) {
      const padded = new Int16Array(MIN_UTTERANCE_SAMPLES);
      const rawPcm = current.ring.read(plan.actualStart, plan.end);
      if (!rawPcm || rawPcm.length === 0) {
        return { empty: true, end: plan.end, telemetryEnd: plan.telemetryEnd };
      }
      padded.set(rawPcm, MIN_UTTERANCE_SAMPLES - rawPcm.length);
      pcm = padded;
    } else {
      if (current.pcmScratch.length < rawLen) {
        current.pcmScratch = new Int16Array(rawLen);
      }
      pcm = current.ring.read(plan.actualStart, plan.end, current.pcmScratch);
      if (!pcm || pcm.length === 0) {
        return { empty: true, end: plan.end, telemetryEnd: plan.telemetryEnd };
      }
    }

    const tAsrStart = performance.now();
    const raw = await runAsr(pcm, {
      emitOffsetSamples: plan.emitOffsetSamples,
      hotwordTrie: current.hotwordTrie || null,
      cacheKey: plan.cacheKey,
      session: current
    });
    const asrDurationMs = Math.round((performance.now() - tAsrStart) * 10) / 10;
    return {
      empty: false,
      text: normalizeTranscript(raw),
      end: plan.end,
      telemetryEnd: plan.telemetryEnd,
      captureEpoch,
      asrDurationMs
    };
  });
}

function startSpeculativeFinal(current, u, endAbs) {
  if (!u || u.closed || u.speculativeTask || !asrLoaded || session !== current || intentionalStop || current.stopping) {
    return;
  }
  clearDecodeTimer(u);
  const plan = prepareFinalWindowPlan(current, u, endAbs, false);
  const mySpecEpoch = ++u.specEpoch;
  u.specTargetEnd = endAbs;
  u.speculativeTask = decodeWindowPlan(
    current,
    plan,
    () => u.specEpoch !== mySpecEpoch || session !== current || intentionalStop || current.stopping
  ).catch(() => null);
}

function flushClosedUtterance(current, u, endAbs, options = {}) {
  if (!u) return Promise.resolve();
  u.closed = true;
  clearDecodeTimer(u);

  const isSplit = Boolean(options.isSplit);
  return (async () => {
    try {
      let decoded = null;
      if (!isSplit && u.speculativeTask && u.specTargetEnd === endAbs) {
        const spec = await u.speculativeTask;
        if (spec && !spec.empty) {
          decoded = spec;
        }
      }

      if (!decoded) {
        const plan = prepareFinalWindowPlan(current, u, endAbs, isSplit);
        if (plan.empty) {
          current.lastFlushEnd = Math.max(current.lastFlushEnd || 0, plan.end);
          await emitFinalFallback(current, u, plan.telemetryEnd, Date.now(), 0);
          return;
        }
        current.lastFlushEnd = Math.max(current.lastFlushEnd || 0, plan.end);
        decoded = await decodeWindowPlan(
          current,
          plan,
          () => session !== current || intentionalStop
        );
      } else {
        current.lastFlushEnd = Math.max(current.lastFlushEnd || 0, decoded.end);
      }

      if (!decoded || session !== current || intentionalStop) return;
      if (decoded.empty) {
        await emitFinalFallback(current, u, decoded.telemetryEnd, Date.now(), 0);
        return;
      }

      const finalText = isUsableTranscript(decoded.text) ? decoded.text : u.committed;
      await forwardTranscript(current.tabId, {
        action: MSG.TRANSCRIPT_FINAL,
        lineId: u.lineId,
        text: finalText,
        isFinal: true,
        telemetry: telemetryFor(current, decoded.telemetryEnd, decoded.captureEpoch, decoded.asrDurationMs)
      });
    } catch (err) {
      console.warn("[AnchoredCommitter] Final flush error:", err);
      await emitFinalFallback(current, u, Math.min(endAbs, current.ring.total), Date.now(), 0);
    }
  })();
}

function finishUtterance(current, endAbs) {
  const u = current.utterance;
  const segmenter = current.segmenter;
  segmenter.speechActive = false;
  segmenter.candidateStart = -1;
  segmenter.speechRun = 0;
  segmenter.silenceSamples = 0;
  // Keep Silero LSTM state warm across pauses; only reset on stream start/stop.
  current.utterance = null;
  return flushClosedUtterance(current, u, endAbs, { isSplit: false });
}

function findBestSplitFrame(vadFrames, minStart, maxEnd) {
  let bestFrame = null;
  let bestScore = Infinity;
  for (let i = 0; i < vadFrames.length; i += 1) {
    const f = vadFrames[i];
    if (f.start < minStart || f.end > maxEnd) continue;
    const score = f.prob * 10 + f.rms;
    if (score < bestScore) {
      bestScore = score;
      bestFrame = f;
    }
  }
  return bestFrame;
}

function splitUtteranceAtValley(current, frameEnd) {
  const u = current.utterance;
  const segmenter = current.segmenter;
  if (!u) return;

  const maxWin = current.effectiveMaxUtteranceSamples || MAX_UTTERANCE_SAMPLES;
  const minSearch = u.emitFrom + SPLIT_SEARCH_MIN_SAMPLES;
  const maxSearch = Math.min(frameEnd - 2 * VAD_FRAME_SAMPLES, u.anchorStart + maxWin);
  const valley = findBestSplitFrame(u.vadFrames, minSearch, maxSearch);
  const splitEnd = valley
    ? valley.end
    : Math.min(frameEnd, u.anchorStart + maxWin);

  // If the chosen split point sits at or past the end of trailing speech,
  // finalize instead of opening a phantom silent segment.
  if (segmenter.silenceSamples > 0 && splitEnd >= segmenter.lastSpeechEnd) {
    current.flushTask = finishUtterance(current, Math.min(segmenter.lastSpeechEnd, u.anchorStart + maxWin));
    return;
  }

  const remainingFrames = u.vadFrames.filter((f) => f.start >= splitEnd);
  current.flushTask = flushClosedUtterance(current, u, splitEnd, { isSplit: true });

  const nextDecodeStart = Math.max(0, splitEnd - SPLIT_LEFT_CONTEXT_SAMPLES);
  segmenter.anchorStart = splitEnd;

  current.utterance = {
    lineId: Date.now() + "_" + Math.random().toString(36).slice(2, 6),
    anchorStart: nextDecodeStart,
    emitFrom: splitEnd,
    committed: "",
    prevText: "",
    lastCleanInterim: null,
    hasEmittedInterim: false,
    isDecoding: false,
    closed: false,
    timer: null,
    speculativeTask: null,
    specEpoch: 0,
    specTargetEnd: -1,
    vadFrames: remainingFrames
  };
  scheduleFirstTick(current);
}

function handleVadFrame(current, probability, rms, frameStart, frameEnd) {
  const segmenter = current.segmenter;

  if (!segmenter.speechActive) {
    if (probability >= VAD_SPEECH_THRESHOLD) {
      if (segmenter.speechRun === 0) segmenter.candidateStart = frameStart;
      segmenter.speechRun += 1;
      if (segmenter.speechRun >= VAD_SPEECH_ONSET_FRAMES) {
        segmenter.speechActive = true;
        segmenter.speechStart = segmenter.candidateStart;
        const rawAnchor = Math.max(0, segmenter.candidateStart - ANCHOR_PREROLL_SAMPLES);
        const emitFrom = Math.max(rawAnchor, current.lastFlushEnd || 0);
        // Never leak left context across an actual endpoint gap; short segments
        // widen cleanly on final flush with emitOffsetSamples masking.
        const decodeStart = emitFrom;
        segmenter.anchorStart = emitFrom;
        segmenter.lastSpeechEnd = frameEnd;
        segmenter.silenceSamples = 0;

        current.utterance = {
          lineId: Date.now() + "_" + Math.random().toString(36).slice(2, 6),
          anchorStart: decodeStart,
          emitFrom,
          committed: "",
          prevText: "",
          lastCleanInterim: null,
          hasEmittedInterim: false,
          isDecoding: false,
          closed: false,
          timer: null,
          speculativeTask: null,
          specEpoch: 0,
          specTargetEnd: -1,
          vadFrames: [{ start: frameStart, end: frameEnd, prob: probability, rms }]
        };
        scheduleFirstTick(current);
      }
    } else {
      segmenter.speechRun = 0;
      segmenter.candidateStart = -1;
    }
    return;
  }

  const u = current.utterance;
  if (u) {
    u.vadFrames.push({ start: frameStart, end: frameEnd, prob: probability, rms });
  }

  // Speech active: update end and silence
  if (probability >= VAD_CONTINUE_THRESHOLD) {
    segmenter.lastSpeechEnd = frameEnd;
    segmenter.silenceSamples = 0;
    if (u?.speculativeTask) {
      u.specEpoch += 1;
      u.speculativeTask = null;
      u.specTargetEnd = -1;
      scheduleNextTick(current, u, 150);
    }
  } else {
    segmenter.silenceSamples += VAD_FRAME_SAMPLES;
  }

  if (segmenter.silenceSamples >= END_SILENCE_SAMPLES) {
    current.flushTask = finishUtterance(current, segmenter.lastSpeechEnd);
  } else {
    const splitTrigger = current.effectiveSplitTriggerSamples || SPLIT_TRIGGER_SAMPLES;
    if (frameEnd - segmenter.anchorStart >= splitTrigger) {
      splitUtteranceAtValley(current, frameEnd);
    } else if (u && !u.speculativeTask && segmenter.silenceSamples >= SPECULATIVE_SILENCE_SAMPLES) {
      startSpeculativeFinal(current, u, segmenter.lastSpeechEnd);
    }
  }
}

// Realtime audio must not queue up faster than it is consumed. When VAD is
// slower than realtime, a serialized chain grows without bound — memory bloat
// plus steadily climbing audible lag. Past this many QUEUED chunks (~0.5 s of
// audio at the default 25 ms chunks) the OLDEST queued chunk is dropped:
// stale audio can never reduce lag by being decoded later, and keeping the
// fresh tail preserves the most recent speech for the next decode.
const PCM_MAX_QUEUE_CHUNKS = 20;

function enqueuePcm(current, arrayBuffer) {
  if (session !== current || intentionalStop || current.stopping) return;
  if (current.pcmQueue.length >= PCM_MAX_QUEUE_CHUNKS) {
    current.pcmQueue.shift();
    current.droppedAudioSamples += current.chunkSamples;
    current.pcmDropped += 1;
    if (current.pcmDropped === 1 || current.pcmDropped % 50 === 0) {
      console.warn(
        `[Backpressure] PCM queue full; dropped oldest chunk #${current.pcmDropped}. ` +
        "VAD is not keeping up with realtime capture."
      );
    }
  }
  current.pcmQueue.push(arrayBuffer);
  if (!current.pcmRunning) {
    current.pcmRunning = true;
    const drain = pcmDrain(current);
    activePcmDrain = drain;
    drain.then(async (fatalError) => {
      if (fatalError && session === current && !intentionalStop && !current.stopping) {
        await stopSession({ finalState: STATE.ERROR, silentFinalState: true });
        await reportError("AUDIO_PROCESS_ERROR", fatalError?.message || "Audio processing failed");
      }
    });
  }
}

// Single consumer: chunks leave the queue strictly one at a time, without
// awaiting stopSession inside the tracked drain promise (which would self-wait
// on activePcmDrain during error teardown).
async function pcmDrain(current) {
  let fatalError = null;
  try {
    while (current.pcmQueue.length > 0) {
      const arrayBuffer = current.pcmQueue.shift();
      await processPcmChunk(current, arrayBuffer);
    }
  } catch (error) {
    current.pcmQueue.length = 0;
    fatalError = error;
  } finally {
    current.pcmRunning = false;
  }
  return fatalError;
}

async function processPcmChunk(current, arrayBuffer) {
  if (session !== current || intentionalStop || current.stopping) return;

  if (!current.streamStartEpoch) current.streamStartEpoch = Date.now();

  const int16 = new Int16Array(arrayBuffer);
  current.ring.append(int16);
  DIAG.bump("pcm.chunks");
  DIAG.set("pcm.queueDepth", current.pcmQueue.length);

  const needed = current.vadLen + int16.length;
  if (current.vadBuf.length < needed) {
    const grown = new Int16Array(Math.max(needed, current.vadBuf.length * 2));
    grown.set(current.vadBuf.subarray(0, current.vadLen));
    current.vadBuf = grown;
  }
  current.vadBuf.set(int16, current.vadLen);
  current.vadLen = needed;

  let vadOff = 0;
  try {
    while (current.vadLen - vadOff >= VAD_FRAME_SAMPLES) {
      let sumSq = 0;
      for (let i = 0; i < VAD_FRAME_SAMPLES; i += 1) {
        const s = current.vadBuf[vadOff + i] / 32768;
        vadFloatFrame[i] = s;
        sumSq += s * s;
      }
      const rms = Math.sqrt(sumSq / VAD_FRAME_SAMPLES);
      vadOff += VAD_FRAME_SAMPLES;

      let probability;
      if (sumSq === 0) {
        current.zeroSilFrames += 1;
        if (current.zeroSilFrames > VAD_ZERO_SILENCE_HANGOVER && !current.segmenter.speechActive) {
          probability = 0;
        } else {
          probability = await runVad(vadFloatFrame);
        }
      } else {
        current.zeroSilFrames = 0;
        probability = await runVad(vadFloatFrame);
      }
      if (session !== current || intentionalStop || current.stopping) return;

      DIAG.bump(probability >= VAD_SPEECH_THRESHOLD ? "vad.speechFrames" : "vad.idleFrames");
      DIAG.set("vad.lastP", Math.round(probability * 1000) / 1000);

      const frameStart = current.vadAbs;
      current.vadAbs += VAD_FRAME_SAMPLES;
      handleVadFrame(current, probability, rms, frameStart, current.vadAbs);
    }
  } finally {
    const rem = current.vadLen - vadOff;
    if (rem > 0 && vadOff > 0) {
      current.vadBuf.copyWithin(0, vadOff, current.vadLen);
    }
    current.vadLen = rem;
  }
}

// ─── Messaging ──────────────────────────────────────────────────────
function sendMsg(msg) { return chrome.runtime.sendMessage(msg).catch(()=>{}); }
function setState(state) {
  offscreenState = state;
  DIAG.mark("offscreen", `state -> ${state}`);
  return sendMsg({type:MSG.OFFSCREEN_STATE, state});
}
function reportError(code,message) {
  DIAG.attachError(code, message);
  return sendMsg({type:MSG.OFFSCREEN_ERROR, code, message});
}

function getStatus() {
  return {
    ok: true,
    state: offscreenState,
    hasSession: Boolean(session),
    starting: pendingStarts > 0,
    tabId: session?.tabId || null,
    droppedChunks: session?.pcmDropped || 0
  };
}

async function forwardTranscript(tabId, event) {
  if (!event) return;
  DIAG.addTranscript(event);
  await sendMsg({
    type: MSG.OFFSCREEN_TRANSCRIPT,
    tabId,
    event: { ...event, ts: event.ts || Date.now() }
  });
}

// ─── Session lifecycle ──────────────────────────────────────────────
async function disposeSessionResources(cur) {
  clearDecodeTimer(cur.utterance);
  try { cur.workletNode?.port?.close(); cur.sourceNode?.disconnect();
    cur.workletNode?.disconnect(); cur.silenceNode?.disconnect(); } catch{}
  try { if(cur.audioContext?.state!=="closed") await cur.audioContext.close(); } catch{}
  for(const t of cur.displayStream?.getTracks()||[]) t.stop();
}

let startInFlight = null;
let stopInFlight = null;
let startRequestId = 0;
let pendingStarts = 0;
let sessionEpoch = 0;

async function stopSession(options = {}) {
  // Bump first, before any await or the null-session early return: this is
  // what an in-flight startSession() keys on.
  sessionEpoch += 1;
  if (stopInFlight) {
    await stopInFlight;
    return;
  }

  const runStop = (async () => {
    const finalState = options.finalState || STATE.IDLE;
    const silentFinalState = Boolean(options.silentFinalState);
    if (!session) {
      offscreenState = finalState;
      if (!silentFinalState) await setState(finalState);
      return;
    }

    const cur = session;
    cur.stopping = true;
    // Never overwrite STATE.ERROR with STATE.STOPPING on an error shutdown.
    if (finalState === STATE.IDLE) {
      await setState(STATE.STOPPING);
    }

    const bounded = (task) => Promise.race([
      task.catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, ASR_STOP_TIMEOUT_MS))
    ]);

    if (cur.flushTask) {
      await bounded(cur.flushTask);
      cur.flushTask = null;
    }

    if (finalState === STATE.IDLE && cur.segmenter?.speechActive) {
      await bounded(finishUtterance(cur, cur.ring.total));
    }

    intentionalStop = true;
    await bounded(activePcmDrain);
    await disposeSessionResources(cur);
    if (session === cur) session = null;
    await sendMsg({ type: MSG.OFFSCREEN_CLEAR_INTERIM, tabId: cur.tabId });
    offscreenState = finalState;
    if (!silentFinalState) await setState(finalState);
  })();

  stopInFlight = runStop;
  try {
    await runStop;
  } finally {
    if (stopInFlight === runStop) stopInFlight = null;
  }
}

async function startSession(tabId, config) {
  const requestId = ++startRequestId;
  pendingStarts += 1;
  sessionEpoch += 1;

  try {
    if (startInFlight) {
      await startInFlight.catch(() => {});
    }
    if (requestId !== startRequestId) return;
    if (stopInFlight) {
      await stopInFlight.catch(() => {});
    }
    if (requestId !== startRequestId) return;

    const runStart = (async () => {
      if (session) await stopSession();
      if (requestId !== startRequestId) return;

      intentionalStop = false;
      pendingConfigHotwords = config?.hotwords;
      DIAG.clearError();
      const myEpoch = sessionEpoch;
      const epochAbort = new Error("STOP_DURING_START");
      epochAbort.epochAbort = true;

      let displayStream = null, audioContext = null, workletNode = null, sourceNode = null, silenceNode = null;
      try {
        await boundedWait(activePcmDrain);
        if (sessionEpoch !== myEpoch) throw epochAbort;

        await setState(STATE.LOADING_VAD);
        initOrtEnv();
        const vadTask = withVadLock(async () => {
          await loadVad();
          resetVadState();
        });
        const asrTask = loadAsr();
        asrTask.catch(() => {});
        audioContext = new AudioContext();
        const workletTask = audioContext.audioWorklet.addModule(chrome.runtime.getURL("audio-worklet.js"));
        workletTask.catch(() => {});

        await vadTask;
        if (sessionEpoch !== myEpoch) throw epochAbort;

        if (!asrLoaded) await setState(STATE.LOADING_MODEL);
        await Promise.all([asrTask, workletTask]);
        if (sessionEpoch !== myEpoch) throw epochAbort;

        await setState(STATE.AWAITING_CAPTURE_PERMISSION);
        if (sessionEpoch !== myEpoch) throw epochAbort;

        displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: { displaySurface: "browser" },
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          selfBrowserSurface: "exclude", systemAudio: "include", surfaceSwitching: "include"
        });
        if (sessionEpoch !== myEpoch) {
          displayStream.getTracks().forEach((t) => t.stop());
          throw epochAbort;
        }

        const [audioTrack] = displayStream.getAudioTracks();
        const [videoTrack] = displayStream.getVideoTracks();
        if (/live subtitle audio worker|chrome-extension/i.test(`${videoTrack?.label} ${audioTrack?.label}`)) {
          displayStream.getTracks().forEach((t) => t.stop());
          await reportError("WRONG_CAPTURE_SOURCE", "Choose the tab you want subtitled");
          return;
        }
        // Release video capture immediately after inspecting label so the compositor stops encoding video.
        if (videoTrack) {
          videoTrack.stop();
        }
        if (!audioTrack) {
          displayStream.getTracks().forEach((t) => t.stop());
          await reportError("NO_AUDIO_TRACK", "No shared audio");
          return;
        }

        await setState(STATE.CAPTURING);
        if (sessionEpoch !== myEpoch) throw epochAbort;

        let trackEnded = audioTrack.readyState === "ended";
        const captureStream = new MediaStream([audioTrack]);
        sourceNode = audioContext.createMediaStreamSource(captureStream);
        workletNode = new AudioWorkletNode(audioContext, "pcm-capture-processor", {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
          processorOptions: {
            targetSampleRate: TARGET_SAMPLE_RATE, chunkMs: config.chunkMs || 25
          }
        });
        silenceNode = audioContext.createGain(); silenceNode.gain.value = 0;
        sourceNode.connect(workletNode); workletNode.connect(silenceNode);
        silenceNode.connect(audioContext.destination);

        const chunkSamples = Math.max(160, Math.round(TARGET_SAMPLE_RATE * (config.chunkMs || 25) / 1000));
        const activeHotwords = pendingConfigHotwords !== undefined ? pendingConfigHotwords : config?.hotwords;
        session = {
          id: nextSessionId++,
          tabId, config, displayStream, captureStream, audioContext, sourceNode, workletNode, silenceNode,
          ring: createRingBuffer(RING_BUFFER_SAMPLES),
          segmenter: createSegmenter(),
          vadBuf: new Int16Array(Math.max(VAD_FRAME_SAMPLES * 4, chunkSamples * 2)),
          vadLen: 0,
          vadAbs: 0,
          zeroSilFrames: 0,
          pcmScratch: null,
          pcmQueue: [],
          pcmRunning: false,
          pcmDropped: 0,
          droppedAudioSamples: 0,
          chunkSamples,
          streamStartEpoch: 0,
          emaInferMs: null,
          emaRtf: null,
          effectiveDecodeStepMs: DECODE_STEP_MS,
          effectiveSplitTriggerSamples: SPLIT_TRIGGER_SAMPLES,
          effectiveMaxUtteranceSamples: MAX_UTTERANCE_SAMPLES,
          hotwordTrie: buildHotwordTrie(activeHotwords),
          utterance: null,
          flushTask: null,
          lastFlushEnd: 0,
          stopping: false
        };
        const current = session;
        DIAG.set("session.chunkMs", config.chunkMs || 25);

        audioTrack.addEventListener("ended", () => {
          trackEnded = true;
          if (session === current && !intentionalStop) stopSession();
        });
        audioContext.addEventListener("statechange", () => {
          if (session === current && !intentionalStop && !current.stopping &&
              (audioContext.state === "suspended" || audioContext.state === "interrupted")) {
            DIAG.mark("audio", `context ${audioContext.state}; resuming`);
            audioContext.resume().catch((e) => console.warn("[AudioContext] resume failed:", e));
          }
        });
        workletNode.port.onmessage = (e) => {
          if (e.data?.type !== MSG.PCM_CHUNK || session !== current) return;
          enqueuePcm(current, e.data.buffer);
        };

        if (trackEnded || audioTrack.readyState === "ended") {
          await stopSession();
          return;
        }

        await setState(STATE.LISTENING);
        if (session === current && !current.stopping && current.audioContext.state === "suspended") {
          await current.audioContext.resume();
        }
      } catch (err) {
        if (!session) await disposeSessionResources({ displayStream, audioContext, workletNode, sourceNode, silenceNode });
        if (err?.epochAbort || sessionEpoch !== myEpoch) {
          return;
        }
        await stopSession({ finalState: STATE.ERROR, silentFinalState: true });
        if (err?.name === "NotAllowedError") { await reportError("CAPTURE_DENIED", "Permission denied"); return; }
        if (err?.name === "NotFoundError") { await reportError("NO_AUDIO_TRACK", "No shared audio"); return; }
        await reportError("START_FAILED", err?.message || "Unable to start");
      }
    })();

    startInFlight = runStart;
    try {
      await runStart;
    } finally {
      if (startInFlight === runStart) startInFlight = null;
    }
  } finally {
    pendingStarts -= 1;
  }
}

function boundedWait(promise) {
  return Promise.race([
    Promise.resolve(promise).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, ASR_STOP_TIMEOUT_MS))
  ]);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if(msg?.target !== "offscreen") return false;
  if(msg.type===MSG.START) { startSession(msg.tabId, msg.config); sendResponse({ok:true}); return false; }
  if(msg.type===MSG.STOP) { stopSession(); sendResponse({ok:true}); return false; }
  if(msg.type===MSG.APPLY_SETTINGS) {
    if (msg.config && "hotwords" in msg.config) {
      pendingConfigHotwords = msg.config.hotwords;
      if (session) {
        session.hotwordTrie = buildHotwordTrie(msg.config.hotwords);
      }
    }
    sendResponse({ok:true});
    return false;
  }
  if(msg.type===MSG.GET_STATUS) { sendResponse(getStatus()); return false; }
  if(msg.type===MSG.GET_DIAGNOSTICS) {
    sendResponse({ok:true, snapshot: DIAG.snapshot(), status: getStatus()});
    return false;
  }
  sendResponse({ok:false, error:"Unknown message type"}); return false;
});
