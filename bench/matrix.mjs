#!/usr/bin/env node
// Run every strategy x beam width on one clip in a single process, so model
// load is paid once and the table is directly comparable.
//
// Usage:
//   node bench/matrix.mjs --audio <raw> [--limit 120] [--threads 4] [--out bench/out/matrix.json]
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Asr, loadPcm, SAMPLE_RATE } from "./lib/asr.mjs";
import { getJobs, transcriptFor } from "./lib/strategies.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

const audioPath = arg("audio");
if (!audioPath) throw new Error("--audio is required");
const threads = Number(arg("threads", 4));
const limitSec = Number(arg("limit", 120));
const outPath = arg("out");

const pcmAll = loadPcm(audioPath);
const pcm = pcmAll.subarray(0, Math.min(pcmAll.length, Math.round(limitSec * SAMPLE_RATE)));
const clipSec = pcm.length / SAMPLE_RATE;
const asr = await Asr.create({ threads });
await asr.decode(pcm.subarray(0, Math.min(pcm.length, SAMPLE_RATE * 2))); // warm-up

const pct = (arr, q) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : 0;

const runs = [];
for (const strategy of (arg("strategies", "current,fixed2s250,fixed1s5_250,final8") + "").split(",")) {
  for (const beamWidth of (arg("beams", "1,8") + "").split(",").map(Number)) {
    const jobs = getJobs(strategy, pcm.length);
    const walls = [];
    const frontends = [];
    const texts = [];
    const started = performance.now();
    for (const job of jobs) {
      const r = await asr.decode(pcm.subarray(job.start, job.end), { beamWidth });
      walls.push(r.inferMs);
      frontends.push(r.frontendMs || 0);
      texts.push(r.text);
    }
    const wallMs = performance.now() - started;
    const audioProcessed = jobs.reduce((a, j) => a + (j.end - j.start), 0) / SAMPLE_RATE;
    const sorted = [...walls].sort((a, b) => a - b);
    const sortedFrontend = [...frontends].sort((a, b) => a - b);
    const transcript = transcriptFor(strategy, jobs, texts);
    runs.push({
      strategy,
      beamWidth,
      decodes: jobs.length,
      computeOverRealtime: Math.round((audioProcessed / clipSec) * 100) / 100,
      wallSec: Math.round(wallMs / 100) / 10,
      p50InferMs: Math.round(pct(sorted, 0.5) * 10) / 10,
      p95InferMs: Math.round(pct(sorted, 0.95) * 10) / 10,
      p50FrontendMs: Math.round(pct(sortedFrontend, 0.5) * 10) / 10,
      chars: transcript.length,
      transcript
    });
    console.log(`${strategy.padEnd(14)} beam=${beamWidth}  decodes=${String(jobs.length).padStart(3)}  ` +
      `compute=${String(runs.at(-1).computeOverRealtime).padStart(5)}x  p50=${String(runs.at(-1).p50InferMs).padStart(7)}ms  p95=${String(runs.at(-1).p95InferMs).padStart(7)}ms  ` +
      `frontendP50=${String(runs.at(-1).p50FrontendMs).padStart(6)}ms`);
  }
}

if (outPath) {
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ audio: path.basename(audioPath), clipSec, threads, runs }, null, 2));
  console.log(`\nwrote ${outPath}`);
}
