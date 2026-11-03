// Window strategies mirror what the extension does today and the alternatives
// proposed in docs/PLAN_10X.md. Each returns decode jobs as sample offsets, so
// the runner can time them without knowing which strategy produced them.
import { SAMPLE_RATE } from "./asr.mjs";

const s = (sec) => Math.round(sec * SAMPLE_RATE);

// Canonical fixed form is `fixed<windowSeconds>s<hopMs>`: fixed2s750 is a 2 s
// window with a 750 ms hop. Parsed rather than enumerated so any window/hop pair
// works, including the 4/6/8 s rows the browser's per-window timing buckets need
// to be compared against.
const FIXED = /^fixed(\d+(?:\.\d+)?)s(\d+)$/;
const ALIASES = { fixed1s5_250: "fixed1.5s250" };
// Growing-anchor policy: `current` is the shipped cadence, `current750` the same
// policy at an older hop. Kept parseable so a policy change can be priced
// against the one before it without editing the harness.
const CURRENT = /^current(?:(\d+))?$/;
const SHIPPED_HOP_MS = 500;

export function getJobs(strategy, totalSamples) {
  const jobs = [];
  const fixedMatch = FIXED.exec(ALIASES[strategy] || strategy);
  if (fixedMatch) {
    return fixed(totalSamples, Number(fixedMatch[1]), Number(fixedMatch[2]) / 1000);
  }
  const currentMatch = CURRENT.exec(strategy);
  if (currentMatch) {
    return current(totalSamples, Number(currentMatch[1] || SHIPPED_HOP_MS) / 1000);
  }
  switch (strategy) {
    // One decode per 8 s chunk: the floor for compute (accuracy reference).
    case "final8": {
      for (let start = 0; start < totalSamples; start += s(8)) {
        jobs.push({ start, end: Math.min(start + s(8), totalSamples), label: "final8" });
      }
      return jobs;
    }
    default: throw new Error(`unknown strategy: ${strategy}`);
  }
}

// The shipped pipeline: an utterance anchor grows to an 8 s cap, decoded every
// `hopSec` once MIN_UTTERANCE = 1 s of window is available. The first decode is
// scheduled by the extension at the instant the minimum window exists, which is
// why this starts at 1 s rather than at the first hop boundary.
function current(totalSamples, hopSec) {
  const jobs = [];
  let seg = 0;
  for (let segStart = 0; segStart < totalSamples; segStart += s(8), seg++) {
    const segEnd = Math.min(segStart + s(8), totalSamples);
    for (let t = s(1); ; t += s(hopSec)) {
      const start = segStart;
      const end = Math.min(segStart + t, segEnd);
      if (end <= start) break;
      jobs.push({ start, end, label: `current${Math.round(hopSec * 1000)}`, seg });
      if (start + t >= segEnd) break;
    }
  }
  return jobs;
}

function fixed(totalSamples, windowSec, hopSec) {
  const jobs = [];
  for (let end = s(windowSec); end <= totalSamples; end += s(hopSec)) {
    jobs.push({ start: end - s(windowSec), end, label: `fixed${windowSec}s_${hopSec}s` });
  }
  return jobs;
}

// Stitch decode outputs left-to-right, using the longest common prefix of
// consecutive windows to drop the re-decoded overlap. Not for growing-window
// strategies (see transcriptFor).
export function stitch(texts) {
  let out = "";
  let previous = "";
  for (const text of texts) {
    if (!text) continue;
    let k = 0;
    const max = Math.min(previous.length, text.length);
    while (k < max && previous[k] === text[k]) k++;
    out += text.slice(k);
    previous = text;
  }
  return out;
}

// Growing-window decodes repeat the whole utterance on every tick; concatenating
// them multiplies the transcript. Take the last (longest) decode per segment.
export function transcriptFor(strategy, jobs, texts) {
  if (!CURRENT.test(strategy)) {
    return strategy.startsWith("fixed") ? stitch(texts) : texts.join(" ");
  }
  const lastPerSeg = new Map();
  jobs.forEach((job, i) => lastPerSeg.set(job.seg, texts[i]));
  return [...lastPerSeg.values()].filter(Boolean).join(" ");
}
