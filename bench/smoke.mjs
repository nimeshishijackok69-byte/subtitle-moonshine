#!/usr/bin/env node
// Doctor check: proves onnxruntime-node can load the shipped model and run one
// decode through the shipped frontend, without needing audio files.
import { Asr, SAMPLE_RATE } from "./lib/asr.mjs";

const asr = await Asr.create({ threads: Number(process.env.BENCH_THREADS || 4) });
console.log("session inputs:", asr.session.inputNames.join(", "));
console.log("frontend lang/textNorm:", asr.frontend.language, asr.frontend.textNorm);
console.log("tokens:", asr.tokens.size);

const pcm = new Int16Array(SAMPLE_RATE * 2); // 2 s of silence
const t0 = performance.now();
const r = await asr.decode(pcm);
console.log(`decode: ${Math.round(performance.now() - t0)} ms, frames=${r.frames}, dim=${r.dim}, text=${JSON.stringify(r.text)}`);
