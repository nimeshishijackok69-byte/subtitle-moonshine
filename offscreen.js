const { MSG, STATE } = globalThis.HIANIME;

const GROQ_API_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const TARGET_SAMPLE_RATE = 16000;
const VAD_FRAME_SAMPLES = 512;
const VAD_SPEECH_THRESHOLD = 0.5;
const MAX_BUFFER_SECONDS = 8;
const MAX_BUFFER_SAMPLES = MAX_BUFFER_SECONDS * TARGET_SAMPLE_RATE;
const textDecoder = new TextDecoder("utf-8");

let session = null;
let intentionalStop = false;
let offscreenState = STATE.IDLE;

// ─── Silero VAD ─────────────────────────────────────────────────────
let vadSession = null, vadState = null, vadSr = null, vadLoaded = false;

async function loadVad() {
  if (vadLoaded) return;
  const wasmDir = chrome.runtime.getURL("lib/");
  ort.env.wasm.wasmPaths = wasmDir;
  ort.env.wasm.numThreads = 1;
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

// ─── Moonshine ONNX Engine ─────────────────────────────────────────
let moonEncoder = null, moonDecoder = null, moonTokenizer = null, moonLoaded = false;
const MOON_BOS = 1, MOON_EOS = 2, MOON_MAX_TOKENS = 194;

async function loadMoonshine() {
  if (moonLoaded) return;
  const wasmDir = chrome.runtime.getURL("lib/");
  ort.env.wasm.wasmPaths = wasmDir;
  ort.env.wasm.numThreads = 1;

  // Prefer the more stable WASM path inside the extension runtime.
  const providers = ["wasm"];

  const encPath = chrome.runtime.getURL("models/onnx/encoder_model_quantized.onnx");
  const decPath = chrome.runtime.getURL("models/onnx/decoder_model_merged_quantized.onnx");

  moonEncoder = await ort.InferenceSession.create(encPath, { executionProviders: providers });
  moonDecoder = await ort.InferenceSession.create(decPath, { executionProviders: providers });

  // Load tokenizer vocabulary
  const tokResp = await fetch(chrome.runtime.getURL("models/tokenizer.json"));
  const tokData = await tokResp.json();
  moonTokenizer = {};
  if (tokData.model && tokData.model.vocab) {
    // Build id->token map from vocab object
    for (const [token, id] of Object.entries(tokData.model.vocab)) {
      moonTokenizer[id] = token;
    }
  } else if (tokData.added_tokens) {
    for (const t of tokData.added_tokens) {
      moonTokenizer[t.id] = t.content;
    }
  }
  moonLoaded = true;
}

function decodeTokens(tokenIds) {
  if (!moonTokenizer) return "";
  let text = "";
  let byteBuffer = [];

  const flushByteBuffer = () => {
    if (!byteBuffer.length) return;
    text += textDecoder.decode(new Uint8Array(byteBuffer));
    byteBuffer = [];
  };

  for (const id of tokenIds) {
    if (id === MOON_BOS || id === MOON_EOS) continue;
    const tok = moonTokenizer[id] || "";
    if (!tok || tok === "<unk>" || /^<<ST_\d+>>$/.test(tok)) continue;

    const byteMatch = tok.match(/^<0x([0-9A-Fa-f]{2})>$/);
    if (byteMatch) {
      byteBuffer.push(parseInt(byteMatch[1], 16));
      continue;
    }

    flushByteBuffer();
    text += tok.replace(/▁/g, " ");
  }
  flushByteBuffer();
  return text.trimStart();
}

async function runMoonshine(float32Audio) {
  if (!moonEncoder || !moonDecoder) return null;
  try {
    // Encoder: input_values [1, audio_len], attention_mask [1, audio_len]
    const audioLen = float32Audio.length;
    const inputValues = new ort.Tensor("float32", float32Audio, [1, audioLen]);

    const encResult = await moonEncoder.run({ input_values: inputValues });
    const lastHidden = encResult.last_hidden_state || encResult.encoder_last_hidden_state
      || Object.values(encResult)[0];

    const numLayers = 8;
    const numHeads = 8;
    const headDim = 52; // hidden_size(416) / num_heads(8) = 52

    // Greedy autoregressive decoding
    const generatedIds = [MOON_BOS];

    // KV cache state - start with use_cache_branch = false
    let pastKeyValues = null;


    for (let step = 0; step < MOON_MAX_TOKENS; step++) {
      const inputIds = new ort.Tensor(
        "int64",
        BigInt64Array.from(step === 0 ? generatedIds.map(BigInt) : [BigInt(generatedIds[generatedIds.length - 1])]),
        [1, step === 0 ? generatedIds.length : 1]
      );

      const feeds = {
        input_ids: inputIds,
        encoder_hidden_states: lastHidden,
      };

      // Add use_cache_branch and past_key_values for merged decoder
      if (step > 0 && pastKeyValues) {
        feeds.use_cache_branch = new ort.Tensor("bool", new Uint8Array([1]), [1]);
        for (const [k, v] of Object.entries(pastKeyValues)) {
          feeds[k] = v;
        }
      } else {
        feeds.use_cache_branch = new ort.Tensor("bool", new Uint8Array([0]), [1]);
        // Provide empty past_key_values for first step
        for (let i = 0; i < numLayers; i++) {
          feeds[`past_key_values.${i}.decoder.key`] = new ort.Tensor("float32", new Float32Array(0), [1, numHeads, 0, headDim]);
          feeds[`past_key_values.${i}.decoder.value`] = new ort.Tensor("float32", new Float32Array(0), [1, numHeads, 0, headDim]);
          feeds[`past_key_values.${i}.encoder.key`] = new ort.Tensor("float32", new Float32Array(0), [1, numHeads, 0, headDim]);
          feeds[`past_key_values.${i}.encoder.value`] = new ort.Tensor("float32", new Float32Array(0), [1, numHeads, 0, headDim]);
        }
      }

      const decResult = await moonDecoder.run(feeds);
      const logits = decResult.logits;
      if (!logits) throw new Error("Moonshine decoder returned no logits");
      const vocabSize = logits.dims[logits.dims.length - 1];
      const lastTokenLogits = logits.data.slice(-vocabSize);

      // Greedy: argmax
      let maxIdx = 0, maxVal = lastTokenLogits[0];
      for (let i = 1; i < vocabSize; i++) {
        if (lastTokenLogits[i] > maxVal) { maxVal = lastTokenLogits[i]; maxIdx = i; }
      }

      if (maxIdx === MOON_EOS) break;
      generatedIds.push(maxIdx);

      // Keep encoder cache from the first step and only update decoder cache later.
      const nextPastKeyValues = {};
      for (let i = 0; i < numLayers; i++) {
        for (const moduleName of ["decoder", "encoder"]) {
          for (const kv of ["key", "value"]) {
            const presentKey = `present.${i}.${moduleName}.${kv}`;
            const pastKey = `past_key_values.${i}.${moduleName}.${kv}`;
            nextPastKeyValues[pastKey] = step === 0
              ? feeds[pastKey]
              : pastKeyValues?.[pastKey];
            const nextValue = decResult[presentKey];
            if (nextValue && (step === 0 || moduleName === "decoder")) {
              nextPastKeyValues[pastKey] = nextValue;
            }
          }
        }
      }
      pastKeyValues = nextPastKeyValues;
    }

    return decodeTokens(generatedIds);
  } catch (err) {
    console.error("[Moonshine] Inference error:", err);
    return null;
  }
}

// ─── Rate limit tracker ─────────────────────────────────────────────
const rateLimiter = {
  minuteRequests: [], dayRequests: [], useTurbo: false,
  recordRequest() {
    const now = Date.now();
    this.minuteRequests.push(now); this.dayRequests.push(now);
    this.cleanup();
    this.useTurbo = this.minuteRequests.length >= 17 || this.dayRequests.length >= 1800;
  },
  cleanup() {
    const now = Date.now();
    this.minuteRequests = this.minuteRequests.filter(t => t > now - 60000);
    this.dayRequests = this.dayRequests.filter(t => t > now - 86400000);
  },
  canRequest() { this.cleanup(); return this.minuteRequests.length < 20 && this.dayRequests.length < 2000; },
  getModel() { return this.useTurbo ? "whisper-large-v3-turbo" : "whisper-large-v3"; }
};

// ─── PCM to WAV ─────────────────────────────────────────────────────
function pcmToWavBlob(pcmInt16, sampleRate) {
  const n = pcmInt16.length, buf = new ArrayBuffer(44 + n*2), v = new DataView(buf);
  v.setUint32(0,0x52494646,false); v.setUint32(4,36+n*2,true); v.setUint32(8,0x57415645,false);
  v.setUint32(12,0x666d7420,false); v.setUint32(16,16,true); v.setUint16(20,1,true);
  v.setUint16(22,1,true); v.setUint32(24,sampleRate,true); v.setUint32(28,sampleRate*2,true);
  v.setUint16(32,2,true); v.setUint16(34,16,true);
  v.setUint32(36,0x64617461,false); v.setUint32(40,n*2,true);
  new Int16Array(buf,44).set(pcmInt16);
  return new Blob([buf], { type: "audio/wav" });
}

// ─── Groq REST fallback ─────────────────────────────────────────────
async function transcribeWithGroq(wavBlob, apiKey) {
  const fd = new FormData();
  fd.append("file", wavBlob, "audio.wav");
  fd.append("model", rateLimiter.getModel());
  fd.append("language", "ja");
  fd.append("response_format", "verbose_json");
  fd.append("temperature", "0");
  rateLimiter.recordRequest();
  const resp = await fetch(GROQ_API_URL, {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: fd
  });
  if (resp.status === 429) { rateLimiter.useTurbo = true; return null; }
  if (!resp.ok) throw new Error(`Groq ${resp.status}`);
  const data = await resp.json();
  // Filter hallucinations
  if (!data.segments) return data.text || "";
  return data.segments
    .filter(s => (s.no_speech_prob == null || s.no_speech_prob < 0.6))
    .map(s => (s.text||"").trim()).join("");
}

// ─── LocalAgreement ─────────────────────────────────────────────────
const agreement = {
  previousText: "",
  reset() { this.previousText = ""; },
  process(newText) {
    const normalized = (newText || "").trim();
    if (!normalized) return { committed: null, interim: null };
    if (!this.previousText) {
      this.previousText = normalized;
      return { committed: null, interim: normalized };
    }

    const previous = this.previousText;
    let i = 0;
    const maxLen = Math.min(previous.length, normalized.length);
    while (i < maxLen && previous[i] === normalized[i]) i++;

    const sameLine =
      previous.includes(normalized) ||
      normalized.includes(previous) ||
      (i >= 6 && i / Math.min(previous.length, normalized.length) >= 0.45);

    this.previousText = normalized;

    if (sameLine) {
      return { committed: null, interim: normalized };
    }

    return { committed: previous, interim: normalized };
  }
};

// ─── Adaptive window manager ────────────────────────────────────────
function createWindowManager() {
  return {
    pcmBuffer: new Int16Array(MAX_BUFFER_SAMPLES), bufferWritePos: 0,
    totalSamplesAppended: 0, lastExtractedSampleCount: 0,
    speechFrameCount: 0, totalFrameCount: 0, windowTimer: null,
    reset() { this.bufferWritePos=0; this.speechFrameCount=0; this.totalFrameCount=0;
      this.totalSamplesAppended=0; this.lastExtractedSampleCount=0;
      if(this.windowTimer){clearTimeout(this.windowTimer);this.windowTimer=null;} },
    appendPcm(chunk) {
      const rem = MAX_BUFFER_SAMPLES - this.bufferWritePos;
      if (chunk.length <= rem) { this.pcmBuffer.set(chunk, this.bufferWritePos); this.bufferWritePos += chunk.length; }
      else { const shift = chunk.length - rem; this.pcmBuffer.copyWithin(0,shift);
        this.bufferWritePos = MAX_BUFFER_SAMPLES - chunk.length;
        this.pcmBuffer.set(chunk, this.bufferWritePos); this.bufferWritePos = MAX_BUFFER_SAMPLES; }
      this.totalSamplesAppended += chunk.length;
    },
    recordSpeechFrame(s) { this.totalFrameCount++; if(s) this.speechFrameCount++; },
    getSpeechDensity() { return this.totalFrameCount ? this.speechFrameCount/this.totalFrameCount : 0; },
    getStepMs() { const d=this.getSpeechDensity(); return d>0.7?750:1000; },
    getWindowSamples() { const d=this.getSpeechDensity(); return Math.round((d>0.7?2.5:d>0.3?3.5:4)*TARGET_SAMPLE_RATE); },
    extractWindow() {
      if(!this.bufferWritePos) return null;
      if(this.totalSamplesAppended===this.lastExtractedSampleCount) return null;
      this.lastExtractedSampleCount = this.totalSamplesAppended;
      const ws = Math.min(this.getWindowSamples(), this.bufferWritePos);
      return this.pcmBuffer.slice(this.bufferWritePos - ws, this.bufferWritePos);
    }
  };
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

let lastInterimText="", lastFinalText="";
async function forwardTranscript(tabId, event) {
  if (event.isFinal) { if(event.text===lastFinalText) return; lastFinalText=event.text; lastInterimText=""; }
  else { if(event.text===lastInterimText) return; lastInterimText=event.text; }
  await sendMsg({type:MSG.OFFSCREEN_TRANSCRIPT, tabId, event});
}

// ─── Transcription loop (Hybrid: Moonshine primary, Groq fallback) ─
let transcriptionInFlight = false;
let consecutiveUncertain = 0;

async function runTranscriptionStep(current) {
  if (session!==current || intentionalStop || transcriptionInFlight) return;
  const windowPcm = current.windowManager.extractWindow();
  if (!windowPcm || windowPcm.length < TARGET_SAMPLE_RATE) return;

  transcriptionInFlight = true;
  try {
    // Convert Int16 to Float32 for Moonshine
    const float32 = new Float32Array(windowPcm.length);
    for (let i = 0; i < windowPcm.length; i++) float32[i] = windowPcm[i] / 32768.0;

    let text = null;

    // Try Moonshine local first
    if (moonLoaded) {
      text = await runMoonshine(float32);
    }

    // Check confidence — fallback to Groq if uncertain
    const isUncertain = !text || text.length < 2 || /(.)\1{4,}/.test(text);
    if (isUncertain) consecutiveUncertain++;
    else consecutiveUncertain = 0;

    const shouldFallback = isUncertain && consecutiveUncertain >= 2
      && current.config.apiKey && rateLimiter.canRequest();

    if (shouldFallback) {
      const wavBlob = pcmToWavBlob(windowPcm, TARGET_SAMPLE_RATE);
      const groqText = await transcribeWithGroq(wavBlob, current.config.apiKey);
      if (groqText && groqText.length > 0) { text = groqText; consecutiveUncertain = 0; }
    }

    if (session!==current || intentionalStop || !text) return;

    const { committed, interim } = agreement.process(text);
    if (committed) await forwardTranscript(current.tabId, {text:committed, isFinal:true, ts:Date.now()});
    if (interim) await forwardTranscript(current.tabId, {text:interim, isFinal:false, ts:Date.now()});
  } catch(err) {
    if(session===current && !intentionalStop) reportError("TRANSCRIBE_ERROR", err.message);
  } finally { transcriptionInFlight = false; }
}

function startTranscriptionLoop(current) {
  const scheduleNext = () => {
    if(session!==current || intentionalStop) return;
    current.windowManager.windowTimer = setTimeout(() => {
      runTranscriptionStep(current); scheduleNext();
    }, current.windowManager.getStepMs());
  };
  scheduleNext();
}

// ─── VAD processing ─────────────────────────────────────────────────
let vadFrameBuffer = new Float32Array(VAD_FRAME_SAMPLES), vadFramePos = 0;
function resetVadFrameBuffer() { vadFrameBuffer = new Float32Array(VAD_FRAME_SAMPLES); vadFramePos = 0; }

async function processChunkForVad(current, pcmBuf) {
  if(session!==current || intentionalStop) return;
  const int16 = new Int16Array(pcmBuf);
  for (let i = 0; i < int16.length; i++) {
    vadFrameBuffer[vadFramePos] = int16[i] / 32768.0;
    vadFramePos++;
    if (vadFramePos >= VAD_FRAME_SAMPLES) {
      const prob = await runVad(vadFrameBuffer);
      current.windowManager.recordSpeechFrame(prob >= VAD_SPEECH_THRESHOLD);
      vadFramePos = 0;
    }
  }
  current.windowManager.appendPcm(int16);
}

// ─── Session lifecycle ──────────────────────────────────────────────
async function disposeSessionResources(cur) {
  if(cur.windowManager?.windowTimer) { clearTimeout(cur.windowManager.windowTimer); cur.windowManager.windowTimer=null; }
  try { cur.workletNode?.port?.close(); cur.sourceNode?.disconnect();
    cur.workletNode?.disconnect(); cur.silenceNode?.disconnect(); } catch{}
  try { if(cur.audioContext?.state!=="closed") await cur.audioContext.close(); } catch{}
  for(const t of cur.displayStream?.getTracks()||[]) t.stop();
}

async function stopSession(options={}) {
  const finalState = options.finalState || STATE.IDLE;
  if(!session) { await setState(finalState); return; }
  intentionalStop = true; await setState(STATE.STOPPING);
  const cur = session; await disposeSessionResources(cur);
  if(session===cur) session = null;
  await sendMsg({type:MSG.OFFSCREEN_CLEAR_INTERIM, tabId:cur.tabId});
  await setState(finalState);
}

async function startSession(tabId, config) {
  if(session) await stopSession();
  intentionalStop=false; lastInterimText=""; lastFinalText="";
  transcriptionInFlight=false; consecutiveUncertain=0;
  agreement.reset(); resetVadFrameBuffer();

  let displayStream=null, audioContext=null;
  try {
    // Load VAD
    await setState(STATE.LOADING_VAD);
    await loadVad(); resetVadState();

    // Load Moonshine model
    await setState(STATE.LOADING_MODEL);
    await loadMoonshine();

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
        targetSampleRate:TARGET_SAMPLE_RATE, chunkMs:config.chunkMs||25,
        vadEnabled:config.vadEnabled!==false, vadThreshold:config.vadThreshold||0.012,
        vadHangoverMs:config.vadHangoverMs||150, vadPreRollMs:config.vadPreRollMs||120
      }
    });
    const silenceNode = audioContext.createGain(); silenceNode.gain.value = 0;
    sourceNode.connect(workletNode); workletNode.connect(silenceNode);
    silenceNode.connect(audioContext.destination);

    const windowManager = createWindowManager();
    session = { tabId, config, displayStream, audioContext, sourceNode, workletNode, silenceNode, windowManager };
    const current = session;

    audioTrack.addEventListener("ended", () => { if(session===current && !intentionalStop) stopSession(); });
    workletNode.port.onmessage = (e) => {
      if(e.data?.type!==MSG.PCM_CHUNK || session!==current) return;
      processChunkForVad(current, e.data.buffer);
    };

    startTranscriptionLoop(current);
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
