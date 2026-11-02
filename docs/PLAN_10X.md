# Live Japanese Subtitles — 10× Speed & Accuracy Plan

Status: brainstorm / pre-implementation
Date: 2026-11-02
Repo: `nimeshishijackok69-byte/subtitle-moonshine` @ `17c5560` (main)
Product: Chrome MV3 extension, on-device live Japanese ASR for a user-selected tab.

---

## 1. Where the time goes today (grounded in the code)

| Stage | Implementation | Cost profile |
|---|---|---|
| Capture | `audio-worklet.js`, resample → 16 kHz Int16, 25 ms chunks | Cheap, not a factor |
| VAD | Silero v5 on WASM, 512 + 64 samples per 32 ms frame | ~1–2 ms/frame, always-on |
| Feature extraction | `sensevoice-frontend.js`: 512-pt FFT in **Float64**, per 10 ms frame | Small, but **recomputed for the entire window on every tick** |
| Inference | SenseVoiceSmall int8, **WASM only**, 4 threads (`ASR_WASM_THREADS`) | Dominant cost |
| Decoding | JS greedy argmax over ~25 k vocab × T frames | ~3–5 ms, minor |
| Cadence | `DECODE_STEP_MS = 750`, growing window capped at `MAX_UTTERANCE_SAMPLES = 8 s` | **The real structural cost** |
| Finalize | `END_SILENCE_SAMPLES = 0.64 s` + `TAIL_PAD_SAMPLES = 0.2 s` | Pure added latency |

### Two structural facts

1. **The decode is O(n²) over the utterance.** Every 750 ms the entire 0 → 8 s window is re-decoded from scratch. A full 8 s utterance costs ~10 decodes averaging 4.5 s of audio — roughly **5–6× more compute than real time** for no additional information. No KV/conv state reuse.
2. **The slowest shipped accelerator is used.** `lib/ort.min.js` is the **WebGPU** ORT bundle (the reason the jsep companion had to be restored in `ef871c8`), yet `loadAsr()` hardcodes `executionProviders: ["wasm"]`. The GPU path is present but unused.

Consequence: even with instant inference the experience is bounded at ~1.5–2.5 s, because the 750 ms cadence, 640 ms endpoint and 4-char holdback dominate.

---

## 2. Speed: the 10× is real, from four independent multipliers

| Lever | Expected gain | Confidence | Cost |
|---|---|---|---|
| **WebGPU EP + fp16 model** (int8 WASM as fallback) | 4–10× on `asr.inferMs` | High on Chrome ≥ 121 (Win/macOS); WebGPU unavailable on older macOS | Model conversion + numeric validation; ~470 MB fp16 copy |
| **Incremental fbank cache** — keep the window's frames, compute only the ~75 new ones per tick | 1.5–2× frontend CPU, removes 800-FFT bursts | High, ~40 lines in `sensevoice-frontend.js` | Low |
| **Eliminate the O(n²) decode** — fixed 1.5–2 s window @ 250 ms hop for interim; full window only on final | 3–5× total compute per second of audio | High; stitch logic already exists (LCP committer) | Moderate: segmenter + committer rework |
| **Move fbank + argmax to a dedicated Worker** — VAD, PCM queue and messaging never queue behind a decode | 1.2–1.5× perceived; removes chunk drops under load | High | Moderate |

Combined: **10–20× less work per second of audio** → interim latency **1.5–2.5 s → 300–500 ms**, final **2–3 s → 700–900 ms**.

Cheap extras worth another ~300 ms:

- `END_SILENCE` 640 → ~400 ms (Silero v5 tolerates a tighter endpoint with the current pre-roll logic).
- `numThreads`: fixed 4 → `min(8, hardwareConcurrency − 1)` for the WASM fallback.

**Caution:** WebGPU inside an *offscreen document* must be proven experimentally (extension pages are secure contexts, so it should work). Gate it behind a runtime capability probe; the WASM path remains the fallback, not a rewrite.

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

1. **Bench harness + baseline numbers** (1–2 days) — no product change; makes everything else falsifiable.
2. **WebGPU + fp16 with WASM fallback + capability probe** (2–4 days) — largest single speed win, low risk.
3. **Incremental fbank + argmax in a Worker** (1–2 days) — removes jank and chunk drops.
4. **Asymmetric decode: short-window interim / full-window final + beam search + confidence gate** (3–5 days) — the "faster *and* more accurate" step.
5. **Hotword list UX + trie biasing** (2–3 days) — largest perceived-accuracy win for real content.
6. **Then decide:** domain fine-tune vs model swap vs quality pack — only after steps 1–5 have numbers.

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
