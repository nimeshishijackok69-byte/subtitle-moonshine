# HiAnime Extension Context

## What This Project Is

This project is a Chrome Extension built with Manifest V3 that captures audio from a user-selected browser tab, streams that audio to Deepgram over WebSocket for real-time Japanese speech-to-text transcription, and renders the recognized text as selectable HTML subtitles directly on top of the page.

The core product goal is:

- capture tab audio with user consent
- transcribe it quickly using Deepgram streaming STT
- display the result as normal page DOM text
- keep the text selectable so tools like Yomitan can inspect it

This is not a server-backed application. It is almost entirely client-side:

- Chrome Extension UI and orchestration run inside extension contexts
- audio capture and processing run inside an offscreen document and an AudioWorklet
- speech recognition runs in Deepgram's cloud via WebSocket
- subtitle rendering happens in a content script injected into the target tab


## The Big Picture

At runtime, the extension is split into separate Chrome contexts because Manifest V3 does not let one script do everything.

There are 5 functional runtime pieces:

1. `popup.html` + `popup.js`
   - the visible UI the user clicks
   - collects settings and API key
   - starts and stops sessions
   - shows current status and errors

2. `service_worker.js`
   - the central orchestrator
   - owns extension-level session metadata
   - injects the overlay into tabs
   - creates and closes the offscreen document
   - relays messages between popup, offscreen, and tab

3. `offscreen.html` + `offscreen.js`
   - the long-running background page used for media capture in MV3
   - calls `getDisplayMedia()`
   - builds the Web Audio graph
   - opens the Deepgram WebSocket
   - forwards transcripts and state updates

4. `audio-worklet.js`
   - the real-time audio processor
   - receives raw browser audio frames
   - downmixes stereo or multi-channel audio to mono
   - low-pass filters the signal
   - resamples to `16 kHz`
   - converts `Float32` audio to `Int16 PCM`
   - optionally gates silence using lightweight VAD behavior
   - posts fixed-size PCM chunks back to `offscreen.js`

5. `contentScript.js`
   - injects the actual subtitle overlay into the page
   - renders final and interim transcript lines
   - keeps the overlay selectable
   - allows dragging and removing the overlay

Deepgram is the only external service:

- `wss://api.deepgram.com/v1/listen`


## The Stack

### Platform

- Chrome Extension
- Manifest V3
- Chrome `offscreen` API
- Chrome `tabs`, `activeTab`, `scripting`, `storage` permissions

### UI

- plain HTML
- plain CSS
- plain JavaScript
- no framework

### Audio

- `navigator.mediaDevices.getDisplayMedia()`
- `AudioContext`
- `MediaStreamAudioSourceNode`
- `AudioWorkletNode`
- custom `AudioWorkletProcessor`

### Streaming

- WebSocket
- Deepgram streaming STT
- `linear16`, `16 kHz`, `mono`

### Storage

- `chrome.storage.local`

### Messaging

- `chrome.runtime.sendMessage()`
- `chrome.tabs.sendMessage()`


## Why The Architecture Looks Like This

This architecture is shaped by Chrome MV3 restrictions.

### Why not do everything in the popup?

Because the popup is temporary. It appears only while the user has it open. The moment the popup closes, its JavaScript can go away. Audio capture and streaming need to continue even after the popup closes.

### Why not do everything in the service worker?

Because MV3 service workers are not a good place for long-lived media operations. They are event-driven and can be suspended. Also, media capture and Web Audio are better suited to a document context.

### Why use an offscreen document?

The offscreen document is the correct MV3 place for:

- long-running media capture
- persistent WebSocket activity
- Web Audio graph setup
- a DOM-capable context without a visible page

### Why use a content script instead of extension UI for subtitles?

Because Yomitan and similar tools work best with real text inside the page DOM. The overlay must be injected into the page itself, not rendered inside the popup or as canvas pixels.


## File-by-File Explanation

### `manifest.json`

This is the extension manifest and the entry point Chrome reads when loading the extension.

It defines:

- extension name, version, description
- minimum Chrome version: `116`
- permissions:
  - `activeTab`
  - `offscreen`
  - `scripting`
  - `storage`
  - `tabs`
- the background service worker:
  - `service_worker.js`
  - `type: "module"`
- the action popup:
  - `popup.html`
- the content security policy for extension pages:
  - allows connecting to Deepgram over `wss:` and `https://api.deepgram.com`

Important implication:

- there is no declarative `content_scripts` section
- the overlay script is injected dynamically by the service worker only when needed

### `constants.js`

This file defines the shared protocol and state constants used across the extension.

It creates `globalThis.HIANIME` with:

- `MSG`: all message type names
- `STATE`: all session state values

Why this matters:

- avoids duplicated magic strings across files
- keeps popup, worker, offscreen, and content script in sync
- reduces typo risk in cross-context messaging

### `popup.html`

This is the extension popup UI markup.

It contains:

- status label and status dot
- API key input
- save and clear key buttons
- sliders for:
  - subtitle lines
  - font size
  - background opacity
- checkbox for showing interim text
- start and stop buttons

It loads:

- `constants.js`
- `popup.js`

### `popup.css`

This styles the popup.

It includes:

- light and dark mode support
- section cards
- button styles
- invalid API-key input style
- short "saved" visual state for the save button
- ellipsis handling for long status text

This file does not affect the in-page subtitle overlay. It only styles the extension popup.

### `popup.js`

This is the user-facing controller.

Its responsibilities are:

- reading and writing settings from `chrome.storage.local`
- validating the API key format
- enabling and disabling Start and Stop based on session state
- sending start, stop, and apply-settings messages to the service worker
- updating the popup status text when background state changes

Important implementation details:

- overlay settings are saved separately from the API key
- overlay settings are saved with a debounce to reduce storage churn
- overlay settings are pushed live to the active tab when changed
- API key saving is explicit via the Save button
- session config sent to the worker includes:
  - overlay settings
  - API key
  - `language: "ja"`
  - `model: "nova-3"`

### `service_worker.js`

This is the runtime coordinator.

It is the most important control-plane file in the extension.

It manages:

- whether an offscreen document exists
- which tab is currently active for subtitles
- the current session state
- re-injecting the overlay on page reload/navigation
- relaying transcript events to the content script
- relaying state and errors back to the popup

It does not process audio itself.

Instead, it coordinates who should do what.

### `offscreen.html`

This is just the shell page for the offscreen document.

It loads:

- `constants.js`
- `offscreen.js`

The HTML itself is intentionally minimal.

### `offscreen.js`

This is the runtime engine for the session.

It does the heavy lifting:

- asks the user to choose a tab via `getDisplayMedia()`
- verifies the chosen source is not the extension page itself
- extracts the audio track
- builds the Web Audio pipeline
- starts the Deepgram WebSocket
- sends audio chunks
- receives transcript messages
- deduplicates interim and final transcripts
- reports session state
- handles retries, keepalive, cleanup, and finalization

This is where the actual live transcription session lives.

### `audio-worklet.js`

This file defines `PcmCaptureProcessor`, the custom `AudioWorkletProcessor`.

It receives high-rate audio frames from Chrome and transforms them into Deepgram-ready PCM chunks.

Its main jobs are:

- downmix to mono
- low-pass filter the signal
- resample to `16 kHz`
- convert to signed `Int16`
- measure chunk RMS energy
- apply simple voice-activity style gating
- preserve short pre-roll before voice starts
- emit binary audio chunks to the offscreen page

This file is performance-sensitive because it runs on the audio rendering thread.

### `contentScript.js`

This creates and manages the subtitle overlay on the actual web page.

It:

- injects CSS and the overlay root
- keeps a stable DOM structure
- updates only text content where possible
- stores the last final lines in memory
- shows one optional interim line
- supports dragging the overlay
- supports removing the overlay
- prevents duplicate bootstrapping if injected multiple times

This file is designed so the text remains regular HTML text, which is important for Yomitan.

### `README.md`

This is the existing high-level project documentation.

`context.md` is more comprehensive and is intended to become the deeper implementation guide and mental model for maintainers.


## Current Runtime Contexts And Their Boundaries

Chrome extensions do not run as one JavaScript process. This project uses several separate contexts.

### Popup context

Files:

- `popup.html`
- `popup.js`
- `popup.css`
- `constants.js`

Can do:

- render settings UI
- read and write extension storage
- ask the worker for status
- issue start and stop commands

Cannot safely own:

- long-lived audio capture
- long-lived streaming session

### Service worker context

Files:

- `service_worker.js`
- `constants.js`

Can do:

- listen for extension-wide events
- inject scripts into tabs
- create the offscreen document
- forward messages between contexts

Not ideal for:

- long-lived media processing
- real-time audio graph work

### Offscreen document context

Files:

- `offscreen.html`
- `offscreen.js`
- `constants.js`

Can do:

- call `getDisplayMedia()`
- create `AudioContext`
- create and manage `WebSocket`
- stay alive while the session is running

### Audio worklet context

File:

- `audio-worklet.js`

Can do:

- receive audio frames with low latency
- transform audio efficiently
- post messages back to the offscreen document

Important limitation:

- it is not a normal browser page thread
- it has a smaller API surface and must stay lean

### Content script context

Files:

- `contentScript.js`
- `constants.js`

Can do:

- manipulate the page DOM
- render subtitles directly in the target tab
- receive transcript events

Cannot do:

- use privileged extension APIs freely like the background can
- own the capture session


## End-to-End Flow

This is the most important section if you want to understand how the whole app works.

### Startup flow

1. The user opens the popup.
2. `popup.js` loads saved settings from `chrome.storage.local`.
3. `popup.js` asks the service worker for the current session state with `MSG.GET_STATUS`.
4. The popup updates the UI so Start and Stop reflect whether the extension is already listening.

### Start flow

1. The user clicks Start.
2. `popup.js` validates that the Deepgram key looks usable.
3. `popup.js` builds the full session config.
4. `popup.js` sends `MSG.START_SESSION` to the service worker with:
   - `tabId`
   - overlay settings
   - API key
   - language and model config
5. `service_worker.js` stores:
   - `activeTabId`
   - `lastOverlayConfig`
   - `currentState = creating_offscreen`
6. The worker ensures the overlay exists in the target tab.
7. The worker clears any previous subtitle lines.
8. The worker applies current overlay settings to the tab.
9. The worker ensures an offscreen document exists.
10. The worker sends `MSG.START` to `offscreen.js`.
11. `offscreen.js` sets state to `awaiting_capture_permission`.
12. `offscreen.js` calls `navigator.mediaDevices.getDisplayMedia()`.
13. Chrome shows the user a picker to select which tab or surface to share.
14. If the user grants access and shared audio exists, `offscreen.js` creates the audio pipeline.
15. `offscreen.js` creates a WebSocket connection to Deepgram.
16. Once the socket opens, state becomes `listening`.
17. Audio chunks start flowing to Deepgram.
18. Transcript events start flowing back to the content script.

### Live transcription flow

1. Browser audio enters `AudioContext`.
2. `MediaStreamAudioSourceNode` forwards the audio into `AudioWorkletNode`.
3. `audio-worklet.js` converts audio into PCM chunks.
4. `offscreen.js` receives chunks from `workletNode.port.onmessage`.
5. `offscreen.js` checks socket state and backpressure.
6. `offscreen.js` sends the PCM chunk to Deepgram with `websocket.send()`.
7. Deepgram sends transcript JSON messages back.
8. `offscreen.js` normalizes the payload into a simpler internal event shape:
   - `text`
   - `isFinal`
   - `ts`
9. `offscreen.js` suppresses duplicate interim or final repeats.
10. `offscreen.js` sends `MSG.OFFSCREEN_TRANSCRIPT` to the service worker.
11. `service_worker.js` forwards `MSG.DG_TRANSCRIPT` to the content script.
12. `contentScript.js` updates either:
   - the interim line
   - or the final line buffer

### Stop flow

1. The user clicks Stop.
2. `popup.js` sends `MSG.STOP_SESSION`.
3. `service_worker.js` forwards `MSG.STOP` to the offscreen document.
4. `offscreen.js` sets state to `stopping`.
5. `offscreen.js` optionally asks Deepgram to finalize pending audio before closing.
6. `offscreen.js` closes the socket and tears down audio resources.
7. `offscreen.js` tells the content script to clear the interim line.
8. `offscreen.js` sets final state to `idle`.
9. `service_worker.js` receives `MSG.OFFSCREEN_STATE`.
10. When the final state is `idle` or `error`, the worker closes the offscreen document.


## Detailed Message Protocol

The canonical message names live in `constants.js`.

### Popup to service worker

- `ENSURE_OFFSCREEN`
  - currently used as a status-style query in the worker
  - returns whether the offscreen document already exists

- `START_SESSION`
  - starts a new capture and transcription session
  - payload includes `tabId` and full config

- `STOP_SESSION`
  - stops the active session

- `APPLY_SETTINGS`
  - applies overlay settings to the current or explicit tab

- `GET_STATUS`
  - returns the worker's current state and tab id

### Service worker to offscreen

- `START`
  - start media capture and Deepgram streaming

- `STOP`
  - stop capture and clean up

These messages include `target: "offscreen"` so the worker and offscreen can separate internal commands from popup or tab messages.

### Offscreen to service worker

- `OFFSCREEN_STATE`
  - updates the global session state

- `OFFSCREEN_ERROR`
  - reports user-facing error conditions

- `OFFSCREEN_TRANSCRIPT`
  - carries normalized transcript events

- `OFFSCREEN_CLEAR_INTERIM`
  - asks the worker to clear the current interim line in the tab

- `OFFSCREEN_CLEAR_ALL`
  - asks the worker to clear all subtitle text

### Service worker to content script

- `APPLY_SETTINGS`
  - updates visual overlay settings

- `DG_TRANSCRIPT`
  - carries one transcript event

- `CLEAR_INTERIM`
  - clears the interim text line

- `CLEAR_ALL`
  - clears all lines

- `REMOVE_OVERLAY`
  - supported by the content script for removal behavior

### Service worker to popup

- `STATE`
  - broadcast state updates

- `ERROR`
  - broadcast error updates

The popup listens for those messages and updates the visible status indicator.


## State Machine

The shared state values live in `constants.js`.

States:

- `idle`
- `creating_offscreen`
- `awaiting_capture_permission`
- `capturing`
- `connecting_deepgram`
- `listening`
- `stopping`
- `error`

Typical happy-path progression:

`idle -> creating_offscreen -> awaiting_capture_permission -> capturing -> connecting_deepgram -> listening -> stopping -> idle`

Failure progression:

`any active state -> error`

Important nuance:

- the popup displays state
- the service worker tracks state
- the offscreen document is the source of truth for live session transitions once capture begins


## Audio Pipeline In Detail

This is the most technical part of the project.

### Capture source

`offscreen.js` calls `getDisplayMedia()` with:

- browser-tab-oriented capture settings
- audio enabled
- processing flags such as `echoCancellation`, `noiseSuppression`, and `autoGainControl` turned off

This is intentional because:

- the source is already tab audio, not a microphone
- additional browser voice cleanup can distort the signal

### Wrong-source protection

After capture starts, the code inspects the track labels to detect whether the user accidentally selected the extension page itself instead of the anime tab.

If it detects the extension page, it:

- stops the tracks
- reports `WRONG_CAPTURE_SOURCE`
- returns to idle

### Audio graph

The audio graph is:

`captured MediaStream -> MediaStreamAudioSourceNode -> AudioWorkletNode -> silent GainNode -> AudioContext.destination`

Why route to a silent gain node and destination?

- it keeps the graph alive
- it avoids audible playback because gain is `0`

### Worklet processing steps

Inside `audio-worklet.js`, audio is processed like this:

1. receive input frames from Chrome
2. average all channels into one mono sample
3. apply a low-pass filter
4. resample from the browser sample rate to `16 kHz`
5. convert each sample from `Float32` range `[-1, 1]` to signed `Int16`
6. accumulate samples into fixed-size chunks
7. estimate chunk RMS energy
8. decide whether to send, hold, or drop the chunk based on VAD logic
9. post chunk buffers back to `offscreen.js`

### Resampling

The worklet uses a streaming interpolation approach instead of growing and slicing large arrays.

That design was chosen because:

- it reduces allocation pressure during long sessions
- it is more stable under continuous streaming
- it avoids repeated copying of source buffers

### Voice activity handling

This is not a full speech-recognition VAD system, but a lightweight energy gate.

It supports:

- `vadEnabled`
- `vadThreshold`
- `vadHangoverMs`
- `vadPreRollMs`

Behavior:

- when RMS is below threshold and hangover is exhausted, chunks are not immediately sent
- a short pre-roll buffer is kept so the beginning of speech is not chopped off
- once speech is detected, pre-roll is flushed first
- after speech ends, hangover keeps a few chunks flowing briefly so the tail is not cut too abruptly

This helps reduce unnecessary silence traffic while preserving intelligibility.


## Deepgram Integration

Deepgram is used via WebSocket streaming.

### Endpoint

- `wss://api.deepgram.com/v1/listen`

### Auth

The WebSocket is created as:

- `new WebSocket(url, ["token", apiKey])`

This avoids putting the API key directly into the URL.

### Query parameters

`offscreen.js` currently sends options such as:

- `model`
- `language=ja`
- `encoding=linear16`
- `sample_rate=16000`
- `channels=1`
- `interim_results=true`
- `endpointing`
- optionally:
  - `utterance_end_ms`
  - `vad_events`
  - `smart_format`

### Keepalive

While connected, `offscreen.js` sends periodic Deepgram keepalive messages every `8000 ms`.

### Finalization

When stopping a normal session, the extension can send a Deepgram `Finalize` message and briefly wait for a last final transcript before closing the socket.

That is what `FINALIZE_GRACE_MS` is for.

### Retry strategy

The code includes bounded reconnect logic:

- max attempts: `3`
- delays: `1000 ms`, `2000 ms`, `4000 ms`

This is useful for transient network failures.

If reconnect attempts are exhausted, the session moves to `error`.

### Backpressure protection

Before sending binary audio, `offscreen.js` checks `websocket.bufferedAmount`.

If buffered bytes exceed `BACKPRESSURE_LIMIT_BYTES`, the chunk is dropped rather than allowing the browser buffer to grow without bound.

This prevents runaway memory growth and helps preserve near-real-time behavior.


## Transcript Handling

Deepgram messages are too provider-specific to expose directly to the overlay.

So `offscreen.js` normalizes them to:

```js
{
  text: "...",
  isFinal: true | false,
  ts: 1710000000000
}
```

### Interim handling

- interim results update the current live line
- they do not enter subtitle history
- repeated interim text is suppressed if unchanged

### Final handling

- final results are committed to the final line history
- repeated identical finals are suppressed
- the interim line is cleared when a final result replaces it

### Why duplicate suppression exists

Streaming STT providers often resend the same or nearly the same interim text many times.

Without suppression:

- the overlay would update more than necessary
- the DOM would churn
- the UI could flicker


## Overlay Rendering And Yomitan Compatibility

The overlay is deliberately built as normal DOM text.

### Why this matters

Yomitan and similar tools are much more likely to work with:

- plain text nodes
- ordinary DOM elements
- visible page content

They are less reliable with:

- canvas-rendered text
- browser-native subtitle tracks
- shadow DOM in some cases

### Overlay structure

The content script creates:

- one root overlay container
- a toolbar
- a line group
- `N` final-line divs
- one interim-line div

### Stability choices

The overlay is designed to be stable:

- nodes are reused
- text content changes in place
- line containers are rebuilt only when line count changes

This is good for:

- performance
- predictable selection behavior
- less flicker

### Overlay controls

The overlay includes a small toolbar:

- drag handle
- close button

These are implemented entirely in the content script.

### Dragging behavior

When the user drags the overlay:

- the default bottom-centered position is replaced with explicit `left` and `top`
- the position is stored in in-memory content script state
- it is not currently persisted across page reloads

### Removing the overlay

The user can remove the overlay from the page using the toolbar button.

Internally this:

- removes the root DOM node
- clears cached node references
- clears the subtitle history

If the service worker later sends a new message, `ensureRoot()` will recreate the overlay.


## Storage Model

This extension uses `chrome.storage.local`.

Current saved values:

- `deepgramApiKey`
- `overlay.lines`
- `overlay.fontSize`
- `overlay.opacity`
- `overlay.showInterim`

### What is not persisted

- current session state
- active tab id
- drag position
- transcript history

Those are runtime-only values.


## Session Object In `offscreen.js`

The offscreen file uses a `session` object to bundle all live resources.

It currently tracks things like:

- `tabId`
- `config`
- `displayStream`
- `audioContext`
- `sourceNode`
- `workletNode`
- `silenceNode`
- `websocket`
- `reconnectAttempt`
- `reconnectTimer`
- `keepAliveTimer`
- `backpressureWarned`
- `finalizeResolve`

Why this matters:

- it makes stop and cleanup logic much easier
- it prevents resource leaks
- it creates one place to represent the live session


## Error Handling

The code handles multiple failure scenarios explicitly.

### Common errors

- `NO_API_KEY`
  - no API key provided

- `CAPTURE_DENIED`
  - user denied the screen/tab-sharing prompt

- `NO_AUDIO_TRACK`
  - the selected source did not provide shared audio

- `WRONG_CAPTURE_SOURCE`
  - the user selected the extension page rather than the anime tab

- `DG_AUTH`
  - Deepgram authentication failed

- `DG_PARSE`
  - transcript payload could not be parsed

- `DG_CLOSED`
  - Deepgram connection closed after retries or unexpectedly

- `START_FAILED`
  - generic startup failure

### Error propagation path

`offscreen.js -> service_worker.js -> popup.js`

The offscreen document reports errors to the worker with `MSG.OFFSCREEN_ERROR`.
The worker rebroadcasts them as `MSG.ERROR`.
The popup displays them in the status area.


## Offscreen Document Lifecycle

The offscreen document is not meant to stay alive forever.

### Creation

It is created by the service worker when a session starts and no offscreen context exists.

### Use

It remains alive while capture and streaming are active.

### Destruction

The service worker closes it when the session reaches:

- `idle`
- `error`

This keeps the extension cleaner and avoids leaving hidden extension pages around after work is done.


## Tab Navigation And Reinjection

One subtle but important feature exists in `service_worker.js`:

- `chrome.tabs.onUpdated`

If the active tab reloads or navigates while a session still exists:

- the worker re-injects the content script
- the worker reapplies the last overlay settings

Why this exists:

- content scripts are tied to the page
- when the page reloads, the previous injected overlay is gone
- the worker must put it back


## Security And Privacy Model

### What stays local

- popup UI state while open
- overlay DOM rendering
- audio transformation in the worklet and offscreen document
- API key storage in `chrome.storage.local`

### What leaves the machine

- captured tab audio, converted to PCM, is sent to Deepgram

### What is not implemented here

- a proxy server to hide the API key
- short-lived token minting
- server-side transcript storage

This is a client-side architecture optimized for simplicity and MVP speed.

### Security tradeoff

Storing the API key in a browser extension is practical for personal use but is not a strong secret management boundary for broad distribution.


## Common Questions And Answers

### Why does the extension need the user to pick a tab?

Because Chrome requires explicit user consent for display and tab capture. The extension cannot silently capture arbitrary tab audio.

### Why do subtitles not appear instantly the moment Start is clicked?

Because the system must complete several steps:

- create or reuse the overlay
- obtain capture permission
- build the audio graph
- connect to Deepgram
- accumulate enough streamed audio for meaningful interim text

### Why can there be a delay of around a second?

Because total latency is the sum of:

- browser capture buffering
- chunking interval
- network transit
- Deepgram processing time
- interim/final update timing
- UI render timing

### Why are subtitles selectable?

Because they are rendered as ordinary HTML text nodes, not canvas graphics.

### Why does the overlay disappear on page reload?

Because content scripts live inside the page. The service worker re-injects the overlay after navigation if the session is still active.

### Why might Start be disabled?

Because:

- there is no valid-looking API key
- or the extension is already in an active session state

### Why might Stop be disabled?

Because the extension is not currently in an active capture/streaming state.

### Why is there a silent gain node connected to destination?

To keep the audio graph alive without creating audible output.

### Why is the API key not in a backend?

Because this project is intentionally built as a lightweight extension MVP with no server infrastructure.


## Important Design Patterns Used In The Code

### Idempotent content script bootstrap

`contentScript.js` uses a guard so repeated injection does not create duplicate message listeners or duplicate overlays.

### Centralized message constants

`constants.js` is the shared protocol contract.

### Stable DOM updates

The overlay updates text in existing nodes rather than constantly rebuilding the entire DOM.

### Centralized resource cleanup

`offscreen.js` groups live resources into a session object and disposes them through shared cleanup logic.

### Separation of concerns

- popup handles UI
- worker handles orchestration
- offscreen handles live media and networking
- worklet handles audio conversion
- content script handles page rendering


## Limitations And Non-Goals

This project is strong as an MVP, but it has limits.

### Current limitations

- no backend token service
- drag position is not persisted
- transcript history is not persisted
- no automated tests in this repo yet
- no analytics or usage telemetry
- VAD is lightweight and heuristic, not a sophisticated speech segmentation model
- no explicit multi-tab session management
- one active session model only

### Implicit behavior to remember

- if the socket is under heavy backpressure, chunks can be dropped
- if the user forgets to share audio, transcription cannot work
- if Deepgram reconnects repeatedly, final latency can rise or state may bounce between connecting and listening


## How To Debug This Project

If you need to troubleshoot runtime behavior, inspect each context separately.

### Popup debugging

Check:

- whether settings load correctly
- whether Start and Stop button states match current status
- whether error messages reach the popup

### Service worker debugging

Check:

- whether the worker receives `START_SESSION`
- whether it injects the content script
- whether it creates and closes the offscreen document correctly
- whether transcript relay messages reach the tab

### Offscreen debugging

Check:

- whether `getDisplayMedia()` returns a real audio track
- whether the Web Audio graph is built
- whether the WebSocket opens
- whether reconnect attempts are happening
- whether transcript payloads are parsed

### Worklet debugging

Check:

- whether `PCM_CHUNK` messages are posted
- whether RMS values look plausible
- whether VAD is too aggressive or too permissive

### Content script debugging

Check:

- whether the overlay root exists in the page
- whether final and interim nodes are present
- whether messages update `textContent`
- whether drag and close controls work


## How To Extend The Project Safely

If you want to add features, the architecture already tells you where they should go.

### Add more popup settings

Put them in:

- `popup.html`
- `popup.js`
- `chrome.storage.local`
- pass them through the worker to offscreen or content script as needed

### Change subtitle visuals

Put that in:

- `contentScript.js`

### Change audio chunking or VAD behavior

Put that in:

- `audio-worklet.js`
- optionally the config sent by `popup.js`

### Change Deepgram connection settings

Put that in:

- `offscreen.js`

### Add more session states or new protocol messages

Update:

- `constants.js`
- then every sender and receiver that depends on the message

### Add a proxy backend later

The best insertion point is around the transport/auth path in `offscreen.js`.
The popup, content script, and most of the worker code should not need major changes if the transport layer is abstracted carefully.


## Mental Model To Keep In Your Head

If you only remember one model, remember this:

- `popup.js` is the remote control
- `service_worker.js` is the traffic controller
- `offscreen.js` is the engine room
- `audio-worklet.js` is the audio converter
- `contentScript.js` is the subtitle renderer
- `constants.js` is the shared language they all speak

And the core runtime loop is:

`user starts session -> worker prepares tab and offscreen -> offscreen captures audio -> worklet emits PCM -> Deepgram transcribes -> worker relays transcript -> content script updates overlay`


## Short Summary

This program is a Chrome MV3 extension that turns shared tab audio into live Japanese subtitles on the page. It uses a popup for controls, a service worker for orchestration, an offscreen document for capture and networking, an AudioWorklet for PCM conversion and light voice gating, and a content script for rendering a selectable subtitle overlay that browser-based dictionary tools can read.

That is the entire system in one sentence.
