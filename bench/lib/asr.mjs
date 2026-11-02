// SenseVoice bench core: loads the shipped ONNX model + the shipped JS
// frontend (so the bench measures the real feature pipeline, not a re-
// implementation), and offers greedy + CTC prefix beam decoding.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as ort from "onnxruntime-node";

const require = createRequire(import.meta.url);
export const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const SenseVoiceFrontend = require(path.join(repoRoot, "sensevoice-frontend.js"));

const NEG_INF = -1e30;
const BLANK = 0;

export function parseTokens(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const m = line.match(/^(.*)\s(\d+)\s*$/);
    if (!m) continue;
    map.set(Number(m[2]), m[1]);
  }
  return map;
}

export function loadPcm(file) {
  const buf = readFileSync(file);
  return new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1);
}

function tokensToText(ids, tokens) {
  let out = "";
  for (const id of ids) out += tokens.get(id) || "";
  return out.replace(/▁/g, " ").replace(/<\|[^|]*\|>/g, "").trim();
}

function greedyIds(logits, T, V) {
  const ids = [];
  let previous = -1;
  for (let t = 0; t < T; t++) {
    const base = t * V;
    let best = 0;
    let bestScore = -Infinity;
    for (let v = 0; v < V; v++) {
      const s = logits[base + v];
      if (s > bestScore) { bestScore = s; best = v; }
    }
    if (best !== BLANK && best !== previous) ids.push(best);
    previous = best;
  }
  return ids;
}

// Top-k ids for one frame, excluding blank, with log-softmax applied.
function topKFrame(logits, base, V, k) {
  const idx = new Int32Array(k).fill(-1);
  const val = new Float64Array(k).fill(-Infinity);
  let max = -Infinity;
  for (let v = 0; v < V; v++) {
    const s = logits[base + v];
    if (s > max) max = s;
  }
  let sum = 0;
  for (let v = 0; v < V; v++) sum += Math.exp(logits[base + v] - max);
  const lse = max + Math.log(sum);

  for (let v = 1; v < V; v++) { // skip blank, handled separately
    const lp = logits[base + v] - lse;
    if (lp <= val[k - 1]) continue;
    let pos = k - 1;
    while (pos > 0 && val[pos - 1] < lp) { val[pos] = val[pos - 1]; idx[pos] = idx[pos - 1]; pos--; }
    val[pos] = lp; idx[pos] = v;
  }
  const blankLp = logits[base + BLANK] - lse;
  return { idx, val, blankLp };
}

function logAdd(a, b) {
  if (a <= NEG_INF) return b;
  if (b <= NEG_INF) return a;
  const hi = Math.max(a, b), lo = Math.min(a, b);
  return hi + Math.log1p(Math.exp(lo - hi));
}

// CTC prefix beam search (log domain). Beam holds prefixes as id arrays.
// This is the accuracy lever that can be applied to FINAL-only decodes.
function beamSearchIds(logits, T, V, beamWidth, topK) {
  let beams = [{ ids: [], pb: 0, pnb: NEG_INF }];
  for (let t = 0; t < T; t++) {
    const { idx, val, blankLp } = topKFrame(logits, t * V, V, topK);
    const next = new Map();
    const ensure = (key) => {
      let b = next.get(key);
      if (!b) { b = { ids: key.split(",").filter(Boolean).map(Number), pb: NEG_INF, pnb: NEG_INF }; next.set(key, b); }
      return b;
    };
    for (const beam of beams) {
      const total = logAdd(beam.pb, beam.pnb);
      if (total <= NEG_INF) continue;
      const last = beam.ids.length ? beam.ids[beam.ids.length - 1] : -1;
      const emptyKey = beam.ids.join(",");

      // stay on the same prefix via blank
      const same = ensure(emptyKey);
      same.pb = logAdd(same.pb, total + blankLp);

      for (let i = 0; i < topK; i++) {
        const c = idx[i];
        if (c < 0) continue;
        if (c === last) {
          // repeat token: extends only from a non-blank end state
          same.pnb = logAdd(same.pnb, beam.pnb + val[i]);
        } else {
          const key = beam.ids.length ? `${emptyKey},${c}` : String(c);
          const nb = ensure(key);
          nb.pnb = logAdd(nb.pnb, total + val[i]);
        }
      }
    }
    beams = [...next.values()]
      .sort((a, b) => logAdd(b.pb, b.pnb) - logAdd(a.pb, a.pnb))
      .slice(0, beamWidth);
  }
  let best = beams[0];
  for (const b of beams) if (logAdd(b.pb, b.pnb) > logAdd(best.pb, best.pnb)) best = b;
  return best.ids;
}

export class Asr {
  static async create({ threads = 4, modelPath } = {}) {
    ort.env.wasm = ort.env.wasm || {};
    const asr = new Asr();
    asr.threads = threads;
    asr.session = await ort.InferenceSession.create(
      modelPath || path.join(repoRoot, "models/sensevoice/model.int8.onnx"),
      { executionProviders: ["cpu"], graphOptimizationLevel: "all", intraOpNumThreads: threads, interOpNumThreads: 1 }
    );
    const cfg = JSON.parse(readFileSync(path.join(repoRoot, "models/sensevoice/frontend.json"), "utf8"));
    asr.frontend = new SenseVoiceFrontend(cfg);
    asr.tokens = parseTokens(readFileSync(path.join(repoRoot, "models/sensevoice/tokens.txt"), "utf8"));
    return asr;
  }

  async decode(pcm, { beamWidth = 1, topK = 8 } = {}) {
    const started = performance.now();
    const features = this.frontend.computeFeatures(pcm);
    const frontendMs = performance.now() - started;
    if (!features?.frames) return { text: "", inferMs: 0, frontendMs, frames: 0, dim: 0 };
    const feeds = {
      x: new ort.Tensor("float32", features.data, [1, features.frames, features.dim]),
      x_length: new ort.Tensor("int32", Int32Array.of(features.frames), [1]),
      language: new ort.Tensor("int32", Int32Array.of(this.frontend.language), [1]),
      text_norm: new ort.Tensor("int32", Int32Array.of(this.frontend.textNorm), [1])
    };
    const runStarted = performance.now();
    const result = await this.session.run(feeds);
    const runMs = performance.now() - runStarted;
    const logits = result.logits;
    const dims = logits.dims;
    const T = dims[dims.length - 2];
    const V = dims[dims.length - 1];
    const ids = beamWidth > 1
      ? beamSearchIds(logits.data, T, V, beamWidth, topK)
      : greedyIds(logits.data, T, V);
    return {
      text: tokensToText(ids, this.tokens),
      inferMs: performance.now() - started,
      frontendMs,
      runMs,
      frames: T,
      dim: V
    };
  }
}

export const SAMPLE_RATE = 16000;

export function sliceFloat(pcm, start, end) {
  // The frontend consumes int16-typed samples; it converts internally to
  // Float64 per frame, so passing an Int16Array view keeps it faithful to the
  // extension pipeline.
  return pcm.subarray(Math.max(0, start), Math.min(pcm.length, end));
}
