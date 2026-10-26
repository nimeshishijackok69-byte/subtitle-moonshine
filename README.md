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
- applies a 4th-order Butterworth low-pass at 7.5 kHz (two biquads, Direct Form II Transposed) as the anti-aliasing filter
- resamples to 16 kHz with streaming linear interpolation
- converts Float32 to signed Int16
- emits 25 ms PCM chunks (configurable through `chunkMs`)

The filter replaces a 1-pole RC section at 7.2 kHz, which was only −8.8 dB at 16 kHz. The cascaded design is −40.9 dB at 16 kHz and −67.5 dB at 20 kHz, so content that folds back into the voice band is attenuated rather than aliased in. At the 8 kHz Nyquist point the attenuation is −4.6 dB, so the band just above Nyquist is still only lightly filtered; the improvement is above ~10 kHz.

The worklet does not perform VAD. All gating and segmentation happens in `offscreen.js`.

### 3. VAD Segmentation

`offscreen.js` keeps a 20-second PCM ring buffer. Silero VAD runs on 512-sample frames (32 ms at 16 kHz), each frame fed to the model **prepended with the 64 samples of audio that preceded it** (576 samples total). Silero v5's reference wrapper carries that left context; without it the encoder collapses to a near-constant "no speech" prior without raising an error. On a 60-second dialogue-dense window of anime audio (685–745 s of the source), the same model returns a median speech probability of `0.0005` on 512-sample input and `0.8988` on 576-sample input. On a cold open the 576-sample path stays closed (max `0.0848`), so the fix does not create false onsets.

Current segmentation settings:

| Setting | Value |
|---------|-------|
| Speech threshold | `0.50` |
| Speech start confirmation | 3 consecutive frames (~96 ms) |
| Pre-roll before speech | 300 ms |
| End-silence boundary | 640 ms |
| Speech-continuation threshold | `0.35` |
| Tail padding | 200 ms |
| Minimum decode window | 1.0 s (widened backwards, not dropped) |
| Maximum utterance | 8 s |

An utterance is anchored: the left edge is fixed at the VAD onset minus the pre-roll and never moves, and the right edge grows while speech continues. An 8-second cap bounds final-decode latency; if speech runs past it the utterance is flushed and the next one starts immediately.

The 1.0 s floor is a property of the decode window, not a filter on speech. The window is 0.3 s pre-roll + speech + 0.2 s tail, so a 0.2 s exclamation yields a 0.7 s window; the final decode widens it backwards into the ring buffer, or left-pads with silence at stream start, so the CTC encoder always receives at least 1.0 s. On `benchmark_16k.wav` the three sub-0.5 s bursts the old code discarded (`やらない。`, `ただ?`, `それから?`) all decode correctly at a 1.0 s window. Widening further is not free: at 2.0 s the window reaches into the previous line and the decode absorbs it (`だと思います、ただ。`), so the floor stays at 1.0 s.

### 4. SenseVoice Inference

While an utterance is being spoken it is decoded repeatedly over the anchored window (§5). When it ends, one final decode covers the whole utterance with the tail padding, and that decode owns the line:

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

### 5. Anchored Committer

Each utterance is decoded repeatedly while it is still being spoken, always over the same anchored window, once every 750 ms. Rather than replacing the whole line on every decode, the committer keeps a committed prefix and grows it in place:

| Event | Meaning |
|-------|---------|
| `GROW` | The committed prefix extended; rewrite the line in place, with the new tail |
| `REVISE` | A later decode disagreed with already-committed text; rewrite it, with the new tail |
| `INTERIM` | The unstable remainder after the committed prefix |
| `FINAL` | Utterance ended; the line is authoritative and joins the history |

`GROW` and `REVISE` carry the unstable tail in the same message, so one paint updates both the committed text and the dimmed remainder. Sending the tail as a separate `INTERIM` meant two IPC hops and two layouts per 750 ms tick, and the intermediate frame showed the committed text with no tail.

Two rules keep the committed text stable:

1. **Local agreement.** A prefix only commits up to the longest common prefix of the previous and current decode, so a decode that flips a character cannot publish it.
2. **Holdback.** The last 4 characters of that common prefix stay uncommitted, because the final characters of a decode are the least settled.

Measured on 305 subtitle lines of *Mushoku Tensei* S3E14 with a 0.5 s decode step (finer than the shipped 750 ms), this reduces contradicted text from 36.6% of committed updates to 1.7%, and produces one line per sentence instead of 5.2. The sliding-window comparison was not re-run at 750 ms.

Every ASR call on a session is serialised through one promise chain. A progressive tick and the utterance-final flush would otherwise overlap on the same ONNX session, and the losing decode would deliver a `GROW`/`INTERIM` *after* `FINAL`, rewriting an already-finalised line.

### 6. Overlay

`contentScript.js` renders ordinary DOM text so Yomitan and similar tools can inspect it.

- default 3 lines
- font size 20-48 px
- background opacity 15-75%
- optional interim text
- draggable and removable
- settings stored in `chrome.storage.local` under `overlay.*`
- re-injected after tab navigation/reload while a session is active

The overlay is exactly `overlay.lines` rows at all times. The active utterance occupies the last row and carries its unstable tail inline as a dimmed span, so a sentence never straddles two rows and the box never gains or loses a row mid-session. A long row can still wrap to a second visual line. Rows are reused and only their text nodes are touched, so a 750 ms tick does not rebuild the DOM.

Dismissing the overlay is sticky: incoming transcripts do not resurrect it, only the next session start does.

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

The popup displays the current state. The service worker closes the offscreen document on `error`. On `idle` it keeps the document warm for five minutes so a restart does not re-compile the 239 MB model. That timer is a `setTimeout`, which does not survive service-worker termination (~30 s idle), so the document can stay resident until the extension is reloaded — a known gap, not a guarantee.

## Message Types

### Popup → Service Worker

| Type | Payload | Description |
|------|---------|-------------|
| `GET_STATUS` | - | Return current state and tab id |
| `START_SESSION` | `{ tabId, config }` | Start capture and transcription |
| `STOP_SESSION` | - | Stop the active session |
| `APPLY_SETTINGS` | `{ tabId, config }` | Update overlay settings |

`ENSURE_OFFSCREEN` is defined and handled in `service_worker.js` but nothing sends it; the service worker creates the offscreen document itself on `START_SESSION`.

### Service Worker → Offscreen

| Type | Payload | Description |
|------|---------|-------------|
| `START` | `{ tabId, config }` | Load models and begin capture |
| `STOP` | - | Stop capture, flush the active utterance, clean up |
| `GET_STATUS` | `{ target: "offscreen" }` | Live state, tab id, and `hasSession` from the offscreen document |

### Offscreen → Service Worker

| Type | Payload | Description |
|------|---------|-------------|
| `OFFSCREEN_STATE` | `{ state }` | Session state update |
| `OFFSCREEN_ERROR` | `{ code, message }` | User-facing error |
| `OFFSCREEN_TRANSCRIPT` | `{ tabId, event }` | Committer event, see below |
| `OFFSCREEN_CLEAR_INTERIM` | `{ tabId }` | Clear the interim line |
| `OFFSCREEN_CLEAR_ALL` | `{ tabId }` | Clear all subtitle lines |

`event` is `{ action, lineId, text, tail, isFinal, ts, telemetry }`. `action` is one of the `MSG.TRANSCRIPT_*` constants, whose values are the wire strings `GROW`, `REVISE`, `INTERIM`, `FINAL`; `lineId` identifies the utterance being rewritten. `tail` is the unstable remainder after the committed prefix, sent in the same message as `GROW`/`REVISE` so the row is painted once instead of twice.

### Service Worker → Content Script

| Type | Payload | Description |
|------|---------|-------------|
| `APPLY_SETTINGS` | `{ config }` | Update overlay appearance |
| `DG_TRANSCRIPT` | `{ action, lineId, isFinal, text, tail, ts, telemetry }` | Committer event for one line |
| `CLEAR_INTERIM` | - | Clear the interim line |
| `CLEAR_ALL` | - | Clear all lines and reset telemetry |
| `REMOVE_OVERLAY` | - | Remove the overlay |

`REMOVE_OVERLAY` is handled by the content script but nothing currently sends it; the user-facing close button removes the overlay locally, and `CLEAR_ALL` at the next session start rebuilds it.

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

## Telemetry

The content script keeps the last 1000 committer events in memory. `window.__dgTelemetry.downloadCsv()` writes the raw events to a CSV. Both `getStats()` and `downloadCsv()` are reachable from the page console through a main-world bridge.

The bridge is asynchronous by construction: the page world cannot read extension memory, so `getStats()` dispatches a request event and returns whatever the previous reply cached (or `"Calculating stats (logged below)..."` on the first call). The extension side then `console.table`s the fresh result. Statistics cover `FINAL` rows only — interim decodes are in the CSV but are not part of the percentiles.

| Column | Meaning |
|--------|---------|
| `Index` | Monotonic per-session event id; restarts at 1 after `CLEAR_ALL` |
| `WallClock` | Local time the event was received by the content script |
| `Text` | The line text carried by the event |
| `Action` | `GROW`, `REVISE`, `INTERIM`, or `FINAL` |
| `IsFinal` | Whether the utterance was closed by this event |
| `AudioSeconds` | Position in the captured audio that the decode covers |
| `AsrDurationMs` | Wall time spent inside ONNX inference |
| `E2ELatencyMs` | Decode start → overlay paint. Excludes audio backlog |
| `AudioLagMs` | How far behind real time the decoded audio was at decode start |
| `SoundToSubtitleMs` | `E2ELatencyMs + AudioLagMs`: the delay a viewer actually perceives |

`AudioLagMs` is derived from a stream origin captured on the first PCM chunk, so `streamStartEpoch + AudioSeconds*1000` is the wall-clock instant that sound played. Without that origin the earlier CSVs reported a constant ~20.9 s that was a clock-origin offset, not latency. A field that was not supplied is written as `null` rather than a fabricated number.

`SoundToSubtitleMs` on a `FINAL` row is optimistic by the tail padding: `AudioSeconds` covers the decoded window including the 200 ms pad, so the derived sound instant is up to 200 ms later than the last syllable.

Telemetry resets on `CLEAR_ALL`, so a new session's CSV does not contain the previous session's rows.

## Design Notes

- **Offscreen document** is used because MV3 service workers cannot reliably own long-lived media capture and Web Audio.
- **AudioWorklet** keeps resampling and PCM conversion off the main thread.
- **Silero VAD plus a ring buffer** avoids sending silence and gives utterance boundaries without a cloud endpointing service.
- **Anchored committer** rewrites one growing line per utterance instead of appending a new line per decode, so the viewer reads a sentence rather than a transcript of revisions.
- **Local ONNX model** removes API keys, network transcription, and provider rate limits.
- **Selectable DOM text** is intentional for Yomitan compatibility.

## Known Limitations

- A real tab-audio end-to-end session still needs manual browser testing with Chrome's share picker.
- The 8-second utterance cap can cut a very long continuous sentence at a non-linguistic boundary.
- Committed text is stable but not always correct: a misrecognition that survives local agreement and the 4-character holdback stays on screen until the utterance ends.
- Short interjections (`あ。`, `はい。`) are the main hallucination residue in a live run; they are not currently suppressed.
- The first committed text for an utterance lands roughly 2 s after speech starts (onset confirmation + one decode tick + holdback).
- The telemetry bridge runs in the page's main world, so a script on the page can call `window.__dgTelemetry.downloadCsv()` and trigger a file download. It cannot read extension memory directly; everything it sees is what the bridge publishes.
- No automated end-to-end audio test exists yet.
- The SenseVoice license note in `models/sensevoice/LICENSE` should be reviewed before redistributing the model.
- `context.md` and `implementation_plan.md` are historical documents and do not describe the current local model pipeline.
