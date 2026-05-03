# HiAnime — Live Japanese Subtitles (Chrome Extension)

A Chrome extension (Manifest V3) that captures tab audio and streams it to [Deepgram](https://deepgram.com) for real-time Japanese speech-to-text transcription, displayed as an overlay on the page.

---

## Architecture

The extension is split into 4 runtime contexts that communicate via `chrome.runtime.sendMessage`:

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Chrome Extension                             │
│                                                                     │
│  ┌──────────────┐    ┌──────────────────┐    ┌───────────────────┐  │
│  │  popup.html   │◄──►│  service_worker  │◄──►│  offscreen.html   │  │
│  │  (popup UI)   │    │  (orchestrator)  │    │  (audio capture)  │  │
│  └──────────────┘    └────────┬─────────┘    └───────────────────┘  │
│                               │                         │           │
│                               │                         │ audio-worklet.js
│                               ▼                         ▼           │
│                    ┌──────────────────┐    ┌───────────────────┐     │
│                    │  contentScript   │    │   Deepgram WSS    │     │
│                    │  (overlay DOM)   │    │  (STT streaming)  │     │
│                    └──────────────────┘    └───────────────────┘     │
└─────────────────────────────────────────────────────────────────────┘
```

### Files

| File | Role |
|------|------|
| `manifest.json` | Extension configuration — declares permissions, service worker, CSP |
| `service_worker.js` | Background orchestrator — manages offscreen document lifecycle, relays messages between popup, offscreen, and content script |
| `offscreen.html` | Blank HTML shell that loads `offscreen.js` |
| `offscreen.js` | Audio capture logic — calls `getDisplayMedia`, creates AudioContext, connects to Deepgram WebSocket, forwards transcripts |
| `audio-worklet.js` | AudioWorkletProcessor — downmixes multi-channel audio to mono, resamples to 16kHz, converts Float32 to Int16 PCM chunks |
| `contentScript.js` | Injected into the target tab — renders a subtitle overlay (final lines + interim line) |
| `popup.html` | Extension popup UI — API key input, settings sliders, Start/Stop buttons |
| `popup.js` | Popup logic — loads/saves settings, sends commands to service worker, updates status indicator |
| `popup.css` | Popup styling — light/dark mode, Teal accent color |

---

## How it works

### 1. Audio Capture

When the user clicks **Start**:

1. **Popup** (`popup.js`) sends `START_SESSION` to the service worker with the tab ID and config (API key, overlay settings)
2. **Service worker** (`service_worker.js`) injects the content script into the tab, creates an offscreen document
3. **Offscreen document** (`offscreen.js`) calls `navigator.mediaDevices.getDisplayMedia()` with `preferCurrentTab: true` to capture the tab's audio
4. The audio track is piped into an `AudioContext` → `AudioWorkletNode`

```
getDisplayMedia({ audio: true, preferCurrentTab: true })
  → MediaStream (audio track)
  → AudioContext.createMediaStreamSource()
  → AudioWorkletNode ("pcm-capture-processor")
  → silence gain node → audioContext.destination
```

### 2. PCM Conversion (audio-worklet.js)

The `PcmCaptureProcessor` AudioWorkletProcessor:

- **Downmixes** multi-channel audio to mono (averages all channels)
- **Resamples** from the source sample rate to 16kHz using linear interpolation
- **Converts** Float32 samples (-1 to 1) to Int16 (-32768 to 32767)
- **Buffers** into chunks (default 40ms worth of samples) and posts them to the main thread

### 3. Deepgram Streaming

The offscreen document opens a WebSocket to `wss://api.deepgram.com/v1/listen`:

- **Authentication**: `new WebSocket(url, ["token", apiKey])`
- **Query params**: `language=ja`, `encoding=linear16`, `sample_rate=16000`, `interim_results=true`, `endpointing=250`
- **Binary messages**: PCM Int16 chunks sent as `ArrayBuffer` via `ws.send()`
- **Text responses**: JSON with transcript results — `is_final` for final utterances, `speech_final` for end of speech

Duplicate suppression: Skips forwarding if the text matches the last sent interim or final.

### 4. Transcript Relay

The service worker acts as a relay:

```
offscreen.js → OFFSCREEN_TRANSCRIPT → service_worker.js → DG_TRANSCRIPT → contentScript.js
```

- `OFFSCREEN_CLEAR_INTERIM` — clears the interim line when Deepgram sends a final result
- `OFFSCREEN_CLEAR_ALL` — clears all lines (used at session start)
- `OFFSCREEN_STATE` / `OFFSCREEN_ERROR` — forwards status/errors back to the popup

### 5. Overlay Rendering (contentScript.js)

The content script creates a fixed-position overlay at the bottom-center of the page:

- **Final lines**: A scrollable buffer of completed utterances (default 4 lines, configurable 3–6)
- **Interim line**: Italic, semi-transparent — shows live, partial transcription
- **Settings**: Font size (20–48px), background opacity (15–75%), show/hide interim toggle
- **Persistence**: Settings are saved to `chrome.storage.local` and restored on popup open
- **Auto-reinjection**: If the tab navigates/reloads, the service worker re-injects the content script and reapplies settings

---

## Setup & Usage

### Prerequisites

- **Chrome 116+** (required for `offscreen` API and `chrome.runtime.getContexts`)
- **Deepgram API key** — sign up at [deepgram.com](https://deepgram.com) (free $200 credit, no credit card required for trial)

### Installation

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in top-right corner)
3. Click **"Load unpacked"**
4. Select the `hianime` folder
5. The extension icon should appear in the toolbar

### Usage

1. Navigate to any site with Japanese audio (e.g., Crunchyroll, Netflix, YouTube)
2. Click the extension icon to open the popup
3. Enter your Deepgram API key and click **Save**
4. Adjust overlay settings (lines, font size, opacity, interim toggle)
5. Click **Start**
6. In the screen-sharing prompt, select the tab (choose the current tab or any tab playing audio)
7. Subtitles will appear at the bottom of the page

### Notes

- Check **"Share audio"** is enabled in the screen-sharing dialog
- The extension captures system audio from the selected tab — the tab does not need to be visible as long as audio is playing
- All processing happens locally in the browser; only the PCM audio is sent to Deepgram's servers
- The API key is stored in `chrome.storage.local` (not synced to other devices)

---

## Data Flow Diagram

```
User clicks "Start"
  │
  ▼
popup.js: startSession()
  │ sends START_SESSION { tabId, config }
  ▼
service_worker.js: startSession()
  │ 1. Injects contentScript.js into tab
  │ 2. Sends CLEAR_ALL, APPLY_SETTINGS to content script
  │ 3. Creates offscreen document (offscreen.html)
  │ 4. Sends START { tabId, config } to offscreen
  ▼
offscreen.js: startSession()
  │ 1. setState("awaiting_capture_permission")
  │ 2. getDisplayMedia({ audio: true, preferCurrentTab: true })
  │ 3. setState("capturing")
  │ 4. Creates AudioContext → loads audio-worklet.js
  │ 5. Connects: sourceNode → workletNode → silenceNode → destination
  │ 6. setState("connecting_deepgram")
  │ 7. Opens WebSocket to Deepgram
  ▼
Deepgram connection established
  │ setState("listening")
  ▼
audio-worklet.js: process()
  │ Downmix → Resample → Float32→Int16 → Buffer → postMessage("PCM_CHUNK")
  ▼
offscreen.js: workletNode.port.onmessage
  │ ws.send(chunk)  ──────►  Deepgram STT
  │                           │
  │                     ◄──── ws.onmessage: { channel: { alternatives: [{ transcript }] }, is_final, speech_final }
  ▼
offscreen.js: forwardTranscript()
  │ sends OFFSCREEN_TRANSCRIPT { tabId, event }
  ▼
service_worker.js: handles OFFSCREEN_TRANSCRIPT
  │ sends DG_TRANSCRIPT { isFinal, text, ts } to tab
  ▼
contentScript.js: handles DG_TRANSCRIPT
  │ isFinal → commitFinal(): push to finalLines[], re-render
  │ !isFinal → renderInterim(): update interimNode textContent
  ▼
User sees subtitles on the page
```

---

## Message Types

### Popup → Service Worker

| Type | Payload | Description |
|------|---------|-------------|
| `GET_STATUS` | — | Get current session state |
| `ENSURE_OFFSCREEN` | — | Ensure offscreen document exists |
| `START_SESSION` | `{ tabId, config }` | Start a new transcription session |
| `STOP_SESSION` | — | Stop the active session |
| `APPLY_SETTINGS` | `{ tabId, config }` | Update overlay settings on the tab |

### Service Worker → Offscreen

| Type | Payload | Description |
|------|---------|-------------|
| `START` | `{ tabId, config }` | Start audio capture + Deepgram connection |
| `STOP` | — | Stop capture, close WebSocket, clean up |

### Offscreen → Service Worker

| Type | Payload | Description |
|------|---------|-------------|
| `OFFSCREEN_STATE` | `{ state }` | Report current state for popup status |
| `OFFSCREEN_ERROR` | `{ code, message }` | Report error for popup display |
| `OFFSCREEN_TRANSCRIPT` | `{ tabId, event }` | Forward transcript text to the tab |
| `OFFSCREEN_CLEAR_INTERIM` | `{ tabId }` | Clear the interim line on the tab |
| `OFFSCREEN_CLEAR_ALL` | `{ tabId }` | Clear all subtitle lines on the tab |

### Service Worker → Content Script

| Type | Payload | Description |
|------|---------|-------------|
| `APPLY_SETTINGS` | `{ config }` | Update overlay dimensions, font, opacity |
| `DG_TRANSCRIPT` | `{ isFinal, text, ts }` | Display a transcript line |
| `CLEAR_INTERIM` | — | Clear the interim (partial) line |
| `CLEAR_ALL` | — | Clear all subtitle lines |

### Service Worker → Popup

| Type | Payload | Description |
|------|---------|-------------|
| `STATE` | `{ state }` | Update the popup status indicator |
| `ERROR` | `{ code, message }` | Display error in the popup |

---

## State Machine

```
idle → creating_offscreen → awaiting_capture_permission → capturing → connecting_deepgram → listening
                                                                                                      │
                                                                                                      ▼
listening → stopping → idle
listening → error (on WebSocket close / auth failure)
     any → error (on unexpected failure)
```

States tracked in `currentState` on the service worker and forwarded to the popup.

---

## Key Design Decisions

- **Offscreen document instead of service worker**: Chrome MV3 service workers have short lifetimes and can't use `getDisplayMedia`. The offscreen API provides a persistent DOM-free page for media capture.
- **AudioWorklet instead of ScriptProcessor**: AudioWorklet runs on a separate audio thread, avoiding audio glitches. It's the modern replacement for the deprecated `ScriptProcessorNode`.
- **`preferCurrentTab`**: New in Chrome 116, avoids the cumbersome "this tab / other tab" UI. Falls back to standard getDisplayMedia on older versions.
- **Deepgram WebSocket with token auth**: Uses the `["token", apiKey]` WebSocket protocol, keeping the API key out of the URL query string.