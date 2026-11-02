#!/usr/bin/env node
// One-pass transcription of a whole file (8 s non-overlapping windows), used
// to build hypothesis transcripts for CER scoring against a stronger offline
// model later. Deliberately not the extension pipeline's progressive decode:
// this is the accuracy floor, not the latency path.
//
// Usage:
//   node bench/transcribe.mjs --audio <raw> --out out/ep01_final8.txt [--beam 8] [--threads 4]
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Asr, loadPcm, SAMPLE_RATE } from "./lib/asr.mjs";
import { getJobs } from "./lib/strategies.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const audioPath = arg("audio");
if (!audioPath) throw new Error("--audio is required");
const outPath = arg("out", "out/transcript.txt");
const beamWidth = Number(arg("beam", 1));
const threads = Number(arg("threads", 4));

const pcm = loadPcm(audioPath);
const asr = await Asr.create({ threads });
const jobs = getJobs("final8", pcm.length);
const lines = [];
const started = performance.now();

for (let i = 0; i < jobs.length; i++) {
  const job = jobs[i];
  const r = await asr.decode(pcm.subarray(job.start, job.end), { beamWidth });
  if (r.text) lines.push(r.text);
  if ((i + 1) % 10 === 0) {
    const done = (job.end / SAMPLE_RATE).toFixed(0);
    process.stderr.write(`\r${done}s / ${(pcm.length / SAMPLE_RATE).toFixed(0)}s  `);
  }
}

const wall = (performance.now() - started) / 1000;
const text = lines.join("\n");
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, text + "\n");
console.log(`\n${outPath}: ${lines.length} segments, ${text.length} chars, ${wall.toFixed(1)}s wall, ` +
  `${(wall / (pcm.length / SAMPLE_RATE)).toFixed(3)} RTF`);
