# Rewrite offscreen.js: Groq Whisper + Silero VAD + LocalAgreement

Replace the current Deepgram WebSocket streaming architecture with a fully free, Groq-based batch transcription pipeline with neural VAD gating and LocalAgreement progressive text display.

## Constraints Driving Every Decision

| Constraint | Value | Impact |
|---|---|---|
| Budget | $0 | Groq free tier only, no Deepgram |
| Groq RPM | 20 req/min | Must VAD-gate aggressively, adaptive step sizing |
| Groq RPD | 2,000 req/day | ~5 episodes/day budget (~400 req/episode) |
| Groq audio/hr | 7,200 seconds | Fine with our window sizes |
| Episodes/day | 4-5 | ~96-120 min, ~40% speech = ~38-48 min actual speech |
| Accuracy | Top priority | whisper-large-v3 primary, turbo fallback |
| Yomitan compat | Required | Overlay must stay as plain DOM text (no changes to contentScript.js rendering) |

### Rate Limit Math (5 episodes, VAD-gated)

```
120 min anime × 0.40 speech ratio = 48 min of speech = 2,880s
Adaptive step avg 3s → 2,880/3 = 960 requests/day     ✅ under 2,000 RPD
Spread over 120 min → 960/120 = 8 req/min              ✅ under 20 RPM
Audio per request avg 5s → 960×5 = 4,800s               ✅ under 7,200s/hr
```

---

## Proposed Changes

### Constants & Shared Protocol

#### [MODIFY] [constants.js](file:///c:/Users/Acer/Downloads/hianime-main/constants.js)

- Add new `MSG` types: `VAD_READY`, `GROQ_TRANSCRIPT`
- Add new `STATE` values: `LOADING_VAD` (shown while Silero ONNX model loads on first start)
- Remove Deepgram-specific message types are NOT removed — they stay for now as the overlay protocol (`DG_TRANSCRIPT`, etc.) is used by the content script and service worker. We just reuse them from the Groq side. This minimizes changes.

---

### Manifest & Assets

#### [MODIFY] [manifest.json](file:///c:/Users/Acer/Downloads/hianime-main/manifest.json)

- Update CSP to allow `wasm-unsafe-eval` (required for ONNX Runtime WASM execution)
- Add `https://api.groq.com` to `connect-src` (for Groq REST API calls)
- Remove `wss://api.deepgram.com` and `https://api.deepgram.com` from CSP (no longer needed)
- Add ONNX model and WASM files to `web_accessible_resources`

#### [NEW] Silero VAD ONNX model + ONNX Runtime WASM files

We need to bundle these locally (MV3 forbids remote code loading):

| File | Source | Size |
|---|---|---|
| `silero_vad.onnx` | [Silero GitHub releases](https://github.com/snakers4/silero-vad) | ~2MB |
| `ort.min.js` | onnxruntime-web npm package | ~60KB |
| `ort-wasm-simd.wasm` | onnxruntime-web npm package | ~3MB |
| `ort-wasm.wasm` | onnxruntime-web npm package (fallback) | ~2.5MB |

These go in a `lib/` directory inside the extension.

---

### The Core Rewrite

#### [MODIFY] [offscreen.js](file:///c:/Users/Acer/Downloads/hianime-main/offscreen.js)

This is the biggest change. The entire Deepgram WebSocket logic is replaced with:

**1. Silero VAD Engine**
- Load Silero ONNX model on first session start (one-time ~1-2s load, then cached)
- Process PCM chunks through VAD to get speech probability per frame
- Maintain VAD state (hidden state h, c tensors) across frames
- Gate: only accumulate audio when speech probability > 0.5
- Track speech density (% of recent frames with speech) for adaptive windowing

**2. Rolling Audio Buffer**
- Accumulate PCM audio during speech segments into a rolling buffer
- Maximum buffer size: 8 seconds (128,000 samples at 16kHz)
- Buffer tracks: raw PCM data, timestamps, total speech duration

**3. Adaptive Window Manager**
- Based on speech density over last 10 seconds:
  - High density (>70%): step = 2s, window = 4s (rapid dialogue)
  - Medium density (30-70%): step = 3s, window = 5s (normal)
  - Low density (<30%): step = 4s, window = 6s (sparse speech)
- Timer fires at each step interval, takes the current window from the buffer, sends to Groq

**4. Groq REST Transcription**
- Convert PCM window to WAV blob (add 44-byte WAV header to raw PCM)
- POST to `https://api.groq.com/openai/v1/audio/transcriptions`
- Parameters: `model=whisper-large-v3`, `language=ja`, `response_format=verbose_json`, `temperature=0`
- Parse response: extract `segments[].text`, filter by `no_speech_prob < 0.6` and `avg_logprob > -1.0`
- On 429 (rate limited): auto-fallback to `whisper-large-v3-turbo`, retry

**5. Rate Limit Tracker**
- Count requests per minute and per day (stored in memory)
- When approaching limits (>16 RPM or >1800 RPD): auto-switch to turbo model
- When over limits: pause transcription, resume when window resets
- Display rate limit status in state updates to popup

**6. LocalAgreement Algorithm**
- Keep last 2 transcription results (from overlapping windows)
- Find the longest common prefix between consecutive results
- Committed text = longest common prefix (confirmed by two windows)
- Uncommitted text = remainder of latest result (shown as interim)
- On each new result:
  1. Compare with previous result
  2. Any newly confirmed prefix → emit as `isFinal: true`
  3. Remaining unconfirmed tail → emit as `isFinal: false` (interim)

**7. Hallucination Filter**
- Discard segments where `no_speech_prob > 0.6`
- Discard segments with repeated phrases (detect 3+ consecutive identical tokens)
- Discard segments where text is common hallucination patterns (e.g., empty, "ご視聴ありがとうございました", "チャンネル登録")

#### Connection to existing pipeline

The output of the LocalAgreement engine emits events in the SAME format as the current Deepgram handler:
```javascript
{ text: "...", isFinal: true/false, ts: Date.now() }
```

This means `forwardTranscript()` → `service_worker.js` → `contentScript.js` are **unchanged**. The content script keeps rendering finals and interims exactly as before.

---

### Audio Worklet

#### [MODIFY] [audio-worklet.js](file:///c:/Users/Acer/Downloads/hianime-main/audio-worklet.js)

Minimal changes:
- **Keep** all existing PCM processing (mono downmix, low-pass, resample, Int16 conversion)
- **Keep** the existing energy-based VAD as a **first-pass quick gate** — chunks below the energy threshold are still dropped before they even reach Silero VAD. This is a two-tier gating:
  - Tier 1 (worklet, ~0 cost): energy-based, kills obvious silence
  - Tier 2 (offscreen, ~5ms): Silero neural VAD, kills music/SFX that has energy but no speech
- **Remove** nothing. The worklet stays lean.

---

### Popup UI

#### [MODIFY] [popup.js](file:///c:/Users/Acer/Downloads/hianime-main/popup.js)

- Replace "Deepgram API Key" input with "Groq API Key" input
- Storage key changes: `deepgramApiKey` → `groqApiKey`
- Model config changes: `model: "nova-3"` → `model: "whisper-large-v3"`
- Add display for current rate limit usage (req/min, req/day) — informational only
- Status text updates for new states (`LOADING_VAD`, etc.)

#### [MODIFY] [popup.html](file:///c:/Users/Acer/Downloads/hianime-main/popup.html)

- Change "Deepgram API Key" label → "Groq API Key"
- Add small rate limit indicator area (text only, no fancy UI — "making it work first")

---

### Offscreen HTML

#### [MODIFY] [offscreen.html](file:///c:/Users/Acer/Downloads/hianime-main/offscreen.html)

- Add `<script src="lib/ort.min.js"></script>` before `offscreen.js` to load ONNX Runtime

---

### Files NOT Changed

| File | Why |
|---|---|
| `contentScript.js` | Output format is identical — it still receives `DG_TRANSCRIPT` with `{text, isFinal}` |
| `service_worker.js` | Relay logic is unchanged — it forwards transcripts from offscreen to content script |
| `popup.css` | No new UI elements that need styling beyond existing patterns |

---

## User Review Required

> [!IMPORTANT]
> **You'll need a Groq API key** (free). Get one at [console.groq.com](https://console.groq.com). This replaces the Deepgram key in the popup.

> [!WARNING]
> **First-start cold load**: Silero VAD ONNX model (~2MB) + WASM runtime (~3MB) need to load on first session start. Subsequent starts are faster (browser caches WASM compilation). Expect ~1-2s initial load time shown as "Loading VAD..." state.

> [!IMPORTANT]
> **Latency expectation**: Confirmed text appears ~3-5s after speech due to window accumulation + inference + agreement confirmation. Speculative interim text appears ~2-3s after speech. This is slower than Deepgram's streaming but significantly more accurate for anime audio, and it's free.

## Open Questions

> [!IMPORTANT]
> **ONNX Runtime bundle size**: The extension will grow by ~5-6MB (ONNX Runtime WASM + Silero model). Is this acceptable for you? It's a one-time download when installing the extension.

---

## Verification Plan

### Automated Tests
- Load the extension in Chrome, verify Silero ONNX model loads without CSP errors
- Verify Groq API call succeeds with a test WAV blob
- Verify LocalAgreement produces stable committed text (no flickering)
- Monitor Chrome DevTools Network tab: confirm requests stay under 20 RPM
- Run for full 24-min episode: verify RPD stays within budget

### Manual Verification
- Watch an anime episode with the extension active
- Confirm subtitles appear within ~3-5s of dialogue
- Confirm no hallucinated text during BGM-only / silence sections
- Confirm Yomitan can read the overlay text (no regression)
- Confirm rate limit auto-degradation works (turbo fallback when limits approach)
