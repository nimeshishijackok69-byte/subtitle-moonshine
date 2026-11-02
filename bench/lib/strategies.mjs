// Window strategies mirror what the extension does today and the alternatives
// proposed in docs/PLAN_10X.md. Each returns decode jobs as sample offsets, so
// the runner can time them without knowing which strategy produced them.
import { SAMPLE_RATE } from "./asr.mjs";

const s = (sec) => Math.round(sec * SAMPLE_RATE);

export function getJobs(strategy, totalSamples) {
  const jobs = [];
  switch (strategy) {
    // Current extension behaviour: an utterance anchor grows to an 8 s cap,
    // decoded every 750 ms (first decode once MIN_UTTERANCE = 1 s is available).
    case "current": {
      let seg = 0;
      for (let segStart = 0; segStart < totalSamples; segStart += s(8), seg++) {
        const segEnd = Math.min(segStart + s(8), totalSamples);
        for (let t = s(1); ; t += s(0.75)) {
          const start = segStart;
          const end = Math.min(segStart + t, segEnd);
          if (end <= start) break;
          jobs.push({ start, end, label: "current", seg });
          if (start + t >= segEnd) break;
        }
      }
      return jobs;
    }
    // Fixed short window, small hop: constant per-tick cost, lower latency.
    case "fixed2s250": return fixed(totalSamples, 2, 0.25);
    case "fixed2s500": return fixed(totalSamples, 2, 0.5);
    case "fixed2s750": return fixed(totalSamples, 2, 0.75);
    case "fixed2s1000": return fixed(totalSamples, 2, 1.0);
    case "fixed1s5_250": return fixed(totalSamples, 1.5, 0.25);
    case "fixed3s500": return fixed(totalSamples, 3, 0.5);
    case "fixed3s750": return fixed(totalSamples, 3, 0.75);
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
  if (strategy !== "current") {
    return strategy.startsWith("fixed") ? stitch(texts) : texts.join(" ");
  }
  const lastPerSeg = new Map();
  jobs.forEach((job, i) => lastPerSeg.set(job.seg, texts[i]));
  return [...lastPerSeg.values()].filter(Boolean).join(" ");
}
