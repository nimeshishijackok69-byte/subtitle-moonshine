#!/usr/bin/env node
// Compare a reference transcript (SRT/VTT/txt, e.g. produced later by a
// stronger offline model) against a bench transcript file.
//
// Usage:
//   node bench/compare.mjs --reference ep01.srt --hypothesis bench/out/ep01_current.txt
import { readFileSync } from "node:fs";
import { parseReference, cer, diffSample, normalize } from "./lib/text.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const refPath = arg("reference");
const hypPath = arg("hypothesis");
if (!refPath || !hypPath) throw new Error("--reference and --hypothesis are required");

const reference = parseReference(refPath);
const hypothesis = readFileSync(hypPath, "utf8");

const withPunct = cer(reference, hypothesis, { keepPunct: true });
const withoutPunct = cer(reference, hypothesis, { keepPunct: false });
const diff = diffSample(reference, hypothesis);

console.log(JSON.stringify({
  referenceChars: normalize(reference).length,
  hypothesisChars: normalize(hypothesis).length,
  cerWithPunctuation: withPunct.cer,
  cerCharacterOnly: withoutPunct.cer,
  errors: withoutPunct.errors,
  firstDivergence: diff
}, null, 2));
