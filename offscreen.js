const { MSG, STATE } = globalThis.HIANIME;

const TARGET_SAMPLE_RATE = 16000;
const VAD_FRAME_SAMPLES = 512;
const VAD_SPEECH_THRESHOLD = 0.5;
const RING_BUFFER_SECONDS = 20;
const RING_BUFFER_SAMPLES = RING_BUFFER_SECONDS * TARGET_SAMPLE_RATE;
const PRE_ROLL_SAMPLES = Math.round(0.25 * TARGET_SAMPLE_RATE);
const END_SILENCE_SAMPLES = Math.round(0.26 * TARGET_SAMPLE_RATE);
const TAIL_PAD_SAMPLES = Math.round(0.08 * TARGET_SAMPLE_RATE);
const MIN_SPEECH_SAMPLES = Math.round(0.2 * TARGET_SAMPLE_RATE);
const MIN_DECODE_SAMPLES = Math.round(0.25 * TARGET_SAMPLE_RATE);
const MAX_UTTERANCE_SAMPLES = Math.round(6 * TARGET_SAMPLE_RATE);
const PROVISIONAL_DELAY_MS = 1200;
const ASR_WASM_THREADS = globalThis.crossOriginIsolated ? 4 : 1;

let session = null;
let intentionalStop = false;
let offscreenState = STATE.IDLE;

// ─── Silero VAD ─────────────────────────────────────────────────────
let vadSession = null, vadState = null, vadSr = null, vadLoaded = false;

async function loadVad() {
  if (vadLoaded) return;
  const wasmDir = chrome.runtime.getURL("lib/");
  ort.env.wasm.wasmPaths = wasmDir;
  ort.env.wasm.numThreads = ASR_WASM_THREADS;
  vadSession = await ort.InferenceSession.create(
    chrome.runtime.getURL("lib/silero_vad.onnx"), { executionProviders: ["wasm"] }
  );
  // This bundled Silero model uses a single recurrent `state` tensor.
  vadState = new ort.Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
  vadSr = new ort.Tensor("int64", BigInt64Array.from([BigInt(TARGET_SAMPLE_RATE)]), []);
  vadLoaded = true;
}

function resetVadState() { if (vadState) vadState.data.fill(0); }

async function runVad(float32Audio) {
  if (!vadSession) return 1.0;
  const input = new ort.Tensor("float32", float32Audio, [1, float32Audio.length]);
  const r = await vadSession.run({ input, state: vadState, sr: vadSr });
  vadState = r.stateN;
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
    const match = line.match(/^(.+) (\d+)$/);
    if (match) map.set(Number(match[2]), match[1]);
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
  if (!features.frames) return null;

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
    utteranceStart: 0,
    lastSpeechEnd: 0,
    silenceSamples: 0,
    token: 0
  };
}

const JP_CHAR = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\u30FC";
const JP_SPACE_RE = new RegExp(`(?<=[${JP_CHAR}])\\s+(?=[${JP_CHAR}])`, "gu");
const JP_AFTER_PUNCT_RE = new RegExp(`([、。！？!?])\\s+(?=[${JP_CHAR}])`, "gu");

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

function enqueueUtterance(current, pcm) {
  current.decodeQueue = current.decodeQueue
    .then(() => transcribeUtterance(current, pcm))
    .catch((error) => {
      if (session === current && !intentionalStop) {
        reportError("TRANSCRIBE_ERROR", error.message);
      }
    });
}

function clearProvisional(current) {
  if (current.partialTimer) {
    clearTimeout(current.partialTimer);
    current.partialTimer = null;
  }
}

function scheduleProvisional(current, token) {
  clearProvisional(current);
  if (current.config?.showInterim === false) return;

  current.partialTimer = setTimeout(() => {
    current.partialTimer = null;
    if (session !== current || intentionalStop || current.stopping) return;

    const segmenter = current.segmenter;
    if (!segmenter.speechActive || segmenter.token !== token) return;
    if (segmenter.lastSpeechEnd - segmenter.utteranceStart < MIN_DECODE_SAMPLES) return;

    current.decodeQueue = current.decodeQueue
      .then(() => transcribeProvisional(current, token))
      .catch((error) => {
        if (session === current && !intentionalStop) {
          reportError("TRANSCRIBE_ERROR", error.message);
        }
      });
  }, PROVISIONAL_DELAY_MS);
}

async function transcribeProvisional(current, token) {
  if (session !== current || intentionalStop || current.stopping || !asrLoaded) return;

  const segmenter = current.segmenter;
  if (!segmenter.speechActive || segmenter.token !== token) return;

  const pcm = current.ring.read(segmenter.utteranceStart, segmenter.lastSpeechEnd);
  if (!pcm || pcm.length < MIN_DECODE_SAMPLES) return;

  const text = normalizeTranscript(await runAsr(pcm));
  if (!isUsableTranscript(text)) return;
  if (session !== current || intentionalStop || !segmenter.speechActive || segmenter.token !== token) {
    return;
  }

  await forwardTranscript(current.tabId, { text, isFinal: false, ts: Date.now() });
}

function finishUtterance(current, endAbs) {
  const segmenter = current.segmenter;
  if (!segmenter.speechActive) return;
  clearProvisional(current);

  const start = segmenter.utteranceStart;
  const end = Math.min(
    endAbs,
    segmenter.lastSpeechEnd + TAIL_PAD_SAMPLES,
    current.ring.total
  );
  const speechSamples = segmenter.lastSpeechEnd - segmenter.speechStart;

  segmenter.speechActive = false;
  segmenter.candidateStart = -1;
  segmenter.speechRun = 0;
  segmenter.silenceSamples = 0;

  if (speechSamples < MIN_SPEECH_SAMPLES || end - start < MIN_DECODE_SAMPLES) return;

  const pcm = current.ring.read(start, end);
  if (!pcm || pcm.length < MIN_DECODE_SAMPLES) return;
  enqueueUtterance(current, pcm);
}

function handleVadFrame(current, probability, frameStart, frameEnd) {
  const segmenter = current.segmenter;

  if (!segmenter.speechActive) {
    if (probability >= VAD_SPEECH_THRESHOLD) {
      if (segmenter.speechRun === 0) segmenter.candidateStart = frameStart;
      segmenter.speechRun += 1;
      if (segmenter.speechRun >= 2) {
        segmenter.speechActive = true;
        segmenter.token += 1;
        segmenter.speechStart = segmenter.candidateStart;
        segmenter.utteranceStart = Math.max(0, segmenter.candidateStart - PRE_ROLL_SAMPLES);
        segmenter.lastSpeechEnd = frameEnd;
        segmenter.silenceSamples = 0;
        scheduleProvisional(current, segmenter.token);
      }
    } else {
      segmenter.speechRun = 0;
      segmenter.candidateStart = -1;
    }
    return;
  }

  if (probability >= VAD_SPEECH_THRESHOLD) {
    segmenter.lastSpeechEnd = frameEnd;
    segmenter.silenceSamples = 0;
  } else {
    segmenter.silenceSamples += VAD_FRAME_SAMPLES;
  }

  if (
    segmenter.silenceSamples >= END_SILENCE_SAMPLES ||
    frameEnd - segmenter.utteranceStart >= MAX_UTTERANCE_SAMPLES
  ) {
    finishUtterance(current, frameEnd);
  }
}

function enqueuePcm(current, arrayBuffer) {
  current.pcmQueue = current.pcmQueue
    .then(() => processPcmChunk(current, arrayBuffer))
    .catch((error) => {
      if (session === current && !intentionalStop) {
        reportError("AUDIO_PROCESS_ERROR", error.message);
      }
    });
}

async function processPcmChunk(current, arrayBuffer) {
  if (session !== current || intentionalStop || current.stopping) return;

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
    tabId: session?.tabId || null
  };
}

async function forwardTranscript(tabId, event) {
  if (!event?.text) return;
  await sendMsg({
    type: MSG.OFFSCREEN_TRANSCRIPT,
    tabId,
    event: { ...event, ts: event.ts || Date.now() }
  });
}

async function transcribeUtterance(current, pcm) {
  if (session !== current || intentionalStop) return;

  let text = null;
  if (asrLoaded) text = await runAsr(pcm);
  text = normalizeTranscript(text);
  if (!isUsableTranscript(text)) return;

  if (session !== current || intentionalStop) return;
  await forwardTranscript(current.tabId, { text, isFinal: true, ts: Date.now() });
}

// ─── Session lifecycle ──────────────────────────────────────────────
async function disposeSessionResources(cur) {
  clearProvisional(cur);
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

  if (finalState === STATE.IDLE && cur.segmenter?.speechActive) {
    finishUtterance(cur, cur.ring.total);
    await Promise.race([
      cur.decodeQueue || Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, 2000))
    ]);
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
    const sourceNode = audioContext.createMediaStreamSource(new MediaStream([audioTrack]));
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
      tabId, config, displayStream, audioContext, sourceNode, workletNode, silenceNode,
      ring: createRingBuffer(RING_BUFFER_SAMPLES),
      segmenter: createSegmenter(),
      vadPending: new Int16Array(0),
      vadAbs: 0,
      pcmQueue: Promise.resolve(),
      decodeQueue: Promise.resolve(),
      partialTimer: null,
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
