# Live Japanese Subtitles — 10× Speed & Accuracy Plan

Status: **partly superseded by measurement** — see `docs/BENCH_FINDINGS.md`
Date: 2026-11-02 (measured corrections 2026-11-03)
Repo: `nimeshishijackok69-byte/subtitle-moonshine`
Product: Chrome MV3 extension, on-device live Japanese ASR for a user-selected tab.

> **Read this before the sections below.** The bench (F-004, F-008, F-009,
> F-010, F-011, F-012) disproved the central premise of §2 and §6:
>
> 1. **Decode speed is not the bottleneck.** In the live extension, decode is
>    ~150 ms of a ~1540 ms path; the 750 ms tick and 640 ms endpoint are ~90 %
>    of perceived latency.
> 2. **The GPU/WebGPU port is closed.** WASM is only 2.0–2.7× native and per-
>    decode cost is linear in window length — a perfect GPU port would save
>    ~150 ms, less than two constant changes.
> 3. **Fixed short windows do not reduce compute.** Cost is `window ÷ hop`;
>    2 s @ 250 ms measured 7.77× vs the shipped 6.25×. The shipped policy
>    already has ~12× headroom (0.188× realtime).
> 4. **The affordable path is policy first, accuracy second:** 500 ms tick +
>    ~480 ms endpoint (~285-410 ms), then beam-8 on finals only (+12-21 % on a
>    decode that fits inside the endpoint silence), then hotword biasing.
>
> Sections §2, §3 ("asymmetric decode" conclusion still holds, the GPU wording
> does not), §4.2, §6 steps 2 and the risk table below are retained as history;
> where they disagree with the box above, the box wins.

---

## 1. Where the time goes today (measured baseline)

| Stage | Implementation | Cost profile |
|---|---|---|
| Capture | `audio-worklet.js`, resample → 16 kHz Int16, 25 ms chunks | Cheap, not a factor |
| VAD | Silero v5 on WASM, 512 + 64 samples per 32 ms frame | ~1–2 ms/frame, always-on |
| Feature extraction | `sensevoice-frontend.js`: 512-pt FFT in **Float64**, per 10 ms frame | Small, but **recomputed for the entire window on every tick** |
| Inference | SenseVoiceSmall int8, **WASM only**, 4 threads (`ASR_WASM_THREADS`) | Dominant compute, but only ~10 % of end-to-end latency (F-010) |
| Decoding | JS greedy argmax over ~25 k vocab × T frames | ~3–5 ms, minor |
| Cadence | `DECODE_STEP_MS`, growing window capped at `MAX_UTTERANCE_SAMPLES = 8 s` | **The real structural cost** |
| Finalize | `END_SILENCE_SAMPLES` + `TAIL_PAD_SAMPLES = 0.2 s` | Pure added latency |

> The table and numbers in this section describe the **measured baseline**, taken
> before the policy change: `DECODE_STEP_MS = 750`, `END_SILENCE_SAMPLES = 0.64 s`.
> Shipped now: **500 ms tick / 15 frames (480 ms) endpoint** (see §2). Every measurement in
> `docs/BENCH_FINDINGS.md` refers to the baseline values.

### Two structural facts

1. **The decode re-reads the whole window.** At the baseline, every 750 ms the entire 0 → 8 s window was re-decoded. Measured cost was 6.25× realtime against 1.00× for a single pass — real, but **not binding**: 0.188× realtime overall, ~12× headroom (F-009).
2. **The GPU path is present but unused.** `lib/ort.min.js` is the **WebGPU** ORT bundle (the reason the jsep companion had to be restored in `ef871c8`), yet `loadAsr()` hardcodes `executionProviders: ["wasm"]`. F-010/F-011 closed this as a lever — do not wire it up.

Consequence: even with instant inference the experience is bounded at ~1.5 s, because the tick, endpoint and 4-char holdback dominate. Cutting the two policy constants to 500 ms / 480 ms is worth ~285-410 ms; the model is not the constraint.

---

## 2. Speed: the 10× is real, from four independent multipliers

| Lever | Expected gain | Confidence | Cost |
|---|---|---|---|
| ~~**WebGPU EP + fp16 model**~~ **CLOSED (F-010/F-011)** — WASM is only 2.0–2.7× native and cost is linear in window length; a perfect GPU port saves ~150 ms of a ~1540 ms path | — | — | Do not build |
| **Fixed short window @ 250 ms hop** | **Worse:** 7.77× vs shipped 6.25× (F-004/F-009). Cost is `window ÷ hop`; only a larger hop helps, and that is latency. | Measured | Rework only with a larger hop |
| **Policy: 750 → 500 ms tick, 640 → 480 ms endpoint (20 → 15 VAD frames)** | ~285-410 ms of perceived latency, 2-3× what a GPU port buys | High (F-010, arithmetic and frame-quantisation corrected in F-012) | Two constants + endpoint re-tune |
| **Incremental fbank cache** — keep the window's frames, compute only the ~75 new ones per tick | 1.5–2× frontend CPU, removes 800-FFT bursts | High, ~40 lines in `sensevoice-frontend.js` | Low |
| **Eliminate the O(n²) decode** — fixed 1.5–2 s window @ 250 ms hop for interim; full window only on final | **Disproved (F-004/F-009)** — at 250 ms hop it costs more than the current loop | Measured | Not worth it at equal hop |
| **Move fbank + argmax to a dedicated Worker** — VAD, PCM queue and messaging never queue behind a decode | 1.2–1.5× perceived; removes chunk drops under load | High | Moderate |

Combined (original): **10–20× less work per second of audio** → interim latency **1.5–2.5 s → 300–500 ms**, final **2–3 s → 700–900 ms**.

Combined (**measured**): decode is ~10 % of the latency path, so the reachable gain is the policy ~285-410 ms; the original targets would require cutting tick and endpoint, not model work.

Cheap extras (**status: folded into the 500/480 policy, do not re-do**):

- `END_SILENCE` 640 → 480 ms - **shipped** (F-012; the gate is quantised to 32 ms VAD frames, so a literal 450 ms is not expressible). Going to 15 → 13 frames (416 ms) is a further ~64 ms with re-tuned endpoint risk; only pursue it if the A/B shows no commit-contradiction increase.
- `numThreads`: fixed 4 → `min(8, hardwareConcurrency − 1)` for the WASM fallback — still unmeasured; decode is ~10 % of the path, so expect tens of ms at most.

**WebGPU caution (retained as history, now resolved):** F-010/F-011 measured the WASM penalty at only 2.0–2.7× and showed cost is linear in window length, so a WebGPU port saves ~150 ms of a ~1540 ms path. The lever is closed — do not build it, and do not re-open it without a new measurement that contradicts F-011.

---

## 3. Accuracy: "10×" is not linear — this is what is achievable

WER does not scale like latency. Realistic decomposition:

| Lever | Realistic effect | Notes |
|---|---|---|
| **fp16 instead of int8** (same weights) | 2–8 % relative WER | Dynamic int8 quantization costs measurable accuracy on CTC |
| **Prefix beam search instead of greedy argmax** | 3–8 % relative WER | Decode-time only; can be **final-only** so interim stays cheap |
| **Hotword / context biasing** (character and show names) via a trie scored during beam search | **Large** — often 30–60 % reduction in proper-noun errors | Highest-leverage accuracy feature for anime/drama; needs a tiny UX to collect names |
| **CTC confidence gating** — drop lines below a posterior-margin threshold | Fewer confident-looking garbage lines | Precision over recall; improves *perceived* accuracy a lot |
| **Better endpointing** — 400 ms silence, smarter pre-roll | Fewer mid-sentence cuts | Also a latency win |
| **Domain fine-tune** (LoRA on SenseVoice, re-export ONNX) on ReazonSpeech + Common Voice JA | 15–30 % relative WER on dialogue | Weeks of work, licence + QA burden, but the only path to a genuinely large jump |

Defensible target: **~2–3× fewer errors** (e.g. 20 % → 8–10 % CER on dialogue) **while being 5–10× faster**.

### The enabling design: asymmetric decode (same weights, two decode policies)

> **Interim** = tiny window, greedy, GPU, 250 ms cadence.
> **Final** = full utterance, beam search + hotwords + confidence gate, with a 400–600 ms budget that fits inside the endpoint silence the user already waits through.

Accuracy is paid where it is visible (the line that stays on screen) without paying it on every tick. Single model → no package bloat, no extra licensing.

---

## 4. Breaking the architecture (bigger swings)

1. **Swap the model.** SenseVoiceSmall is multilingual-generic. A Japanese-specific streaming Zipformer (ReazonSpeech line) gives true streaming at **~1× realtime compute**, likely better JA accuracy, at the cost of punctuation/ITN quality and a licence check. This is the only clean path to *sub-300 ms interim*, because it removes the "re-decode the window" problem rather than optimizing it.
2. **Optional "quality pack."** Ship a second, heavier model (kotoba-whisper-class, Apache-2.0 lineage) used **only for FINAL**, on WebGPU. Roughly halves final-pass WER at ~300–600 ms per utterance. Package grows to ~400 MB–1.5 GB — still under the 2 GB store limit, but a real install-size decision; keep it user-selected, not default.
3. **Energy pre-gate before Silero.** A cheap RMS threshold that skips VAD inference on silence-only stretches cuts steady-state CPU 30–50 % with no accuracy cost, while preserving the onset behaviour the README documents as critical.

---

## 5. Measurement plan (before touching anything)

`diagnostics.js` already samples `asr.inferMs`, `asr.frames` and audio lag. What is missing is a repeatable bench:

1. **Node harness** (`onnxruntime-node`) feeding 10–20 WAV clips through `SenseVoiceFrontend` + `runAsr`, so WebGPU vs WASM, fp16 vs int8, greedy vs beam, and window sizes can be A/B tested in minutes instead of browser sessions. Port only the winners.
2. **Evaluation corpus** — 30–60 min of Japanese dialogue with reference subtitles → CER, proper-noun recall, hallucination rate on music/silence, and commit-survival rate (re-measure the README's 1.7 % contradicted figure).
3. **Latency gates as pass/fail** — `soundToSubtitleMs` p50/p95 for interim and final, plus dropped-audio seconds (already honest in telemetry).

Without this, every number above is a guess about a specific machine — including these.

---

## 6. Roadmap (ordered by value / effort)

1. **Bench harness + baseline numbers** — *done*; see `docs/BENCH_FINDINGS.md` F-001…F-012.
2. **Policy A/B** — `DECODE_STEP_MS 750 → 500`, `END_SILENCE 20 → 15 frames (640 → 480 ms)`, measured in the live extension via `soundToSubtitleMs` p50/p95 and commit-contradiction rate (~285-410 ms expected, F-012).
3. **Reference transcripts** — Whisper large-v3 pass over the corpus, then `bench/compare.mjs` → the first quotable CER.
4. **Asymmetric decode** — greedy interim at the new tick, beam-8 + confidence gate on finals only (+12–21 %, F-008).
5. **Hotword list UX + trie biasing** — largest perceived-accuracy win on names.
6. **Then decide:** fine-tune vs model swap vs quality pack — only after 3–5 have numbers. Rebuild and verify the store zip before any submission.

---

## 7. Open questions / decisions needed

- **(a) Target hardware:** is the 10× required on GPU-capable Chrome (121+, Windows/macOS), or must it hold on WASM-only machines?
- **(b) Install size:** is ~163 MB sacred, or is a 400 MB–1.5 GB optional "accuracy pack" acceptable for the store listing?
- **(c) Priority:** runtime path (steps 2–4), accuracy path (step 5), or the architecture break (streaming model / quality pack)?

---

## 8. Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| WebGPU unavailable in offscreen documents or on target Chrome | Speed plan degrades to ~2× | Capability probe; keep int8 WASM path warm; measure both in the bench |
| fp16 model doubles package size | Store install friction | Offer fp16 only when GPU present; keep int8 as the bundled default until measured |
| Beam search + hotwords blow the final-pass budget on slow machines | Final latency regression | Final-only application; hard time bound; fall back to greedy when over budget |
| Fine-tune licence / data provenance | Cannot ship weights | Restrict to CC-BY/CC0 corpora (ReazonSpeech, Common Voice JA, JSUT); document provenance like the SenseVoice MIT licence |
| Thermal throttling under sustained GPU inference | Latency drift in long sessions | Adaptive cadence driven by `asr.inferMs` percentiles from diagnostics |
| Bigger models trip CWS review scrutiny | Rejection / delay | Keep all weights bundled, disclose data handling; no runtime model fetch |
