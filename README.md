# HiAnime Live Japanese Subtitles

A Chrome/Edge MV3 extension that captures audio from a tab, transcribes Japanese speech locally, and draws selectable subtitles over the page.

No API key, no server, no cloud speech service. Recognition runs on a bundled SenseVoice int8 ONNX model with Silero VAD, through ONNX Runtime Web (WASM).

## Requirements

- Chrome or Edge 116+
- [Git LFS](https://git-lfs.com) — the model and WASM binaries are stored with LFS

## Install

```powershell
git lfs install
git clone https://github.com/nimeshishijackok69-byte/subtitle-moonshine.git
cd subtitle-moonshine
git lfs pull
```

Then load it:

1. Open `chrome://extensions` and enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Open the popup, set the overlay options, click **Start**.
4. In the share picker, choose the tab playing Japanese audio and turn on **Share audio**.

There is no key field; nothing to configure.

## Usage

Option | Range
--- | ---
Lines | 1–5
Font size | 20–48 px
Background opacity | 15–75%
Interim line | on/off

Hover the overlay to get the drag handle and close button. Subtitles are ordinary DOM text, so Yomitan and similar tools can read them. Closing the overlay is sticky until the next session starts.

## How it works

```
popup → service worker → offscreen document → AudioWorklet → 16 kHz PCM
                                                             ↓
                                        Silero VAD → SenseVoice → overlay
```

- **Offscreen document** owns `getDisplayMedia` and the Web Audio graph, which an MV3 service worker can't hold.
- **AudioWorklet** averages channels to mono, applies a 4th-order Butterworth low-pass at 7.5 kHz (skipped when the source is already ≤16 kHz), resamples by streaming linear interpolation, and posts 25 ms Int16 chunks as transferables.
- **Silero VAD** runs on 512-sample frames fed with the preceding 64 samples of context (the v5 wrapper relies on it). Onset needs 3 frames above `0.50`; an utterance closes after 640 ms below `0.35`. Windows are anchored at 300 ms pre-roll, padded 200 ms, floored at 1.0 s and capped at 8 s.
- **SenseVoice** runs a JS fbank frontend (80 bins, LFR 7/6, CMVN) and greedy CTC decode with `language=ja`, `text_norm` on. Output is NFKC-normalised, tags stripped, and Japanese inter-character spaces removed.
- **Committer** re-decodes the anchored window every 750 ms while speech continues, commits only the longest common prefix minus a 4-character holdback, and rewrites one line per utterance (`GROW` / `REVISE` / `INTERIM` / `FINAL`). Every decode is serialised through one promise chain so a late tick can't overwrite a finished line.
- **Service worker** relays messages, re-injects the overlay after a tab reload, and closes the offscreen document 5 minutes after the session goes idle.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest, permissions, CSP, cross-origin isolation headers |
| `constants.js` | Message types and session states |
| `service_worker.js` | Offscreen lifecycle, tab injection, message relay |
| `popup.html` / `popup.js` / `popup.css` | Controls, persisted settings, status |
| `offscreen.html` / `offscreen.js` | Capture, VAD, inference, committer |
| `audio-worklet.js` | Filter, resample, Int16 chunking |
| `sensevoice-frontend.js` | fbank + LFR + CMVN |
| `contentScript.js` | Overlay, drag/close, telemetry |
| `models/sensevoice/` | int8 model, tokens, frontend config (LFS) |
| `lib/` | ONNX Runtime Web 1.21, Silero VAD (LFS) |

## Errors

`CAPTURE_DENIED`, `NO_AUDIO_TRACK`, `WRONG_CAPTURE_SOURCE` (you shared the extension's own page), `START_FAILED`, `AUDIO_PROCESS_ERROR`. The popup shows the message and the offscreen document is torn down.

## Telemetry

The content script keeps the last 1000 committer events. From the page console:

```js
__dgTelemetry.getStats()     // percentiles for FINAL lines
__dgTelemetry.downloadCsv()  // raw events as CSV
```

It reports ASR time, end-to-end latency, audio backlog, and sound-to-subtitle delay.

## Known limitations

- First subtitle for an utterance lands roughly 2 s after speech begins.
- The 8 s cap can cut a long continuous sentence.
- A misrecognition that survives prefix agreement stays on screen until the utterance ends.
- Short interjections (`あ。`, `はい。`) are the main hallucination residue.
- `models/onnx/` and `models/tokenizer*` are legacy Moonshine artifacts; the runtime doesn't load them.

## Model licence

`models/sensevoice/LICENSE` points to the FunASR licence. Review it before redistributing the model.
