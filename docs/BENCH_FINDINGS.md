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

# score against a reference transcript (produced later by a stronger model)
node compare.mjs --reference ep01.srt --hypothesis out/ep01_current.txt
```

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



