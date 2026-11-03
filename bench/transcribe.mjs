#!/usr/bin/env node
// One-pass transcription of a whole file, used to build hypothesis transcripts
// for CER scoring against a stronger offline model. The strategy decides whether
// that is the accuracy floor (8 s non-overlapping windows) or the shipped
// growing-window policy, so a CER comparison can be made against the pipeline the
// extension actually runs.
//
// Usage:
//   node bench/transcribe.mjs --audio <raw> --out out/ep01_final8.txt [--strategy final8] [--beam 8] [--threads 4] [--start 30] [--limit 150]
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Asr, loadPcm, SAMPLE_RATE } from "./lib/asr.mjs";
import { getJobs, transcriptFor } from "./lib/strategies.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const audioPath = arg("audio");
if (!audioPath) throw new Error("--audio is required");
const outPath = arg("out", "out/transcript.txt");
const strategy = arg("strategy", "final8");
const beamWidth = Number(arg("beam", 1));
const threads = Number(arg("threads", 4));
const limitSec = Number(arg("limit", 0));
const startSec = Number(arg("start", 0));

const allPcm = loadPcm(audioPath);
// The reference transcript is produced per time slice (an OP or ED with sung
// vocals makes every model hallucinate differently), so the hypothesis has to
// cover exactly the same audio or the CER scores two different clips.
const from = Math.round(startSec * SAMPLE_RATE);
const pcm = allPcm.subarray(
  from,
  limitSec > 0 ? from + Math.round(limitSec * SAMPLE_RATE) : allPcm.length
);
const asr = await Asr.create({ threads });
const jobs = getJobs(strategy, pcm.length);
const texts = [];
const started = performance.now();

for (let i = 0; i < jobs.length; i++) {
  const job = jobs[i];
  const r = await asr.decode(pcm.subarray(job.start, job.end), { beamWidth });
  texts.push(r.text);
  if ((i + 1) % 10 === 0) {
    const done = (job.end / SAMPLE_RATE).toFixed(0);
    process.stderr.write(`\r${done}s / ${(pcm.length / SAMPLE_RATE).toFixed(0)}s  `);
  }
}

const wall = (performance.now() - started) / 1000;
// Growing-window strategies repeat the whole utterance on every tick, so
// concatenating them would multiply the transcript; transcriptFor keeps the last
// decode per segment instead.
const text = transcriptFor(strategy, jobs, texts);
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, text + "\n");
console.log(`\n${outPath}: ${strategy} beam=${beamWidth} ${jobs.length} decodes, ${text.length} chars, ${wall.toFixed(1)}s wall, ` +
  `${(wall / (pcm.length / SAMPLE_RATE)).toFixed(3)} RTF`);
