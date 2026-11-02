# Diagnostics

One button, one blob of text, enough evidence to diagnose without a second
round-trip. The popup's **Copy diagnostics** button is the supported way to
report a failure.

```
popup → Copy diagnostics → paste
```

That is the whole workflow. No DevTools, no `chrome://extensions` hunting, no
"can you open the console and screenshot it". The report is redacted by
construction — see [Privacy contract](#privacy-contract) — so it is safe to
paste into a public issue.

The implementation is three files: `diagnostics.js` (the shared capture and
renderer), instrumentation at the points that already compute something
interesting in `offscreen.js` / `service_worker.js`, and the merge in `popup.js`.

---

## What the report contains

Every section exists because it answers a question that someone actually asked
during debugging. If a section stops paying rent, delete it.

### `[build]`

```
extension  0.3.1
chrome     Google Chrome 156.0.7443.45
platform   Windows
locale     en-US
popup state awaiting_capture_permission
```

The first thing any maintainer needs, and the thing users get wrong most often
("I'm on the latest version" is usually false). The version comes from the
user-agent client hints, not the user agent string: UA reduction froze the build
to `0.0.0`, so `Chrome/156.0.0.0` is what the raw UA reports and it cannot
distinguish a patch release. ORT behaviour, WebGPU availability and offscreen
document semantics all move between builds, so the real build is the one worth
printing.

`popup state` is what the UI was showing. It is compared against the mirrored
service worker state later; a mismatch is a real bug, not a rendering glitch.

### `[capabilities]`

```
crossOriginIsolated false
hardwareConcurrency 8
deviceMemory GB    8
sharedArrayBuffer  function
webgpu             adapter: nvidia ampere
offscreen document answering
```

`crossOriginIsolated` is the single most consequential bit in the file. The
manifest declares COEP/COOP to enable it, which is what allows 4 WASM threads
instead of 1 — a 3× difference in decode speed that is completely invisible in
the UI. `webgpu` is probed by actually requesting an adapter, because "the user
has a GPU" and "WebGPU can reach it" are different questions. The adapter name
is included so a "why is it slow on my machine" report can be answered from the
text alone.

`offscreen document` reports whether that context answered the probe at all, not
whether the worker believes it exists. The difference matters when the worker is
the thing that is broken.

### `[queries]`

```
worker       failed: no response (1ms)
offscreen    ok 1ms
session keys ok 1ms
```

One line per channel the popup used, with outcome and latency. This section
exists because the alternative — a bare `query failed` next to empty sections —
is unanswerable. The three channels are independent:

| Channel | Reaches | Fails as |
|---|---|---|
| `worker` | `GET_DIAGNOSTICS` on the service worker | `{ok:false,error}` from the worker's catch, a rejection ("message port closed"), or `no response` when nothing called `sendResponse` |
| `offscreen` | the offscreen document directly, `target:"offscreen"` | `Could not establish connection` when the document is gone |
| `session keys` | `chrome.storage.session` read by the popup itself | a storage permission or quota error |

`session keys` is why a dead service worker no longer costs you the post-mortem:
the popup reads the mirrored `sw.*` keys directly instead of asking the worker
to read them. Any one channel can fail and the report still carries the rest.

### `[service worker]`

```
state (mirrored)   awaiting_capture_permission
tabId (mirrored)   41
mirrored at        2026-11-01T17:19:41.202Z
boots (total)      3
sw boot (live)     t5sb7iw0
sw boot (mirrored) k3p0q1zd
popup boot         xp8b37fd
mirror keys        6 present
```

`boots` is a counter persisted in `chrome.storage.session` and incremented on
every worker start. MV3 terminates the service worker after ~30 s idle, so a
diagnosis that ignores restarts will confidently explain the wrong thing. If
`boots` is high and `state (mirrored)` says `idle` while the overlay is still
drawing text, the answer is "the worker restarted and lost its state", not
"the overlay is stuck".

The three boot ids settle it outright: `sw boot (live)` is the worker instance
that answered, `sw boot (mirrored)` is the one that last wrote state. When they
differ, the worker has restarted since the last state transition, and `sw boot
(live)` reading `not read` means the worker never answered at all — in which
case the mirrored values are the only evidence left.

### `[engine]`

Flattened fields from the offscreen document: model paths, input names, load
times, thread count, decode cadence, PCM counters, VAD counters.

The two that settle most arguments:

- `engine.threads` — 1 vs 4 explains a 3× speed difference.
- `vad.speechFrames` / `vad.idleFrames` — if `speechFrames` is 0 while audio is
  playing, the VAD input contract is wrong, and no amount of ASR tuning will
  help. That is exactly the shape of the bug that made the interim line never
  render: the VAD was returning ~0.001 on everything, silently.

### `[timings]`

```
offscreen.asr.inferMs n=42 last=210.4ms mean=210.0ms max=380.1ms
```

Count, last, mean, max per instrumented call site. The mean is not the useful
number — `max` is. A mean of 210 ms with a max of 380 ms against a 750 ms step
is healthy; a mean of 210 ms with a max of 2400 ms is a machine that will drop
audio, and the mean hides it.

Deliberately measured *inside* the ASR lock, so this is inference cost and not
queueing delay. Those are different failures with different fixes.

### `[last emissions]`

```
15:52:27.360 FINAL   "そうだね" audio=4.2s asr=210ms
```

The last three things the committer believed. When a user says "it said
something wrong", this is the difference between a decoding problem and a
rendering problem, and it costs three lines of memory.

### `[errors]`

```
offscreen START_FAILED
message  no available backend found
stack    Error: boom |   at dr |   at e.create
```

Code, message, and the first four stack frames on one line (newlines in a
report that gets pasted into chat are a readability disaster). If the context
that raised the error is already gone, the source is labelled
`sw (restored)` — see [MV3 traps](#mv3-traps).

### `[events]`

A bounded ring of the last 60 log lines from all three contexts — service
worker, offscreen document, and the popup itself — merged and sorted by time.
This is the section that usually contains the answer, because it includes
`console.warn`/`console.error` output that nobody thought to instrument, plus
uncaught errors and unhandled rejections.

```
15:51:59.773 state  sw        sw           state -> creating_offscreen
15:52:03.773 warn  offscreen  console      [AnchoredCommitter] Decode error: boom
15:52:03.775 warn  popup     popup        worker: no response (1ms)
```

The popup is included because it is the only context guaranteed to be alive when
the button is pressed. Leaving it out meant that when both other contexts failed,
the one context that *knew why* (its own failed `sendMessage`) contributed
nothing to the report.

---

## Triage: symptom → section → cause

| What you see | Read | Usually means |
|---|---|---|
| `[queries]` has any `failed:` line | `[queries]` | That channel is the bug, not the pipeline. `worker: no response` = the worker answered nothing; `offscreen: Could not establish connection` = the document is gone. |
| Red dot, `[START_FAILED] no available backend found` | `[errors]` | ORT cannot load its wasm artifact. Check the `lib/` companion files exist — this exact failure was a deleted `ort-wasm-simd-threaded.jsep.mjs`. |
| Red dot, `[CAPTURE_DENIED]` | `[errors]` | The user cancelled the share picker. Not a bug. |
| Red dot, `[NO_AUDIO_TRACK]` | `[errors]` | The tab was shared without "Share audio", or has no audio at all. |
| Red dot, `[WRONG_CAPTURE_SOURCE]` | `[errors]` | The user shared the extension's own page or a surface with no audio. |
| `Listening` but no text ever appears | `[engine]` | `vad.speechFrames` = 0 → VAD input is wrong. `asr.decodes` = 0 → the utterance never opened. |
| Text appears, then stops after a few seconds | `[timings]` | `asr.inferMs.max` far above `engine.decodeStepMs` → the machine cannot keep up, and the PCM queue is dropping the oldest audio by design. |
| Text is delayed and drifting | `[last emissions]` | Compare `audio=…s` against wall clock; a growing gap is backlog, not model latency. |
| Duplicated or scrambled lines | `[last emissions]` | Look at the `GROW` / `REVISE` / `FINAL` sequence for one `lineId`. |
| Popup says Idle while subtitles still draw | `[service worker]` | `boots` incremented → the worker restarted and lost in-memory state. |
| `sw boot (live)` differs from `sw boot (mirrored)` | `[service worker]` | The worker restarted since it last wrote state. The mirrored values are one generation stale, not wrong. |
| "It works on my machine but not theirs" | `[capabilities]` | Threads, isolation, WebGPU adapter, core count. |

---

## Error codes

Codes are stable; messages are not. Lead a bug report with the code.

| Code | Raised when | User action |
|---|---|---|
| `CAPTURE_DENIED` | The share picker was dismissed. | Press Start again. |
| `NO_AUDIO_TRACK` | No audio track in the captured stream. | Re-share with **Share audio** enabled. |
| `WRONG_CAPTURE_SOURCE` | The captured surface is the extension itself. | Share the video tab, not the popup. |
| `START_FAILED` | Anything else in the start path. `message` carries the detail. | Send the diagnostics report. |
| `AUDIO_PROCESS_ERROR` | The PCM/VAD pipeline threw mid-session. | Send the diagnostics report. |

---

## Privacy contract

What is **not** in the report, by construction:

- no tab URLs, tab titles, or page content
- no audio samples, transcripts beyond the last three short emissions
- no cookies, tokens, or storage values other than the six `sw.*` diagnostic keys
- no file paths outside the extension package

What is in it: a version string, a Chrome version, a platform string, hardware
capability booleans, counters, timings, the last three short transcript lines,
error text, and up to 60 log lines.

The one judgement call is `tabId`. It is an ephemeral integer that means nothing
outside this browser session and cannot be turned into a URL. It is included
because "which tab" is otherwise unanswerable.

The last-three-emissions section does contain Japanese text. If that is
unacceptable for a given report, it is three lines at the top of the pasted
block and can be removed by hand.

---

## Why it is built this way

Eleven rules, each one earned by a specific failure mode. The last one was earned
the hard way: the first live report came back with `offscreen present query
failed` and five sections of `?`, because one failed call took everything with
it and the error text was discarded on the way.

**1. One click, one blob.** If collecting diagnostics takes more than one
action, most users do not do it, and the reports you get are from the users who
least need help. Firefox's `about:support` is the reference: a wall of text and
a single "Copy text to clipboard" button.

**2. Context beats the exception.** `chrome://gpu` exists because "WebGL is
broken" is unanswerable without the driver string. An error message names a
symptom; the state around it names the cause. This is why `[capabilities]` and
`[service worker]` are in a report about a failed decode.

**3. Bounded, always.** Every buffer here has a hard cap (60 events, 400 chars
each, 24 KB total). Unbounded logging is how a diagnostic feature becomes a
memory leak that only appears in long sessions — the exact sessions users
report.

**4. Capture at failure, not on demand.** By the time someone clicks Copy, the
evidence is usually gone. The ring buffer is written continuously so the answer
exists before the question is asked. Crash reporters (`crashpad`, `sysdiagnose`)
work the same way: they persist first, ask later.

**5. Survive the context that produced it.** The offscreen document is destroyed
by the very error path that matters most. Anything that only exists in that
document is useless for post-mortems, which is why the last error and the state
are mirrored to `chrome.storage.session` before teardown.

**6. Fixed shape, versioned.** Same section order, same key order, an explicit
`v1`. Two reports from two machines should diff cleanly, and an old report
should still parse after the format changes. Home Assistant's integration
diagnostics do this well: versioned JSON, one download button per integration,
secrets redacted by key name.

**7. Redact by construction, not by review.** Never collect it in the first
place. A redaction pass that runs at export time will eventually miss a field;
a capture path that never touches URLs cannot leak one.

**8. Text, not a file, when the channel is a chat window.** A `.zip` is the
right artifact for a support desk and the wrong one for a GitHub issue. Copyable
text pastes into Discord, an issue, or an email with no friction — which is why
`about:support` and `ffmpeg -report` both end up as text.

**9. Include the trail.** Sentry's breadcrumbs are a bounded ring of the events
leading to an error, and they are usually more useful than the stack. `[events]`
is the same idea, scoped to one extension.

**10. Never require DevTools.** The target user of this feature is watching
anime, not debugging a service worker. If they have to open a console, the
feature has failed.

**11. Degrade per source, never all-or-nothing.** Every channel is probed
independently and reports its own outcome, and no channel is trusted to carry
data another channel can fetch for itself. The popup reads `chrome.storage.session`
directly instead of asking the worker to read it, and addresses the offscreen
document directly instead of asking the worker to relay. A report is assembled
by a context that may be the only survivor, so it must never have a single point
of failure — and when a probe fails, the failure *is* the finding: `worker:
failed: no response` is a diagnosis, `query failed` is a shrug.

### Where other products do the same thing

| Product | Mechanism | What to steal |
|---|---|---|
| Firefox `about:support` | Full text dump + *Copy text to clipboard* | The one-button UX; including build and graphics config |
| `chrome://gpu` | Driver/feature matrix as text | Capability probing over capability assumptions |
| Home Assistant | Per-integration *Download diagnostics* (versioned JSON, secrets redacted) | Versioned format, redaction by key |
| Sentry | Breadcrumbs — bounded ring of pre-error events | The `[events]` section |
| VS Code | *Report Issue* prefills system info into a GitHub issue | Meeting the user where the report goes |
| `sysdiagnose` / `adb bugreport` | Persist everything to disk before you need it | Capture-before-ask |
| `ffmpeg -report` | Writes a full log next to the crash | Zero-friction artifact creation |
| OBS | *Upload current log* → returns a URL | Removing copy/paste entirely, once you have a backend |

---

## Anti-patterns this avoids

- **"Please send a screenshot of the console."** Truncated, unsearchable,
  unquotable, and usually of the wrong context (the popup's console instead of
  the offscreen document's).
- **Unbounded logs.** A `console.log` in a 30 fps path is a memory leak with a
  debugging UI.
- **Logging the exception only.** `Error: TypeError` with no state is not a bug
  report, it is a riddle.
- **PII in logs.** Tab titles are the classic offender — they identify what a
  person was watching.
- **Saying a query failed without saying how it failed.** `query failed` is what
  the first version of this report printed when the service worker returned
  `{ok:false, error:"Unknown message type."}`; the answer was in the response and
  the renderer dropped it on the floor.
- **One collection call for the whole report.** Awaiting every context through a
  single `sendMessage` means one dead context blanks the entire file, including
  sections whose data was still reachable.
- **Relying on state that dies with the process.** See below.
- **A report button that requires the failing state to still be alive.** By
  definition it is not.

---

## MV3 traps

Two of these are specific to Manifest V3 and both were live risks in this
codebase before diagnostics existed.

**The service worker is not a process.** It is terminated after ~30 s idle and
restarted on the next message. `currentState` and `activeTabId` live in module
memory, so a restarted worker reports `idle` while the offscreen document is
still capturing. `boots` and `sw.state` in `[service worker]` make that visible
instead of letting it silently reset the UI.

**The offscreen document dies with the error.** `OFFSCREEN_ERROR` closes the
document, which destroys its ring buffer, including the stack that explains the
failure. The worker therefore records the error itself and mirrors it to
`chrome.storage.session` *before* the teardown, and the report labels a
surviving copy `sw (restored)`.

**The popup is not alive either.** It closes on blur. A report has to be
assembled on demand from contexts that may be gone, which is why the popup
queries the worker and the worker queries the offscreen document, instead of
each context pushing into shared state.

---

## Adding a field

One line at the point where the value already exists:

```js
DIAG.set("asr.maxWindowS", MAX_UTTERANCE_SAMPLES / TARGET_SAMPLE_RATE);
```

Use `DIAG.bump()` for counters, `DIAG.sample("name", ms)` for durations,
`DIAG.mark(scope, text)` for lifecycle transitions, and
`DIAG.addTranscript(event)` for emissions.

Rules for new fields:

1. Never put a URL, a title, or page-derived text in a field.
2. Cap sizes at the capture site; do not rely on the renderer.
3. Name fields `namespace.thing` — the renderer sorts them, so the namespace is
   what makes a report readable.
4. If it cannot change a diagnosis, it does not belong in the report.

If a new file is added to the extension, `package.ps1` will fail until it is in
the allowlist; that check reads the script graph rather than trusting the list.

## Format versioning

`REPORT_VERSION` in `diagnostics.js` is the wire version, printed on line 1.
Bump it for a breaking change (a renamed or removed section). Adding a field or
a section does not need a bump, because consumers read sections they know and
ignore the rest.

## Limits

- The report reflects the *current* context instances. If a worker restarted
  three times, only the latest boot's ring buffer survives; `boots` tells you
  that earlier ones existed but not what they saw.
- `asr.inferMs.max` is per-session, not per-utterance, so it cannot isolate a
  single pathological window. Use `[last emissions]` for that.
- There is no automatic upload. Reports are copied, not sent. Adding a backend
  is the only reason to change that.
