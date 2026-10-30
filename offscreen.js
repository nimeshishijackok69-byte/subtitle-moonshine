const { MSG, STATE } = globalThis.LIVE_SUBS;

const TARGET_SAMPLE_RATE = 16000;
const VAD_FRAME_SAMPLES = 512;
const VAD_CONTEXT_SAMPLES = 64; // Silero v5 reference wrapper carries 64 samples of left context
const VAD_SPEECH_THRESHOLD = 0.50; // Speech onset threshold
const VAD_CONTINUE_THRESHOLD = 0.35; // Keeps a decaying tail attached to the utterance
const VAD_SPEECH_ONSET_FRAMES = 3; // 3 consecutive frames (~96ms) to trigger onset
const END_SILENCE_SAMPLES = Math.round(0.64 * TARGET_SAMPLE_RATE); // 0.64s silence closes utterance (10,240 samples)
const ANCHOR_PREROLL_SAMPLES = Math.round(0.30 * TARGET_SAMPLE_RATE); // 0.30s anchor preroll (4,800 samples)
const TAIL_PAD_SAMPLES = Math.round(0.20 * TARGET_SAMPLE_RATE); // 0.20s tail pad (3,200 samples)
// Decode window floor. The window spans ANCHOR_PREROLL (0.3 s) + speech +
// TAIL_PAD (0.2 s), so 1.0 s of window is ~0.5 s of actual speech. A shorter
// window is widened backwards into the ring (or left-padded with silence at
// stream start) rather than dropped: `はい` / `ただ。` / `それから？` are real
// speech, and the CTC encoder needs buffer length, not speech duration.
const MIN_UTTERANCE_SAMPLES = Math.round(1.0 * TARGET_SAMPLE_RATE);
const MAX_UTTERANCE_SAMPLES = Math.round(8.0 * TARGET_SAMPLE_RATE); // 8.0s cap per utterance
const DECODE_STEP_MS = 750; // 750ms progressive anchored decode cadence
const HOLDBACK_CHARS = 4; // 4 characters holdback for local agreement
const ASR_STOP_TIMEOUT_MS = 2000; // upper bound on awaiting a decode during stop
const RING_BUFFER_SECONDS = 20;
const RING_BUFFER_SAMPLES = RING_BUFFER_SECONDS * TARGET_SAMPLE_RATE;
const ASR_WASM_THREADS = globalThis.crossOriginIsolated ? 4 : 1;

let session = null;
let intentionalStop = false;
let offscreenState = STATE.IDLE;

// ─── Silero VAD (Fixed 576-sample layout with 64-sample rolling context) ───
let vadSession = null, vadState = null, vadSr = null, vadContext = null, vadLoaded = false;

async function loadVad() {
  if (vadLoaded) return;
  const wasmDir = chrome.runtime.getURL("lib/");
  ort.env.wasm.wasmPaths = wasmDir;
  ort.env.wasm.numThreads = ASR_WASM_THREADS;
  vadSession = await ort.InferenceSession.create(
    chrome.runtime.getURL("lib/silero_vad.onnx"), { executionProviders: ["wasm"] }
  );
  resetVadState();
  vadSr = new ort.Tensor("int64", BigInt64Array.from([BigInt(TARGET_SAMPLE_RATE)]), []);
  vadLoaded = true;
}

function resetVadState() {
  vadState = new ort.Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
  vadContext = new Float32Array(VAD_CONTEXT_SAMPLES);
}

async function runVad(float32Audio) {
  if (!vadSession) return 1.0;
  const input = new Float32Array(VAD_CONTEXT_SAMPLES + float32Audio.length);
  input.set(vadContext, 0);
  input.set(float32Audio, VAD_CONTEXT_SAMPLES);
  const r = await vadSession.run({
    input: new ort.Tensor("float32", input, [1, input.length]),
    state: vadState,
    sr: vadSr
  });
  vadState = r.stateN;
  vadContext.set(float32Audio.subarray(float32Audio.length - VAD_CONTEXT_SAMPLES));
  return r.output.data[0];
}

// ─── SenseVoice ONNX Engine ────────────────────────────────────────
let asrSession = null, asrFrontend = null, asrTokens = null, asrLoaded = false;
const SENSEVOICE_MODEL = "models/sensevoice/model.int8.onnx";
const SENSEVOICE_TOKENS = "models/sensevoice/tokens.txt";
const SENSEVOICE_FRONTEND = "models/sensevoice/frontend.json";

function parseTokenTable(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const idx = line.lastIndexOf(" ");
    if (idx !== -1) {
      const token = line.slice(0, idx);
      const id = Number(line.slice(idx + 1));
      if (!Number.isNaN(id)) map.set(id, token);
    }
  }
  return map;
}

async function loadAsr() {
  if (asrLoaded) return;
  ort.env.wasm.wasmPaths = chrome.runtime.getURL("lib/");
  ort.env.wasm.numThreads = ASR_WASM_THREADS;

  const [frontendResp, tokensResp] = await Promise.all([
    fetch(chrome.runtime.getURL(SENSEVOICE_FRONTEND)),
    fetch(chrome.runtime.getURL(SENSEVOICE_TOKENS))
  ]);
  if (!frontendResp.ok || !tokensResp.ok) throw new Error("Unable to load SenseVoice assets");

  asrFrontend = new SenseVoiceFrontend(await frontendResp.json());
  asrTokens = parseTokenTable(await tokensResp.text());
  asrSession = await ort.InferenceSession.create(
    chrome.runtime.getURL(SENSEVOICE_MODEL),
    { executionProviders: ["wasm"], graphOptimizationLevel: "all" }
  );
  asrLoaded = true;
}

function decodeSenseVoice(logits) {
  if (!logits || !asrTokens) return "";
  const dims = logits.dims;
  const frames = dims[dims.length - 2];
  const vocab = dims[dims.length - 1];
  let text = "";
  let previous = -1;

  for (let frame = 0; frame < frames; frame += 1) {
    const base = frame * vocab;
    let best = 0;
    let bestScore = -Infinity;
    for (let id = 0; id < vocab; id += 1) {
      const score = logits.data[base + id];
      if (score > bestScore) { bestScore = score; best = id; }
    }
    if (best !== 0 && best !== previous) text += asrTokens.get(best) || "";
    previous = best;
  }

  return text.replace(/▁/g, " ").replace(/<\|[^|]*\|>/g, "").trim();
}

async function runAsr(pcm) {
  if (!asrSession || !asrFrontend) return null;
  const features = asrFrontend.computeFeatures(pcm);
  if (!features?.frames) return null;

  const feeds = {
    x: new ort.Tensor("float32", features.data, [1, features.frames, features.dim]),
    x_length: new ort.Tensor("int32", Int32Array.of(features.frames), [1]),
    language: new ort.Tensor("int32", Int32Array.of(asrFrontend.language), [1]),
    text_norm: new ort.Tensor("int32", Int32Array.of(asrFrontend.textNorm), [1])
  };
  const result = await asrSession.run(feeds);
  return decodeSenseVoice(result.logits);
}

function createRingBuffer(capacity) {
  return {
    data: new Int16Array(capacity),
    writePos: 0,
    total: 0,
    append(chunk) {
      if (!chunk?.length) return;
      if (chunk.length >= this.data.length) {
        this.data.set(chunk.subarray(chunk.length - this.data.length));
        this.writePos = this.data.length;
        this.total += chunk.length;
        return;
      }
      if (this.writePos + chunk.length > this.data.length) {
        const keep = this.data.length - chunk.length;
        this.data.copyWithin(0, this.writePos - keep, this.writePos);
        this.writePos = keep;
      }
      this.data.set(chunk, this.writePos);
      this.writePos += chunk.length;
      this.total += chunk.length;
    },
    read(startAbs, endAbs) {
      const oldest = this.total - this.writePos;
      const start = Math.max(oldest, startAbs);
      const end = Math.min(this.total, endAbs);
      if (end <= start) return null;
      const offset = this.writePos - (this.total - start);
      return this.data.slice(offset, offset + (end - start));
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

function getLongestCommonPrefix(a, b) {
  if (!a || !b) return 0;
  const maxLen = Math.min(a.length, b.length);
  let i = 0;
  while (i < maxLen && a[i] === b[i]) i++;
  return i;
}

// Lookbehind rather than a capture group: a consuming pattern only matches
// every *other* gap in a run like `そう だ ね`, because the character after the
// first gap is eaten as group 2 and can no longer serve as the next lookbehind
// anchor. Zero-width assertions keep every gap independently matchable.
// U+30FC (ー) is Script=Common, not Katakana, so it has to be listed or words
// like `コーヒー を` keep a stray space.
const JP_CHAR = "[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\u30FC]";
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
// Every ASR call is serialized through one promise chain per session. A
// progressive tick and the utterance-final flush can otherwise overlap on the
// same ONNX session, and the losing decode then delivers its GROW/INTERIM
// *after* FINAL, which rewrites an already-finalized line on the overlay.
function withAsrLock(current, task) {
  const run = current.asrChain.then(task, task);
  current.asrChain = run.then(() => {}, () => {});
  return run;
}

// One telemetry shape for every emission. `audioSamples` is the absolute ring
// position the decode actually covers (the end of the audio, not the start):
// the overlay can only show text once that audio has been captured, so the
// audible delay is measured against it, not against the decode start.
function telemetryFor(current, audioSamples, captureEpoch, asrDurationMs) {
  // Dropped chunks punch holes out of the ring: N accepted samples no longer
  // map to streamStartEpoch + N/rate as wall time. Charging the dropped-audio
  // duration into audioSeconds restores the mapping, so every downstream
  // latency metric (audioLagMs, soundToSubtitleMs) stays truthful. Slight
  // overstatement is possible for drops inside the decode window itself.
  const droppedSeconds = (current.droppedAudioSamples || 0) / TARGET_SAMPLE_RATE;
  return {
    audioSeconds: Math.round(((audioSamples / TARGET_SAMPLE_RATE) + droppedSeconds) * 100) / 100,
    capturedAt: captureEpoch,
    streamStartEpoch: current.streamStartEpoch || null,
    asrDurationMs,
    wallClock: new Date().toLocaleTimeString()
  };
}

async function tickAnchoredUtterance(current) {
  const u = current.utterance;
  if (!u || u.isDecoding || u.closed || !asrLoaded || session !== current || intentionalStop || current.stopping) return;

  const now = current.ring.total;
  const windowLen = Math.min(now - u.anchorStart, MAX_UTTERANCE_SAMPLES);
  if (windowLen < MIN_UTTERANCE_SAMPLES) return;

  const pcm = current.ring.read(u.anchorStart, u.anchorStart + windowLen);
  if (!pcm || pcm.length < MIN_UTTERANCE_SAMPLES) return;

  // Report the audio the decode actually covers. Once the 8 s cap is hit this
  // is behind ring.total, and using ring.total would name audio never decoded.
  const decodedEnd = u.anchorStart + windowLen;

  u.isDecoding = true;
  const tAsrStart = performance.now();
  const captureEpoch = Date.now();
  try {
    const raw = await withAsrLock(current, () => runAsr(pcm));
    const tAsrEnd = performance.now();
    const asrDurationMs = Math.round((tAsrEnd - tAsrStart) * 10) / 10;
    const text = normalizeTranscript(raw);
    if (!isUsableTranscript(text)) return;
    // A final flush claimed this utterance while we were decoding; it owns the line now.
    if (u.closed) return;

    const k = getLongestCommonPrefix(u.prevText, text);
    const upTo = Math.min(k, text.length - HOLDBACK_CHARS);
    const agreed = getLongestCommonPrefix(text, u.committed);

    // Decide the committed prefix first, then derive the tail from it. Deriving
    // the tail against the *previous* committed length would re-publish the
    // characters this tick just committed on a GROW, and drop the characters a
    // REVISE removed. Either way the row no longer reconstructs the decode.
    let nextCommitted = u.committed;
    let action = MSG.TRANSCRIPT_INTERIM;
    if (upTo > u.committed.length) {
      nextCommitted = text.slice(0, upTo);
      action = MSG.TRANSCRIPT_GROW;
    } else if (agreed < u.committed.length) {
      nextCommitted = text.slice(0, agreed);
      action = MSG.TRANSCRIPT_REVISE;
    }

    // No trim: a leading space is part of the decode, and trimming it would make
    // `text + tail` differ from the decode when a commit boundary lands on a gap.
    const interimTail = text.slice(nextCommitted.length);
    const telemetry = telemetryFor(current, decodedEnd, captureEpoch, asrDurationMs);

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
  } catch (err) {
    console.warn("[AnchoredCommitter] Decode error:", err);
  } finally {
    u.isDecoding = false;
  }
}

async function finishUtterance(current, endAbs) {
  const u = current.utterance;
  const segmenter = current.segmenter;
  segmenter.speechActive = false;
  segmenter.candidateStart = -1;
  segmenter.speechRun = 0;
  segmenter.silenceSamples = 0;
  resetVadState();

  if (u) u.closed = true;
  if (u?.timer) { clearInterval(u.timer); u.timer = null; }
  current.utterance = null;

  if (!u) return;

  const end = Math.min(
    endAbs + TAIL_PAD_SAMPLES,
    u.anchorStart + MAX_UTTERANCE_SAMPLES,
    current.ring.total
  );
  let start = u.anchorStart;

  // A short window is widened backwards into the ring so the encoder gets its
  // receptive field, instead of dropping the utterance. `read()` already clamps
  // the request to the oldest retained sample, so no separate bound is needed;
  // anything still short (stream start) is padded on the left below.
  if (end - start < MIN_UTTERANCE_SAMPLES) {
    start = end - MIN_UTTERANCE_SAMPLES;
  }

  // Never widen back past the previous flush. That audio was already decoded
  // into the previous line, and re-decoding it here would let this FINAL absorb
  // and re-print the previous sentence. The left-pad below covers the shortfall.
  if (current.lastFlushEnd) start = Math.max(start, current.lastFlushEnd);
  if (start >= end) start = end - 1;
  current.lastFlushEnd = end;

  let pcm = current.ring.read(start, end);
  if (!pcm || pcm.length === 0) return;

  // If at the start of the stream and audio is still shorter than MIN_UTTERANCE_SAMPLES,
  // pad with silence on the left to satisfy SenseVoice's receptive field.
  if (pcm.length < MIN_UTTERANCE_SAMPLES) {
    const padded = new Int16Array(MIN_UTTERANCE_SAMPLES);
    padded.set(pcm, MIN_UTTERANCE_SAMPLES - pcm.length);
    pcm = padded;
  }

  const tAsrStart = performance.now();
  const captureEpoch = Date.now();
  try {
    const raw = await withAsrLock(current, () => runAsr(pcm));
    const tAsrEnd = performance.now();
    const asrDurationMs = Math.round((tAsrEnd - tAsrStart) * 10) / 10;
    const text = normalizeTranscript(raw);

    // The stop path awaits this flush, so `intentionalStop` is still false here.
    // If it is set, the session is gone and this line must not reach the overlay.
    if (session !== current || intentionalStop) return;

    // An unusable final decode must still close the line. Emitting nothing would
    // leave the last GROW/INTERIM text on the overlay indefinitely, in a slot
    // that no later FINAL ever clears.
    const finalText = isUsableTranscript(text) ? text : u.committed;

    await forwardTranscript(current.tabId, {
      action: MSG.TRANSCRIPT_FINAL,
      lineId: u.lineId,
      text: finalText,
      isFinal: true,
      telemetry: telemetryFor(current, end, captureEpoch, asrDurationMs)
    });
  } catch (err) {
    console.warn("[AnchoredCommitter] Final flush error:", err);
  }
}

function handleVadFrame(current, probability, frameStart, frameEnd) {
  const segmenter = current.segmenter;

  if (!segmenter.speechActive) {
    if (probability >= VAD_SPEECH_THRESHOLD) {
      if (segmenter.speechRun === 0) segmenter.candidateStart = frameStart;
      segmenter.speechRun += 1;
      if (segmenter.speechRun >= VAD_SPEECH_ONSET_FRAMES) {
        segmenter.speechActive = true;
        segmenter.speechStart = segmenter.candidateStart;
        segmenter.anchorStart = Math.max(0, segmenter.candidateStart - ANCHOR_PREROLL_SAMPLES);
        segmenter.lastSpeechEnd = frameEnd;
        segmenter.silenceSamples = 0;

        current.utterance = {
          lineId: Date.now() + "_" + Math.random().toString(36).slice(2, 6),
          anchorStart: segmenter.anchorStart,
          committed: "",
          prevText: "",
          isDecoding: false,
          closed: false,
          timer: null
        };
        current.utterance.timer = setInterval(() => tickAnchoredUtterance(current), DECODE_STEP_MS);
      }
    } else {
      segmenter.speechRun = 0;
      segmenter.candidateStart = -1;
    }
    return;
  }

  // Speech active: update end and silence
  if (probability >= VAD_CONTINUE_THRESHOLD) {
    segmenter.lastSpeechEnd = frameEnd;
    segmenter.silenceSamples = 0;
  } else {
    segmenter.silenceSamples += VAD_FRAME_SAMPLES;
  }

  if (
    segmenter.silenceSamples >= END_SILENCE_SAMPLES ||
    frameEnd - segmenter.anchorStart >= MAX_UTTERANCE_SAMPLES
  ) {
    // Track the flush so a stop arriving mid-decode can await it instead of
    // racing it, and so its FINAL is not orphaned after the session is torn down.
    current.flushTask = finishUtterance(current, segmenter.lastSpeechEnd);
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
    void pcmDrain(current);
  }
}

// Single consumer: chunks leave the queue strictly one at a time, exactly like
// the promise chain this replaces. Drops only ever evict queued entries, never
// the chunk currently executing.
async function pcmDrain(current) {
  while (current.pcmQueue.length > 0) {
    const arrayBuffer = current.pcmQueue.shift();
    try {
      await processPcmChunk(current, arrayBuffer);
    } catch (error) {
      if (session === current && !intentionalStop) {
        reportError("AUDIO_PROCESS_ERROR", error.message);
      }
    }
  }
  current.pcmRunning = false;
}

async function processPcmChunk(current, arrayBuffer) {
  if (session !== current || intentionalStop || current.stopping) return;

  if (!current.streamStartEpoch) current.streamStartEpoch = Date.now();

  const int16 = new Int16Array(arrayBuffer);
  current.ring.append(int16);

  if (current.vadPending.length) {
    const merged = new Int16Array(current.vadPending.length + int16.length);
    merged.set(current.vadPending);
    merged.set(int16, current.vadPending.length);
    current.vadPending = merged;
  } else {
    current.vadPending = int16;
  }

  while (current.vadPending.length >= VAD_FRAME_SAMPLES) {
    const frame = current.vadPending.slice(0, VAD_FRAME_SAMPLES);
    current.vadPending = current.vadPending.slice(VAD_FRAME_SAMPLES);

    const float32 = new Float32Array(VAD_FRAME_SAMPLES);
    for (let i = 0; i < VAD_FRAME_SAMPLES; i += 1) float32[i] = frame[i] / 32768;

    const probability = await runVad(float32);
    if (session !== current || intentionalStop || current.stopping) return;

    const frameStart = current.vadAbs;
    current.vadAbs += VAD_FRAME_SAMPLES;
    handleVadFrame(current, probability, frameStart, current.vadAbs);
  }
}

// ─── Messaging ──────────────────────────────────────────────────────
function sendMsg(msg) { return chrome.runtime.sendMessage(msg).catch(()=>{}); }
function setState(state) {
  offscreenState = state;
  return sendMsg({type:MSG.OFFSCREEN_STATE, state});
}
function reportError(code,message) { return sendMsg({type:MSG.OFFSCREEN_ERROR, code, message}); }

function getStatus() {
  return {
    ok: true,
    state: offscreenState,
    hasSession: Boolean(session),
    tabId: session?.tabId || null,
    droppedChunks: session?.pcmDropped || 0
  };
}

async function forwardTranscript(tabId, event) {
  if (!event) return;
  await sendMsg({
    type: MSG.OFFSCREEN_TRANSCRIPT,
    tabId,
    event: { ...event, ts: event.ts || Date.now() }
  });
}

// ─── Session lifecycle ──────────────────────────────────────────────
async function disposeSessionResources(cur) {
  if (cur.utterance?.timer) { clearInterval(cur.utterance.timer); cur.utterance.timer = null; }
  try { cur.workletNode?.port?.close(); cur.sourceNode?.disconnect();
    cur.workletNode?.disconnect(); cur.silenceNode?.disconnect(); } catch{}
  try { if(cur.audioContext?.state!=="closed") await cur.audioContext.close(); } catch{}
  for(const t of cur.displayStream?.getTracks()||[]) t.stop();
}

async function stopSession(options={}) {
  const finalState = options.finalState || STATE.IDLE;
  if(!session) { await setState(finalState); return; }

  const cur = session;
  cur.stopping = true;
  await setState(STATE.STOPPING);

  // A decode must never be able to wedge teardown: a stalled ONNX call would
  // otherwise leave `session` non-null and every later START blocked behind it.
  const bounded = (task) => Promise.race([
    task.catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, ASR_STOP_TIMEOUT_MS))
  ]);

  // A silence-triggered flush may already be decoding. Await it so its FINAL is
  // not orphaned, then flush anything still open.
  if (cur.flushTask) {
    await bounded(cur.flushTask);
    cur.flushTask = null;
  }

  // Authoritative flush of active utterance on stop
  if (finalState === STATE.IDLE && cur.segmenter?.speechActive) {
    await bounded(finishUtterance(cur, cur.ring.total));
  }

  intentionalStop = true;
  await disposeSessionResources(cur);
  if(session===cur) session = null;
  await sendMsg({type:MSG.OFFSCREEN_CLEAR_INTERIM, tabId:cur.tabId});
  await setState(finalState);
}

async function startSession(tabId, config) {
  if(session) await stopSession();
  intentionalStop=false;

  let displayStream=null, audioContext=null;
  try {
    // Load VAD
    await setState(STATE.LOADING_VAD);
    await loadVad(); resetVadState();

    // Load SenseVoice model
    await setState(STATE.LOADING_MODEL);
    await loadAsr();

    await setState(STATE.AWAITING_CAPTURE_PERMISSION);
    await sendMsg({type:MSG.OFFSCREEN_CLEAR_ALL, tabId});

    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "browser" },
      audio: { echoCancellation:false, noiseSuppression:false, autoGainControl:false },
      selfBrowserSurface:"exclude", systemAudio:"include", surfaceSwitching:"include"
    });

    const [audioTrack] = displayStream.getAudioTracks();
    const [videoTrack] = displayStream.getVideoTracks();
    if(/live subtitle audio worker|chrome-extension/i.test(`${videoTrack?.label} ${audioTrack?.label}`)) {
      displayStream.getTracks().forEach(t=>t.stop());
      await reportError("WRONG_CAPTURE_SOURCE","Choose the anime tab"); await setState(STATE.IDLE); return;
    }
    if(!audioTrack) { displayStream.getTracks().forEach(t=>t.stop());
      await reportError("NO_AUDIO_TRACK","No shared audio"); await setState(STATE.IDLE); return; }

    await setState(STATE.CAPTURING);
    audioContext = new AudioContext();
    await audioContext.audioWorklet.addModule(chrome.runtime.getURL("audio-worklet.js"));
    const captureStream = new MediaStream([audioTrack]);
    const sourceNode = audioContext.createMediaStreamSource(captureStream);
    const workletNode = new AudioWorkletNode(audioContext, "pcm-capture-processor", {
      numberOfInputs:1, numberOfOutputs:1, outputChannelCount:[1],
      processorOptions: {
        targetSampleRate:TARGET_SAMPLE_RATE, chunkMs:config.chunkMs||25
      }
    });
    const silenceNode = audioContext.createGain(); silenceNode.gain.value = 0;
    sourceNode.connect(workletNode); workletNode.connect(silenceNode);
    silenceNode.connect(audioContext.destination);

    session = {
      tabId, config, displayStream, captureStream, audioContext, sourceNode, workletNode, silenceNode,
      ring: createRingBuffer(RING_BUFFER_SAMPLES),
      segmenter: createSegmenter(),
      vadPending: new Int16Array(0),
      vadAbs: 0,
      // Chunk pipeline: array-backed queue drained strictly serially by
      // pcmDrain(). chunkSamples mirrors the worklet's per-chunk size at
      // TARGET_SAMPLE_RATE, so a dropped chunk can charge its wall-clock
      // duration into droppedAudioSamples for the telemetry mapping.
      pcmQueue: [],
      pcmRunning: false,
      pcmDropped: 0,
      droppedAudioSamples: 0,
      chunkSamples: Math.max(160, Math.round(TARGET_SAMPLE_RATE * (config.chunkMs || 25) / 1000)),
      // Epoch of the first captured PCM chunk. Audio position 0 of the ring
      // buffer maps to this wall-clock instant. Chunk drops punch straight-
      // time holes into the ring, so telemetryFor charges dropped-audio time
      // into audioSeconds — keeping (streamStartEpoch + audioSeconds*1000)
      // equal to the wall clock of the sound being decoded, and every
      // downstream latency metric truthful even under overload.
      streamStartEpoch: 0,
      asrChain: Promise.resolve(),
      utterance: null,
      flushTask: null,
      lastFlushEnd: 0,
      stopping: false
    };
    const current = session;

    audioTrack.addEventListener("ended", () => { if(session===current && !intentionalStop) stopSession(); });
    workletNode.port.onmessage = (e) => {
      if(e.data?.type!==MSG.PCM_CHUNK || session!==current) return;
      enqueuePcm(current, e.data.buffer);
    };

    await setState(STATE.LISTENING);
    if(current.audioContext.state==="suspended") await current.audioContext.resume();
  } catch(err) {
    if(!session) await disposeSessionResources({displayStream, audioContext});
    await stopSession();
    if(err?.name==="NotAllowedError") { await reportError("CAPTURE_DENIED","Permission denied"); return; }
    if(err?.name==="NotFoundError") { await reportError("NO_AUDIO_TRACK","No shared audio"); return; }
    await reportError("START_FAILED", err?.message || "Unable to start");
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if(msg?.target !== "offscreen") return false;
  if(msg.type===MSG.START) { startSession(msg.tabId, msg.config); sendResponse({ok:true}); return false; }
  if(msg.type===MSG.STOP) { stopSession(); sendResponse({ok:true}); return false; }
  if(msg.type===MSG.GET_STATUS) { sendResponse(getStatus()); return false; }
  sendResponse({ok:false, error:"Unknown message type"}); return false;
});
