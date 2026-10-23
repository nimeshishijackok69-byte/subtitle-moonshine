# HiAnime - Live Japanese Subtitles

A Chrome Manifest V3 extension that captures audio from a user-selected tab, runs local Japanese speech recognition, and renders selectable subtitles over the page.

There is no API key, no server, and no cloud speech service. Audio stays on the machine. The only external dependency used at runtime is the bundled SenseVoice ONNX model plus Silero VAD and ONNX Runtime WebAssembly.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Chrome Extension                            │
│                                                                     │
│  ┌──────────────┐    ┌──────────────────┐    ┌───────────────────┐  │
│  │ popup.html   │◄──►│ service_worker   │◄──►│ offscreen.html    │  │
│  │ controls     │    │ orchestrator     │    │ capture + ASR     │  │
│  └──────────────┘    └────────┬─────────┘    └─────────┬─────────┘  │
│                               │                        │            │
│                               ▼                        ▼            │
│                    ┌──────────────────┐    ┌───────────────────┐   │
│                    │ contentScript    │    │ audio-worklet.js  │   │
│                    │ subtitle overlay │    │ PCM conversion    │   │
│                    └──────────────────┘    └───────────────────┘   │
│                                                        │            │
│                                              ┌─────────▼─────────┐  │
│                                              │ SenseVoice ONNX   │  │
│                                              │ Silero VAD ONNX   │  │
│                                              │ ORT WebAssembly   │  │
│                                              └───────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### Files

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest: permissions, service worker, CSP, COI headers |
| `service_worker.js` | Control plane: offscreen lifecycle, tab injection, message relay, reinjection |
| `popup.html` / `popup.js` / `popup.css` | Popup UI, overlay settings, Start/Stop, status |
| `offscreen.html` | Offscreen document shell |
| `offscreen.js` | Capture, ring buffer, Silero VAD segmentation, SenseVoice inference, transcript events |
| `audio-worklet.js` | Downmix, low-pass filter, resample to 16 kHz, Int16 PCM chunks |
| `sensevoice-frontend.js` | JS Kaldi-style fbank + LFR + CMVN frontend for SenseVoice |
| `contentScript.js` | In-page selectable subtitle overlay, drag/close controls |
| `models/sensevoice/` | SenseVoice int8 model, tokens, CMVN/language config, license note |
| `lib/` | ONNX Runtime WebAssembly, Silero VAD model |

Legacy Moonshine files under `models/onnx/` and `models/tokenizer*` are no longer used by the runtime.

## How It Works

### 1. Start

1. The popup sends `START_SESSION` with the active tab id and overlay settings.
2. The service worker clears the overlay, applies settings, creates the offscreen document, and sends `START`.
3. The offscreen document loads Silero VAD, then loads SenseVoice.
4. The user selects the tab to share through Chrome's picker.
5. Once audio is available, the worklet emits 16 kHz mono Int16 chunks and the session moves to `listening`.

### 2. Audio Pipeline

```
Captured tab audio
  → MediaStreamAudioSourceNode
  → AudioWorkletNode ("pcm-capture-processor")
  → silent GainNode
  → AudioContext.destination
```

`audio-worklet.js`:

- averages all input channels to mono
- applies a 7.2 kHz low-pass filter
- resamples to 16 kHz with streaming linear interpolation
- converts Float32 to signed Int16
- emits 25 ms PCM chunks (configurable through `chunkMs`)

The worklet does not perform VAD. All gating and segmentation happens in `offscreen.js`.

### 3. VAD Segmentation

`offscreen.js` keeps a 20-second PCM ring buffer. Silero VAD runs on 512-sample frames (32 ms at 16 kHz).

Current segmentation settings:

| Setting | Value |
|---------|-------|
| Speech threshold | `0.5` |
| Speech start confirmation | 2 consecutive frames |
| Pre-roll before speech | 250 ms |
| End-silence boundary | 260 ms |
| Tail padding | 80 ms |
| Minimum speech | 200 ms |
| Minimum audio to decode | 250 ms |
| Maximum utterance | 6 s |

A 6-second cap keeps subtitle lines short and bounds final-decode latency. If speech continues past the cap, the next speech run starts a new utterance.

### 4. SenseVoice Inference

Each finished utterance is decoded once:

1. `sensevoice-frontend.js` computes 80-bin fbank features at 16 kHz, applies LFR (window 7, shift 6), then CMVN.
2. The resulting `[1, frames, 560]` float32 tensor is fed to `model.int8.onnx` with:
   - `x_length`
   - `language = 11` (`ja`)
   - `text_norm = 14` (with inverse text normalization)
3. Greedy CTC decoding collapses repeated tokens and drops blank id 0.
4. Tokens are joined, `▁` becomes a space, and SenseVoice language/emotion/event tags are removed.
5. Japanese inter-character spaces and spaces around Japanese punctuation are removed by `normalizeTranscript()`.

The model and frontend were checked against the SenseVoice reference feature dump. Measured in an Edge extension page on this machine:

| Input | Inference time |
|-------|----------------|
| 2.0 s | ~247 ms |
| 7.2 s | ~541 ms |

The extension uses 4 ORT WASM threads when `crossOriginIsolated` is true, otherwise 1. The 4-thread path depends on the COI headers in `manifest.json`.

### 5. Interim and Final Subtitles

- A provisional decode is scheduled 1.2 seconds after speech starts.
- It sends one `isFinal: false` event per utterance, and only if **Show interim line** is enabled.
- When the utterance ends, the provisional timer is cancelled and the final decode is queued.
- Final text is sent as `isFinal: true` and committed to the overlay history.
- Identical consecutive final lines are allowed; there is no global duplicate suppression.

### 6. Overlay

`contentScript.js` renders ordinary DOM text so Yomitan and similar tools can inspect it.

- default 3 final lines
- font size 20-48 px
- background opacity 15-75%
- optional interim line
- draggable and removable
- settings stored in `chrome.storage.local` under `overlay.*`
- re-injected after tab navigation/reload while a session is active

The overlay uses reused nodes and updates `textContent` in place instead of rebuilding the whole DOM on every transcript event.

## Setup

### Requirements

- Chrome/Edge 116+
- Git LFS for the SenseVoice model

### Clone

```powershell
git lfs install
git clone https://github.com/nimeshishijackok69-byte/subtitle-moonshine.git
cd subtitle-moonshine
git lfs pull
```

`models/sensevoice/model.int8.onnx` is approximately 239 MB and is stored with Git LFS. If it is only a small pointer file, run `git lfs pull`.

### Load the extension

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository folder.
5. Open the popup, choose overlay settings, and click **Start**.
6. In the share picker, select the tab playing Japanese audio and enable **Share audio**.

No Deepgram or Groq API key is needed. There is no key field in the popup.

## Runtime States

```
idle
  → creating_offscreen
  → loading_vad
  → loading_model
  → awaiting_capture_permission
  → capturing
  → listening
  → stopping
  → idle

any active state → error
```

The popup displays the current state. The service worker closes the offscreen document when the session reaches `idle` or `error`.

## Message Types

### Popup → Service Worker

| Type | Payload | Description |
|------|---------|-------------|
| `GET_STATUS` | - | Return current state and tab id |
| `ENSURE_OFFSCREEN` | - | Query/prepare the offscreen document |
| `START_SESSION` | `{ tabId, config }` | Start capture and transcription |
| `STOP_SESSION` | - | Stop the active session |
| `APPLY_SETTINGS` | `{ tabId, config }` | Update overlay settings |

### Service Worker → Offscreen

| Type | Payload | Description |
|------|---------|-------------|
| `START` | `{ tabId, config }` | Load models and begin capture |
| `STOP` | - | Stop capture, flush the active utterance, clean up |

### Offscreen → Service Worker

| Type | Payload | Description |
|------|---------|-------------|
| `OFFSCREEN_STATE` | `{ state }` | Session state update |
| `OFFSCREEN_ERROR` | `{ code, message }` | User-facing error |
| `OFFSCREEN_TRANSCRIPT` | `{ tabId, event }` | Interim or final transcript |
| `OFFSCREEN_CLEAR_INTERIM` | `{ tabId }` | Clear the interim line |
| `OFFSCREEN_CLEAR_ALL` | `{ tabId }` | Clear all subtitle lines |

### Service Worker → Content Script

| Type | Payload | Description |
|------|---------|-------------|
| `APPLY_SETTINGS` | `{ config }` | Update overlay appearance |
| `DG_TRANSCRIPT` | `{ isFinal, text, ts }` | Display transcript text |
| `CLEAR_INTERIM` | - | Clear the interim line |
| `CLEAR_ALL` | - | Clear all lines |
| `REMOVE_OVERLAY` | - | Remove the overlay |

### Service Worker → Popup

| Type | Payload | Description |
|------|---------|-------------|
| `STATE` | `{ state }` | Update status indicator |
| `ERROR` | `{ code, message }` | Display an error |

`DG_TRANSCRIPT` is a legacy message name; it now carries local SenseVoice output, not Deepgram output.

## Storage

`chrome.storage.local` stores only overlay settings:

- `overlay.lines`
- `overlay.fontSize`
- `overlay.opacity`
- `overlay.showInterim`

Session state, tab id, drag position, and transcript history are runtime-only.

## Design Notes

- **Offscreen document** is used because MV3 service workers cannot reliably own long-lived media capture and Web Audio.
- **AudioWorklet** keeps resampling and PCM conversion off the main thread.
- **Silero VAD plus a ring buffer** avoids sending silence and gives utterance boundaries without a cloud endpointing service.
- **One provisional decode per utterance** provides early feedback without repeatedly re-decoding the same speech.
- **Local ONNX model** removes API keys, network transcription, and provider rate limits.
- **Selectable DOM text** is intentional for Yomitan compatibility.

## Known Limitations

- A real tab-audio end-to-end session still needs manual browser testing with Chrome's share picker.
- The 6-second utterance cap can cut a very long continuous sentence at a non-linguistic boundary.
- A final decode is queued behind an in-flight provisional decode; stopping speech immediately after the 1.2-second interim can add a small amount of final latency.
- No automated end-to-end audio test exists yet.
- The SenseVoice license note in `models/sensevoice/LICENSE` should be reviewed before redistributing the model.
- `context.md` and `implementation_plan.md` are historical documents and do not describe the current local model pipeline.
