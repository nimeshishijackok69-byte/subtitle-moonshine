// Text utilities for scoring: reference parsing (SRT/VTT/txt), normalisation
// and CER. Japanese CER is computed on characters; punctuation and whitespace
// are stripped by default because ASR punctuation is a separate problem from
// character accuracy.
import { readFileSync } from "node:fs";

export function parseReference(file) {
  const raw = readFileSync(file, "utf8");
  if (/\.(srt|vtt)$/i.test(file)) {
    return raw
      .split(/\r?\n\r?\n/)
      .map((block) =>
        block
          .split(/\r?\n/)
          .filter((line) => line && !/^\d+$/.test(line) && !/-->/.test(line) && !/^WEBVTT/.test(line))
          .join(" ")
      )
      .filter(Boolean)
      .join(" ");
  }
  if (/\.json$/i.test(file)) {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data.map((d) => d.text ?? "").join(" ") : String(data.text ?? "");
  }
  return raw.replace(/\r?\n/g, " ");
}

const PUNCT = /[、。，．,.!?！？「」『』（）()\[\]{}〈〉《》…‥・:;~〜\-—–'"“”‘’\s]/g;

export function normalize(text, { keepPunct = false } = {}) {
  let out = String(text || "").normalize("NFKC");
  if (!keepPunct) out = out.replace(PUNCT, "");
  return out.replace(/\s+/g, "").trim();
}

export function longestCommonPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

// Levenshtein distance with a rolling row (O(n) memory). Japanese references
// for a 24-minute episode are ~5k characters, so O(n*m) is fine.
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Uint32Array(b.length + 1);
  let cur = new Uint32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

export function cer(reference, hypothesis, options) {
  const ref = normalize(reference, options);
  const hyp = normalize(hypothesis, options);
  if (!ref.length) return { cer: null, refChars: 0, hypChars: hyp.length, errors: null };
  const errors = levenshtein(ref, hyp);
  return { cer: Math.round((errors / ref.length) * 10000) / 10000, refChars: ref.length, hypChars: hyp.length, errors };
}

// Aligned diff for eyeballing a failing region instead of just a number.
export function diffSample(reference, hypothesis, span = 12) {
  const a = normalize(reference);
  const b = normalize(hypothesis);
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return {
        at: i,
        ref: a.slice(Math.max(0, i - span), i + span),
        hyp: b.slice(Math.max(0, i - span), i + span)
      };
    }
  }
  return null;
}
