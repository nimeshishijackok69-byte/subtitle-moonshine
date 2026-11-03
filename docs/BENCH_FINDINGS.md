# Bench Findings — append-only log

Every finding here was measured on real audio with the shipped model and the
shipped feature frontend. New entries go at the bottom of §4 with an id
(`F-NNN`), the date, and the evidence. If a finding turns out to be wrong, add a
correction entry rather than editing history — the point is not to repeat the
mistake.

Related: `docs/PLAN_10X.md` (hypotheses this bench exists to test).

---

## 1. How to run

```powershell
cd subtitle-moonshine\bench
npm install                         # onnxruntime-node (see F-002 if the binary is missing)
node smoke.mjs                      # doctor check: model loads, one decode runs

# one strategy on one clip
node run.mjs --audio "<raw>" --strategy current --beam 1 --limit 120 --out out/x.json --label baseline

# every strategy x beam on one clip, model loaded once
node matrix.mjs --audio "<raw>" --limit 60 --threads 4 --out out/matrix.json

# a full sweep, one process per strategy, with a hard wall-clock kill (F-007)
powershell -NoProfile -ExecutionPolicy Bypass -File sweep.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File sweep.ps1 -Strategies final8 -Beams "1,8" -Repeats 3 -OutDir out\beam
powershell -NoProfile -ExecutionPolicy Bypass -File sweep.ps1 -Strategies current,fixed2s750,final8 -Threads 1 -OutDir out\threads-t1

# score against a reference transcript (produced later by a stronger model)
node compare.mjs --reference ep01.srt --hypothesis out/ep01_current.txt
```

Run sweeps through `sweep.ps1`, not a `foreach` loop. It starts each strategy as
its own process, kills anything that overstays, and records `ok` / `EXIT HANG` /
`TIMEOUT` per configuration. A bare loop will silently stall on the first process
that cannot exit, which is not hypothetical (F-007).

Audio input is raw `s16le`, 16 kHz, mono — the exact format the extension feeds
its frontend. Convert with:

```powershell
ffmpeg -i episode.mp3 -f s16le -ar 16000 -ac 1 ep01.raw
```

All decodes go through `sensevoice-frontend.js` and
`models/sensevoice/model.int8.onnx` from the repo root. The bench never
re-implements feature extraction, so a frontend change is measured the moment
it lands.

---

## 2. Corpus

11 × ~23:40 Japanese audio (Mushoku Tensei S1 E01–E11, 48 kHz stereo MP3),
converted to 16 kHz mono. Two stray files in the same folder (`scene1.mp3`,
`test_intro.mp3`) are not valid MPEG audio and must be excluded (see F-003).

Reference subtitles are **not available yet**. Until an offline SOTA model
(Whisper large-v3 or better, produced separately) generates them, the accuracy
signal is:

- cross-strategy/cross-beam agreement (CER between variants),
- stability of committed text over progressive ticks,
- manual spot-checks of the transcript.

Absolute CER requires the reference and will be filled in later.

---

## 3. Metrics (definitions used in every table)

| Metric | Definition |
|---|---|
| `computeOverRealtime` | audio-seconds decoded ÷ audio-seconds of clip. **1.0 = one decode pass per real second.** This is the number that decides whether a machine can keep up; latency is a separate axis. |
| `p50InferMs` / `p95InferMs` | wall time of one `session.run` + feature extraction, percentiles |
| `wallSec` | total wall time to process the clip |
| `realTimeFactorOfWholeRun` | wall seconds ÷ clip seconds; < 1.0 means faster than real time |

**Why `computeOverRealtime` matters more than latency:** a 750 ms cadence with a
growing 8 s window re-decodes ~5–6× more audio than exists. That is a structural
cost independent of how fast the model is — the reason WebGPU alone cannot be
the whole 10×.

Environment: Windows, Node v26.12.1, 4-core CPU, `onnxruntime-node` 1.31.1
(CPU EP). Browser WebGPU numbers must be measured separately — Node has no
WebGPU EP.

---

## 4. Findings

### F-001 — The model hallucinates text on pure silence (2026-11-02)

Evidence: `smoke.mjs` decodes 2 s of digital silence and returns `"こ。"`.

Consequence: every silence/music stretch that reaches `runAsr` produces a
plausible-looking Japanese line. VAD gating is not an optimization here — it is
the only thing standing between the user and constant fake subtitles, and any
future "reduce VAD cost" work must preserve onset sensitivity (see F-004).
Accuracy metrics computed on un-VAD-gated audio will be meaningless.

### F-002 — npm ≥ 11 silently blocks onnxruntime-node's native binary (2026-11-02)

Evidence: `npm install` exits 0, prints `npm warn install-scripts ... onnxruntime-node (postinstall)`, and leaves `bin/napi-v6/win32/x64` without the `.node` binding. Requiring the module then fails at first `InferenceSession.create`.

Fix: `npm install-scripts approve onnxruntime-node` then `npm rebuild onnxruntime-node` (or approve before installing). Check with `node bench/smoke.mjs` — if it prints inputs, the binary is real.

### F-003 — The audio folder contains non-audio files (2026-11-02)

Evidence: conversion loop hit `Failed to find two consecutive MPEG audio frames` on `scene1.mp3` and `test_intro.mp3` (0 MB placeholders). Harmless for the bench as long as the loop fails loudly rather than emitting a 0-byte `.raw`, which would later look like "model produced no text".

Rule: treat a `ffmpeg` non-zero exit as fatal for that file, and never consume a `.raw` under 1 MB.

### F-004 — The "fixed short window reduces compute" assumption in PLAN_10X is wrong (2026-11-02)

**This corrects the plan.**

Measured, ep01 first 60 s, 4 threads, `onnxruntime-node` CPU:

| Strategy | Decodes | `computeOverRealtime` | p50 infer | p95 infer | wall for 60 s |
|---|---|---|---|---|---|
| `current` (growing window, 750 ms hop) | 82 | **6.25×** | 567 ms | 1370 ms | 53.2 s |
| `fixed2s250` (2 s window, 250 ms hop) | 233 | **7.77×** | 229 ms | 373 ms | 58.1 s |
| `fixed1s5_250` (1.5 s, 250 ms) | 235 | **5.88×** | 175 ms | 297 ms | 45.8 s |
| `final8` (one pass per 8 s) | 8 | **1.00×** | 883 ms | 1039 ms | 6.8 s |

`computeOverRealtime ≈ window ÷ hop`. A fixed window only reduces work if the
hop grows with it; at a 250 ms hop a 2 s window costs **more** per second of
audio than the current 750 ms growing-window loop. The plan claimed fixed
windows would buy 3–5×; the measurement says −25 % (i.e. worse) at equal hop.

What actually reduces compute:
1. **Bigger hop** (latency is hop + inference, so this trades directly), or
2. **State reuse across ticks** (streaming/ KV-cached decoding ≈ 1× regardless of hop) — not achievable by re-windowing a non-streaming model.

Also measured: `final8` at 883 ms per 8 s window = **0.11 RTF single-pass**, so
one full pass over a 23:40 episode is ≈ 2.6 min on this 4-core box. Inference,
not feature extraction, dominates.

### F-005 — Progressive transcripts must be assembled from the last tick per segment (2026-11-02)

Evidence: naive concatenation of growing-window decodes produced 959 chars vs
253 for the single-pass decode over the same 60 s (both correct Japanese). Each
tick re-decodes the whole utterance, so concatenation multiplies text by the
tick count.

Rule: for growing-window strategies, take the **last decode of each utterance
segment**; for fixed-window strategies, stitch only the non-overlapping suffix
(LCP). Any future accuracy table must state which assembly rule it used, or the
character counts are meaningless.

### Pending at the time of this push (2026-11-02, session cut short)

A sweep was launched and may not have finished: beam-8 vs greedy cost, the full
hop frontier (`fixed2s500/750/1000`, `fixed3s750`), and thread scaling (1/2/4)
on `final8`. Its JSON outputs land in `bench/out/` (git-ignored) if the process
completed; otherwise re-run:

```powershell
node bench/matrix.mjs --audio "$env:TEMP\..\..\bench-audio\ep01.raw" --limit 60 `
  --strategies current,fixed2s250,fixed2s500,fixed2s750,fixed2s1000,fixed3s750,final8 --beams 1
```

Next accuracy step needs the reference transcripts: run a SOTA offline model
(Whisper large-v3 or better) over the 11 episodes, then `bench/compare.mjs`
against `bench/transcribe.mjs` output. Until then, only compute/latency claims
are supported — no CER number exists yet, and none should be quoted.

**Status 2026-11-02 22:45:** the sweep ran. The hop frontier is F-009, the
greedy/beam question is F-008, and the reason the first attempt stalled is
F-007.

### F-006 — onnxruntime-node deadlocks on a specific decode (2026-11-02) — UNRESOLVED

Evidence (reproduced twice):

- The hop-frontier process ran **45 min with only 37 s of CPU** at 362 MB RSS —
  blocked, not computing. No output beyond the previous section, no JSON written.
- Re-run of `current` on a 20 s clip with `--progress --decodeTimeout 60000`:
  jobs 1–26 completed (window growing 1.00 → 8.00 s, then 1.00 → 7.75 s), then
  **job 27 (4.00 s window) hung until the 60 s watchdog fired** and exited 1.

So the hang is not load-dependent or thermal: it reproduces at a specific job in
a repeated `session.run` loop. Suspects, in order: onnxruntime-node 1.31.1 ×
Node v26.12.1 interop, int8 dynamic-quant kernels with a reassigned input shape,
or the intra-op thread pool after ~26 varied-shape runs.

Consequences for any number collected so far:

- **All timings from a process that also hung are suspect.** The beam table
  (greedy 1784 ms vs beam 1267 ms) was produced while the stuck process held
  362 MB, and beam being *faster* than greedy is implausible — treat it as
  unverified until re-measured in isolation, with repeats.
- Every strategy must run in its **own process** and be retried, not chained in
  one loop; `matrix.mjs` now supports `--progress` and `--decodeTimeout <ms>`
  so a hang is named instead of silently eating an hour.

To do at home: re-run with `--decodeTimeout 30000` one strategy per process; if
the deadlock persists, pin `onnxruntime-node` to a known-good version (e.g.
1.20.x / 1.22.x) and/or test Node 22 LTS, then record which combination is
stable before collecting timings. Do **not** quote throughput until a clean,
repeatable run exists.

### F-007 — The harness could not terminate a finished process (2026-11-02) — mitigated

Symptom: a run completes every decode, prints its summary, writes its JSON, and
then never exits. First seen as a sweep that stalled for 30 minutes after
`fixed2s500` had already produced its results (PID 20580: 31.6 s CPU, 345 MB
RSS, 0.00 s CPU across a 6 s sample — finished, not computing).

Isolation: one fresh process per teardown mode, the exact `fixed2s500` workload
(117 decodes, 2 s window, 500 ms hop, 7.7 s of decode), 60 s kill deadline.

| Teardown attempted | Exited |
|---|---|
| return from top level, let the loop drain | no |
| `process.exit(0)` alone | no |
| `session.release()`, then drain | no |
| `session.release()`, then `process.exit(0)` | no |

The block is therefore not the event loop, not ORT's JS API, and not something
a script can fix from inside: `process.exit()` itself never returns. It is also
**intermittent** — the same workload hung twice in two different harness
versions, then completed in 9.4 s on a third run with identical code.

Scope: `onnxruntime-node`'s native CPU EP. The shipped extension uses ORT Web
with the WASM EP inside the offscreen document, so this is a bench defect, not a
product defect. Do not "fix" `offscreen.js` for it.

Relation to F-006: F-006 recorded a hang *during* decode (job 27, watchdog
fired). That is a different manifestation — a decode that never returns versus a
teardown that never returns — in the same native layer, and neither is fixed.
When a future run hangs, check whether its output was already complete before
assuming the decode stalled.

Mitigation now in the harness:

- `sweep.ps1` owns termination. It polls for `<out>.json.done`, which the runner
  writes *before* releasing the session, waits `-GraceSec` (3 s), then kills and
  reports `EXIT HANG` with the data intact. The old timeout path still exists
  for a child that never writes results. One hung child can no longer eat a
  sweep.
- `matrix.mjs` persists its JSON after every configuration, so a kill loses at
  most the configuration in flight.
- The driver reads the JSON, not stdout. A killed child loses its piped output
  (both logs were 0 B in the first `EXIT HANG` run) but keeps every file it
  wrote — so stdout is a progress display, never the record.
- `Asr.dispose()` releases the session and `lib/exit.mjs` drains stdio, which
  makes the common case exit cleanly. Neither is a guarantee, which is why the
  driver, not the runner, is the authority.

### F-008 — Beam-8 is slower than greedy, as expected (2026-11-02)

F-006 recorded "greedy 1784 ms vs beam-8 1267 ms" and flagged that beam being
faster than greedy is implausible. It is not true. Re-measured in isolation,
three repeats, one process each, `fixed2s750`, 60 s clip, 4 threads:

| Repeat | Greedy p50 | Beam-8 p50 | Greedy wall | Beam-8 wall |
|---|---|---|---|---|
| 1 | 77.2 ms | 97.2 ms | 6.1 s | 7.4 s |
| 2 | 63.0 ms | 74.2 ms | 5.0 s | 5.9 s |
| 3 | 62.7 ms | 73.2 ms | 4.9 s | 5.8 s |

Beam-8 costs 12–21 % more wall time and ~11–20 ms more per decode. The original
number came from a process that was also hung (F-006) and must not be quoted.

Accuracy signal available without a reference: the two decoders disagree by 18
characters over 577 (3.1 % of beam length) and beam emits 11 more characters
(577 vs 566), consistent with greedy dropping low-confidence characters. That is
not evidence beam is better — only that it differs, that the difference is
small, and that a ~12 % CPU premium on *finals only* is affordable. It is not
affordable on every 750 ms tick, which is precisely the asymmetric-decode
argument in PLAN_10X §3.

### F-009 — The frontier, measured clean, and why compute was never the constraint (2026-11-02)

First 60 s of ep01, greedy, 4 threads, one process per strategy, `sweep.ps1`,
Node v22.23.2, onnxruntime-node 1.31.1, int8 model. `wall` is the measured decode
loop; `× RT` is that wall as a fraction of the 60 s clip.

| Strategy | Decodes | `computeOverRealtime` | p50 | p95 | wall | × RT |
|---|---|---|---|---|---|---|
| `current` (growing, 750 ms) | 82 | 6.25× | 131.9 ms | 247.1 ms | 11.3 s | 0.188 |
| `fixed1s5_250` | 235 | 5.88× | 60.0 ms | 62.9 ms | 13.4 s | 0.223 |
| `fixed2s250` | 233 | 7.77× | 73.8 ms | 77.1 ms | 16.5 s | 0.275 |
| `fixed2s500` | 117 | 3.90× | 69.5 ms | 76.7 ms | 7.8 s | 0.130 |
| `fixed2s750` | 78 | 2.60× | 69.6 ms | 76.6 ms | 5.0 s | 0.083 |
| `fixed2s1000` | 59 | 1.97× | 64.2 ms | 76.9 ms | 3.8 s | 0.063 |
| `fixed3s750` | 77 | 3.85× | 96.4 ms | 103.5 ms | 7.1 s | 0.118 |
| `final8` | 8 | 1.00× | 176.5 ms | 198.5 ms | 1.3 s | 0.022 |

Four things follow from the table, and they are not the things the plan assumed.

**1. `computeOverRealtime` is geometry, not cost.** It is only `window ÷ hop`.
Cost is `decodes × p50`, and `decodes = clip ÷ hop`, so cost per second of audio
is `p50(window) ÷ hop`. The two rankings disagree: `fixed2s250` is the worst
strategy on both measures (7.77× and 0.275× RT) while `fixed2s1000` is the best
(1.97× and 0.063× RT), but `fixed1s5_250` beats `fixed2s500` on compute (5.88 vs
3.90) and loses on wall (0.223 vs 0.130). Quoting only the geometric number, as
PLAN_10X §2 does, can point at the wrong row.

**2. Per-decode latency is nearly flat across 1.5–3 s windows** (60 → 96 ms) and
only 2.5× at 8 s (176 ms). The window is a weak lever; the hop is the strong
one. That is F-004's conclusion arriving from a second direction: a fixed window
helps only because it is shorter than the average growing window (~4.6 s), and
the only structural savings come from a larger hop or cross-tick state reuse.

**3. Compute is not the binding constraint on this machine.** The shipped policy
costs **0.188× realtime**; a 2 s window at the shipped 750 ms hop costs
**0.083×**. There is roughly 12× headroom before decode cannot keep up. A 10×
faster decode would therefore buy almost nothing in perceived latency, because
the floor is `DECODE_STEP_MS = 750` plus `END_SILENCE = 640 ms` plus holdback —
about 1.4 s of pure policy. The plan's premise, that decode speed is the 10×
lever, does not hold on this hardware.

**4. Thread scaling saturates before 4 and is only meaningful for varied
windows.**

| Threads | `current` p50 | `fixed2s750` p50 | `final8` p50 |
|---|---|---|---|
| 1 | 248.3 ms | 114.7 ms | 417.1 ms |
| 2 | 186.1 ms | 104.7 ms | 243.0 ms |
| 4 | 132.8 ms | 71.6 ms | 280.0 ms |

4 threads is 1.87× / 1.60× faster than 1 for the two varied-window strategies.
`final8` is inside the noise at n = 8 (4 threads is *worse* than 2, which is not
a real effect) and must not be used for scaling claims.

Caveats that bound all of the above: native CPU EP, not the browser's WASM EP,
so absolute numbers do not transfer to the extension — the geometry conclusions
do. 60 s of one episode; no reference transcript, so nothing here says which
strategy is *more accurate*, only what each costs. The corpus is now 10 episodes
(E11 is gone) and only ep01 has been re-extracted (1420.1 s, 43.3 MB) — any
claim about episode-to-episode variance needs the rest of it re-encoded.

The open question this leaves is the one worth measuring next: what the shipped
pipeline actually costs inside Chrome, from the `[timings]` section of the
diagnostics report. If WASM is 3–4× slower than native, the headroom shrinks from
12× to ~3×, which is still enough that the hop and the endpointing — not the
model — set the latency.

Addendum, same session: the table's `p50` is a whole decode — frontend +
`session.run` + JS argmax — while the extension samples only `session.run`. A
browser report must be compared against the run-only column, so `matrix.mjs` now
records it. Separate sweep, same conditions:

| Strategy | p50 whole decode | p50 `session.run` only |
|---|---|---|
| `current` | 116.0 ms | 108.2 ms |
| `fixed2s750` | 60.4 ms | 56.3 ms |
| `final8` | 185.7 ms | 167.0 ms |

Frontend and argmax together are 5–18 ms; the rest is the model. So the native
baseline to measure Chrome against is **~110 ms per decode for the shipped
policy and ~56 ms for a 2 s window**, and a browser mean of 300–400 ms would be
a 3–6× WASM penalty rather than a machine-specific anomaly.

### F-010 — In the browser, WASM costs ~2× native and decode is 10 % of latency (2026-11-02)

Measured from the live extension, not the bench: 4-minute session, 142.3 s of
audio, 120 decodes, 4 WASM threads, `crossOriginIsolated true`, 12 logical cores,
16 GB, NVIDIA Blackwell available but unused (`executionProviders: ["wasm"]`).

| Metric | Value |
|---|---|
| `asr.inferMs` mean | 153.4 ms |
| `asr.inferMs` max | 328.9 ms |
| `asr.inferMs` last | 136.0 ms (window ≈ 1.57 s, from `asr.frames 29`) |
| decodes / audio seconds | 120 / 142.3 |
| duty cycle at `decodeStepMs 750` | 20 % mean, 44 % worst |
| `pcm.queueDepth` | 0 (no dropped audio) |
| `asr.loadMs` / `vad.loadMs` | 1452 ms / 310 ms |

Against the native run-only numbers from F-009:

| Window | Native `p50RunMs` | Browser | Ratio |
|---|---|---|---|
| ~1.5–2 s | 56.3 ms | 136–153 ms | 2.4–2.7× |
| 8 s (assumed to be the 328.9 ms max) | 167.0 ms | 328.9 ms | 2.0× |

So the WASM penalty on this machine is **~2.0–2.7×**, not the 3–6× the plan
budgeted for. Decode is **10 % of the ~1.54 s end-to-end path** (750 ms tick +
640 ms endpoint + 153 ms decode), with 4.9× headroom at the mean and 2.3× on the
worst single decode.

Consequences, and they reorder the roadmap a second time:

- **A GPU port cannot buy visible latency here.** Perfect inference on the
  current policy removes ~153 ms of ~1540 ms. The tick and the endpoint dominate.
- **Accuracy is affordable now.** Beam-8 costs +11 ms native (F-008) → ~+27 ms in
  WASM, paid against 640 ms of endpoint silence that is already being spent.
  Hotword biasing and a beam-8 final belong before any backend change.
- **The cheap latency levers are policy.** `DECODE_STEP_MS 750 → 500` costs
  roughly +50 % decode wall (still ~30 % duty) and removes up to 250 ms of
  perceived latency; `END_SILENCE 640 → 450 ms` removes ~190 ms more. Together
  that is ~440 ms — three times what a perfect GPU port would buy — for two
  constants and a re-tune of the endpoint heuristic.

Caveats: one machine, one session, one clip (ep01). The 8 s attribution of the
max decode is inferred from `asr.frames 29` for the *last* decode, not measured
per decode; if the max came from a smaller window, the ratio is slightly worse
and the conclusion does not change. `chrome 156.0.0.0` in that report is a
Chromium build that withholds the full version from client hints, even though
the report now asks for `fullVersionList`.

Addendum, second session (same machine, second scene, worker live):

| Metric | Session 1 | Session 2 |
|---|---|---|
| decodes / audio | 120 / 142.3 s | 174 / 193.8 s |
| `asr.inferMs` mean | 153.4 ms | 232.2 ms |
| `asr.inferMs` max | 328.9 ms | **655.6 ms** |
| speech share of VAD frames | 34 % | 44 % |
| `pcm.queueDepth` | 0 | 0 |

The mean moved 51 % and the max doubled with no code change, which rules out a
regression and points at the mix: more speech density means longer utterances,
and cost grows with window size. At matched windows the ratio is stable — the
last decode was `asr.frames 19` ≈ 1.03 s at 112.7 ms (~2.2× the native 1.5 s
figure) and the two before it, at 206 and 215 ms, look like ~3 s windows against
a native ~90 ms (~2.4×).

Two consequences:

1. **A session mean is not a benchmark.** Only 2.0–2.7× survives as a claim, and
   only per window. `asr.inferMs` is therefore now also sampled into `<=2s`,
   `<=4s`, `<=6s`, `<=8s` buckets, which are directly comparable to a bench row.
2. **The 655.6 ms max is the first number that could hurt.** It is 87 % of the
   750 ms step. If it is an 8 s window, the browser costs ~4× native at the top
   of the range rather than ~2×, which would mean a superlinear term (attention
   or memory traffic) that the GPU question actually depends on. If it is a
   smaller window that stalled, it is a scheduling artifact instead. The buckets
   would settle it on the next browser report; F-011 settles it from the bench
   instead, and it is the 8 s window at the ordinary ~2.5x.

### F-011 - Decode cost is linear in window size; the 655.6 ms max is the 8 s window, not a pathology (2026-11-02)

F-010 left one number unattributed: the 655.6 ms worst decode, 87 % of the
750 ms step. The browser cannot say which window produced it, so the same
question was asked of the bench with the hop held at 750 ms and only the window
varying. `bench/lib/strategies.mjs` now parses `fixed<window>s<hopMs>` instead of
enumerating strategies, so any window/hop pair is expressible; existing names are
unchanged (`fixed1s5_250` is kept as an alias for `fixed1.5s250`).

Two sweeps, 4 threads, ep01 first 60 s, greedy, `p50RunMs` (`session.run` only,
the quantity the browser reports):

| Window | Session A | Session B | ms per audio second (A / B) |
|---|---|---|---|
| 2 s | 71.7 ms | 85.3 ms | 35.9 / 42.7 |
| 4 s | 148.7 ms | 128.7 ms | 37.2 / 32.2 |
| 6 s | 191.6 ms | 185.2 ms | 31.9 / 30.9 |
| 8 s | 275.9 ms | 242.3 ms | 34.5 / 30.3 |

Least-squares fit: A `y = 32.8x + 8.1`, B `y = 26.4x + 28.4`, largest residual
7 % of the row value. Cost is **linear in window length at a fixed hop**, with a
small fixed per-decode overhead and no superlinear term anywhere up to the 8 s
cap. Per audio second decoded, the model costs **0.026-0.033x realtime** natively.

Two things follow.

**The 655.6 ms max is explained.** An 8 s window costs 242-276 ms natively, and
655.6 / 260 is ~2.5x, which is exactly the 2.2-2.5x measured at 1-3 s. There is no
superlinear WASM penalty, so nothing about the tail justifies a GPU port. The
GPU question is closed, not merely deprioritised.

**The cost of a long window is cadence, not throughput.** At the 8 s cap the
browser decode is 87 % of the 750 ms tick. One overrun and the effective interim
cadence becomes 1500 ms - precisely on the longest sentences, which are the ones
where the reader is waiting longest for text. Duty cycle never exceeds 44 %, so
nothing is dropped; the sentence simply updates half as often. Any future window
policy should be judged on `p95RunMs / DECODE_STEP_MS`, not on mean duty.

Measurement caveat: absolute values drift 25-50 % between sweeps on this machine
(`fixed2s750` run-only came back at 56.3 / 71.7 / 85.3 ms across three sessions).
Ratios within a sweep are stable; cross-sweep absolute comparisons are not. Quote
a ratio or a same-sweep table, never a lone millisecond figure.

---

### F-012 - Shipped policy constants changed from the measured baseline (2026-11-03)

`offscreen.js` now ships `DECODE_STEP_MS = 500` and `END_SILENCE_SAMPLES =
0.45 s` (was 750 ms / 0.64 s). Nothing above is invalidated: **every measurement
in F-004 to F-011 was taken at the baseline 750 / 640 policy**, so read those
tables as describing the pre-change build, not the current one. F-010's
"~1.54 s end-to-end path" is the baseline arithmetic (750 + 640 + ~150 ms).

Why these two numbers, from the measurements already in this file:

| Change | Gain (expected) | Source |
|---|---|---|
| tick 750 -> 500 ms | up to 250 ms | F-010: decode is ~10 % of the path; 0.188x realtime leaves ~12x headroom (F-009) |
| endpoint 640 -> 450 ms | ~190 ms | F-010: 640 ms of endpoint silence is spent per line |

Combined ~440 ms, roughly 3x what a perfect GPU port would buy (F-010), which is
why the GPU row is CLOSED rather than deferred.

Risks to measure, not assume:

- At 500 ms the worst-case 8 s decode (~330 ms browser, F-010) is 66 % of the
  tick, up from 44 %. `pcm.queueDepth` must stay 0 and dropped-audio must stay 0;
  if it does not, the tick is too short for that machine.
- A shorter endpoint can split sentences that the 640 ms margin was hiding. The
  VAD only closes below `VAD_CONTINUE_THRESHOLD` (0.35), so a pause inside a
  sentence still needs ~1.5x the endpoint to split - but the commit-contradiction
  rate (a `FINAL` rewritten by the next utterance) is the number to watch, not
  intuition.

**Status: code changed, browser A/B not yet run.** The expected ~440 ms must not
be quoted as measured. The A/B compares `soundToSubtitleMs` p50/p95 and the
commit-contradiction rate from the diagnostics `[timings]` section before
vs after; browser re-measurement of `asr.inferMs` at 500 ms also closes the
"is the tick now too short for an 8 s window" question.
