#!/usr/bin/env node
// Bench runner. Times real decodes against real audio through the shipped
// frontend + model, and writes a machine-readable result so runs are
// comparable across commits.
//
// Usage:
//   node bench/run.mjs --audio <raw 16k mono s16le> --strategy current \
//        [--beam 8] [--limit 120] [--threads 4] [--out bench/out/x.json] \
//        [--save-text] [--label "before"]
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Asr, loadPcm, SAMPLE_RATE } from "./lib/asr.mjs";
import { getJobs, transcriptFor } from "./lib/strategies.mjs";
import { exitEvidence, exitNow } from "./lib/exit.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

const audioPath = arg("audio");
if (!audioPath) throw new Error("--audio is required");
const strategy = arg("strategy", "current");
const beamWidth = Number(arg("beam", 1));
const threads = Number(arg("threads", 4));
const limitSec = Number(arg("limit", 0));
const outPath = arg("out");
const label = arg("label", "");

const pcmAll = loadPcm(audioPath);
const durationSec = pcmAll.length / SAMPLE_RATE;
const limitSamples = limitSec > 0 ? Math.min(pcmAll.length, Math.round(limitSec * SAMPLE_RATE)) : pcmAll.length;
const pcm = pcmAll.subarray(0, limitSamples);
const clippedDuration = pcm.length / SAMPLE_RATE;

const asr = await Asr.create({ threads });

// Warm-up: one short decode so the first measured tick is not paying for
// lazy kernel/allocator setup that only happens once per session.
await asr.decode(pcm.subarray(0, Math.min(pcm.length, SAMPLE_RATE * 2)), { beamWidth });

const jobs = getJobs(strategy, pcm.length);
const rows = [];
const texts = [];

const wallStart = performance.now();
for (const job of jobs) {
  const result = await asr.decode(pcm.subarray(job.start, job.end), { beamWidth });
  rows.push({
    audioMs: Math.round(((job.end - job.start) / SAMPLE_RATE) * 1000),
    wallMs: Math.round(result.inferMs * 10) / 10,
    frames: result.frames,
    chars: result.text.length
  });
  texts.push(result.text);
}
const wallMs = performance.now() - wallStart;

const pct = (arr, q) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : 0;
const sorted = rows.map((r) => r.wallMs).sort((a, b) => a - b);
const audioProcessedSec = rows.reduce((a, r) => a + r.audioMs, 0) / 1000;
const transcript = transcriptFor(strategy, jobs, texts);

const summary = {
  label,
  audio: path.basename(audioPath),
  audioDurationSec: Math.round(durationSec * 10) / 10,
  clippedDurationSec: Math.round(clippedDuration * 10) / 10,
  strategy,
  beamWidth,
  threads,
  decodes: rows.length,
  audioProcessedSec: Math.round(audioProcessedSec * 10) / 10,
  computeOverRealtime: Math.round((audioProcessedSec / clippedDuration) * 100) / 100,
  wallSec: Math.round(wallMs / 100) / 10,
  realTimeFactorOfWholeRun: Math.round((wallMs / 1000 / clippedDuration) * 1000) / 1000,
  inferMs: {
    p50: Math.round(pct(sorted, 0.5) * 10) / 10,
    p95: Math.round(pct(sorted, 0.95) * 10) / 10,
    max: Math.round((sorted[sorted.length - 1] || 0) * 10) / 10
  },
  chars: transcript.length,
  rssMb: Math.round(process.memoryUsage().rss / 1048576)
};

console.log(JSON.stringify(summary, null, 2));
console.log(`\n--- transcript (${transcript.length} chars) ---\n${transcript.slice(0, 1500)}${transcript.length > 1500 ? "\n…" : ""}`);

// Evidence before release: whatever is listed here is what the run left
// behind, which is the state that decides whether the process can exit (F-007).
const exit = exitEvidence();

if (outPath) {
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ summary, rows, transcript, exit }, null, 2));
  // Completion marker, written before release: the sweep driver kills a process
  // that will not exit, and must know whether the results on disk are whole
  // before it does.
  writeFileSync(`${outPath}.done`, JSON.stringify({ at: new Date().toISOString(), ...exit }));
  console.log(`\nwrote ${outPath}`);
}

// Release is best-effort and can block inside native teardown, so it happens
// only after the results are on disk.
await asr.dispose();
await exitNow(0);
