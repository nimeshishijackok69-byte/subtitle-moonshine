# Work order: accuracy and policy measurement

For an agent with shell, filesystem and repo access. Everything here is already
committed; `main` is at `b859f96`. Your output is data, not prose: tables and
file paths. Do not edit `docs/BENCH_FINDINGS.md`, `docs/PLAN_10X.md`,
`docs/DIAGNOSTICS.md`, `README.md` or `offscreen.js` — the reviewer owns those
and is correcting them in parallel.

## Why this exists

The bench measures latency well and accuracy not at all: every number in
`docs/BENCH_FINDINGS.md` is a timing. Two policy constants were then shipped on
those timings alone (`DECODE_STEP_MS = 500`, `END_SILENCE_FRAMES = 15`), and the
accuracy levers still on the table — beam-8 on finals, hotword biasing, a sliding
window — cannot be judged without a correctness score. Producing the first
quotable CER is the whole job.

## Environment

- Windows, PowerShell. `node` v22.23.2. `npm` must be invoked as
  `C:\Users\User\AppData\Local\hermes\node\npm.cmd` (the `.ps1` shim is blocked).
- Python venv with faster-whisper 1.2.1, ctranslate2 4.8.5:
  `C:\Users\User\bench-audio\.venv\Scripts\python.exe`.
- `--device cuda` does **not** work: ctranslate2 sees the device but
  `cublas64_12.dll` is missing, so it dies at the first encoder call. Use
  `--device cpu --compute-type int8` (measured 0.70-0.75x realtime for large-v3).
- Corpus: `C:\Users\User\bench-audio\ep01.raw`, 16 kHz mono s16le, 1420.1 s.
- Model cache: `C:\Users\User\.cache\huggingface\hub`, already holds
  `models--Systran--faster-whisper-large-v3`.

## Task 1 — reference transcripts

`bench/ref-whisper.py --raw <raw> --start <s> --duration <s> --model <m>
--device cpu --compute-type int8 --threads 8 --out <prefix>` writes `<prefix>.srt`
and `<prefix>.json`.

Known trap, measured: Whisper large-v3 transcribes 0-30 s of ep01 as
`ご視聴ありがとうございました` — a stock hallucination. That region is OP music, not
silence (RMS -46 dB rising to -16 dB, broadband, no gap), and SenseVoice invents a
coherent news report over the same music. Scoring 0-180 s against a full-length
reference therefore scores the hallucination, not the speech.

So:

1. Produce a reference for the **whole** file, 0-1420 s, in slices no longer than
   300 s (Whisper's window is 30 s; long slices just make the JSON unwieldy).
2. Produce a second reference with a Japanese-tuned checkpoint,
   `kotoba-tech/kotoba-whisper-v2.0-faster`, same slices. Report where the two
   checkpoints disagree wholesale — those are the music/hallucination regions.
3. Emit `bench/out/regions.json`: a list of `{start, end, reason}` for every
   region you exclude from scoring, with the reason (`music`, `hallucination`,
   `disagreement`). This list is the deliverable that keeps the CER honest.

## Task 2 — hypothesis transcripts

`bench/transcribe.mjs --audio <raw> --strategy <s> --beam <n> --start <s>
--limit <s> --threads 4 --out <path>`.

Needed set: `final8` beam 1 and 8, `current` (shipped growing window, 500 ms hop)
beam 1 and 8, `final8` beam 1 at 300 s and 600 s slices for stability.

**Do not score `fixed2s750` / `fixed4s750`.** Their stitched output is inflated —
1771 and 3308 characters for 180 s against 765 for `final8` — because
`stitch()` in `bench/lib/strategies.mjs` drops only a common prefix, and at 75 %
window overlap the re-decoded text diverges early, so the tail is duplicated.
Either fix the stitcher (align on the overlapping audio span rather than the
common prefix) or leave those rows out and say so.

## Task 3 — CER table

`node bench/compare.mjs --reference <srt> --hypothesis <txt>` per pair. Report
`cerWithPunctuation` and `cerCharacterOnly`, with the Task-1 excluded regions
removed from both sides, and note the character counts so a length mismatch is
visible.

## Task 4 — policy matrix

Use `bench/sweep.ps1` (it starts one process per configuration, polls for a
completion marker and hard-kills after a grace period). Do **not** drive
`bench/matrix.mjs` directly: ONNX Runtime's native CPU EP intermittently fails to
tear down (F-007), and the sweep driver exists to contain that.

Suggested: strategies `current,current750,final8,fixed2s750`, beams `1,8`,
threads `1,2,4`, repeats 3, `-TimeoutSec 240`, 180 s clip. Report
`p50RunMs`/`p95RunMs`/`decodes`/wall per configuration.

Absolute milliseconds drift 25-50 % between sweeps on this machine, so present
each configuration **within one sweep only**, or as a ratio to a row from the
same sweep. Never compare a number from today's sweep to one from yesterday's.

## Deliverable

1. `bench/out/regions.json`.
2. A CER table: rows = hypothesis, columns = CER with/without punctuation,
   characters, excluded regions.
3. A policy table from Task 4, one table per sweep.
4. One paragraph: which hypothesis is most accurate, and whether the difference
   is larger than the difference between the two reference checkpoints (that is
   the noise floor of the instrument).

## Gotchas that have cost real time here

- `git push` writes progress to stderr and PowerShell surfaces it as an error
  (`NativeCommandError`). The push succeeded; verify with
  `git ls-remote origin refs/heads/main`.
- Backticks inside `node -e "..."` are PowerShell escapes. Write a `.js` file and
  delete it afterwards.
- `(Get-Content -Raw).Length` inflates Japanese text ~2.5x (UTF-8 read as ANSI).
  Count characters with node.
- `bench/out/` is gitignored. Leave artefacts there.
- Piping a native command into `Select-Object` can report exit code 1 even when
  the command succeeded; check the artefact, not `$LASTEXITCODE`.
