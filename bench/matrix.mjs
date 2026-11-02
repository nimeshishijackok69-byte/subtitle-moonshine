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
import { exitEvidence, exitNow } from "./lib/exit.mjs";

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
const progress = Boolean(arg("progress", false));
const decodeTimeoutMs = Number(arg("decodeTimeout", 0));

const pcmAll = loadPcm(audioPath);
const pcm = pcmAll.subarray(0, Math.min(pcmAll.length, Math.round(limitSec * SAMPLE_RATE)));
const clipSec = pcm.length / SAMPLE_RATE;
const asr = await Asr.create({ threads });
await asr.decode(pcm.subarray(0, Math.min(pcm.length, SAMPLE_RATE * 2))); // warm-up

const pct = (arr, q) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : 0;

const runs = [];
const result = { audio: path.basename(audioPath), clipSec, threads, runs };

// Persist after every run, not only at the end: a sweep killed during its last
// configuration must still leave the earlier rows on disk.
function persist(extra) {
  if (!outPath) return;
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(extra ? { ...result, ...extra } : result, null, 2));
}
for (const strategy of (arg("strategies", "current,fixed2s250,fixed1s5_250,final8") + "").split(",")) {
  for (const beamWidth of (arg("beams", "1,8") + "").split(",").map(Number)) {
    const jobs = getJobs(strategy, pcm.length);
    const walls = [];
    const frontends = [];
    const runTimes = [];
    const texts = [];
    const started = performance.now();
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      if (progress) {
        process.stderr.write(`\r${strategy} beam=${beamWidth} [${i + 1}/${jobs.length}] window=${((job.end - job.start) / SAMPLE_RATE).toFixed(2)}s   `);
      }
      const decode = asr.decode(pcm.subarray(job.start, job.end), { beamWidth });
      const r = decodeTimeoutMs > 0
        ? await Promise.race([
          decode,
          new Promise((_, reject) => setTimeout(() => reject(new Error(
            `decode timeout after ${decodeTimeoutMs}ms: ${strategy} job ${i + 1}/${jobs.length} window=${((job.end - job.start) / SAMPLE_RATE).toFixed(2)}s`
          )), decodeTimeoutMs).unref?.())
        ])
        : await decode;
      walls.push(r.inferMs);
      frontends.push(r.frontendMs || 0);
      runTimes.push(r.runMs || 0);
      texts.push(r.text);
    }
    if (progress) process.stderr.write("\n");
    const wallMs = performance.now() - started;
    const audioProcessed = jobs.reduce((a, j) => a + (j.end - j.start), 0) / SAMPLE_RATE;
    const sorted = [...walls].sort((a, b) => a - b);
    const sortedFrontend = [...frontends].sort((a, b) => a - b);
    const sortedRun = [...runTimes].sort((a, b) => a - b);
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
      // session.run alone, no frontend and no argmax: this is the number the
      // extension's asr.inferMs measures, so it is the only one a browser report
      // can be compared against.
      p50RunMs: Math.round(pct(sortedRun, 0.5) * 10) / 10,
      p95RunMs: Math.round(pct(sortedRun, 0.95) * 10) / 10,
      chars: transcript.length,
      transcript
    });
    console.log(`${strategy.padEnd(14)} beam=${beamWidth}  decodes=${String(jobs.length).padStart(3)}  ` +
      `compute=${String(runs.at(-1).computeOverRealtime).padStart(5)}x  p50=${String(runs.at(-1).p50InferMs).padStart(7)}ms  p95=${String(runs.at(-1).p95InferMs).padStart(7)}ms  ` +
      `frontendP50=${String(runs.at(-1).p50FrontendMs).padStart(6)}ms`);
    persist();
  }
}

// Evidence before release: whatever is listed here is what the run left
// behind, which is the state that decides whether the process can exit (F-007).
const exit = exitEvidence();
persist({ exit });

if (outPath) {
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
