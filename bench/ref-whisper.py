#!/usr/bin/env python
"""Generate a reference transcript for a slice of the bench corpus.

The bench can measure milliseconds by itself; it cannot measure accuracy, because
every number it produces is a comparison against nothing. This produces the other
half of that comparison: an independent, stronger-model transcription that
`bench/compare.mjs` can score a pipeline transcript against.

Why Whisper large-v3 and not SenseVoice: the reference has to be better than the
thing under test or the CER mostly measures the reference. large-v3 is the
strongest openly available Japanese model that runs on this machine, and it is a
different architecture and a different frontend, so its mistakes do not correlate
with the pipeline's.

Why raw PCM directly: the corpus is 16 kHz mono s16le and `ep01.raw` has no
container. faster-whisper accepts a float32 ndarray, so slicing is a memoryview
and a division - no ffmpeg, no temporary WAV, no resampling.

Usage (from the repo root, with the venv that has faster-whisper):

    python bench/ref-whisper.py --raw C:/Users/User/bench-audio/ep01.raw \
        --start 0 --duration 180 --out bench/out/ep01_ref_000_180

Writes <out>.srt (for compare.mjs) and <out>.json (segments, for anything that
needs timings). Model weights download on first use.
"""
import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

SAMPLE_RATE = 16000
BYTES_PER_SAMPLE = 2


def read_slice(path: Path, start_s: float, duration_s: float) -> np.ndarray:
    first = int(round(start_s * SAMPLE_RATE))
    count = int(round(duration_s * SAMPLE_RATE))
    with path.open("rb") as fh:
        fh.seek(first * BYTES_PER_SAMPLE)
        raw = fh.read(count * BYTES_PER_SAMPLE)
    if not raw:
        raise SystemExit(f"no audio at {start_s}s in {path}")
    pcm = np.frombuffer(raw, dtype="<i2").astype(np.float32)
    return pcm / 32768.0


def srt_timestamp(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True, help="16 kHz mono s16le PCM file")
    ap.add_argument("--start", type=float, default=0.0, help="slice start, seconds")
    ap.add_argument("--duration", type=float, default=180.0, help="slice length, seconds")
    ap.add_argument("--model", default="large-v3", help="faster-whisper model name or path")
    ap.add_argument("--language", default="ja")
    ap.add_argument("--beam", type=int, default=5)
    ap.add_argument("--compute-type", default="int8", help="int8, int8_float16, float16, float32")
    ap.add_argument("--device", default="cpu", help="cpu or cuda")
    ap.add_argument("--threads", type=int, default=0, help="CPU threads for int8 (0 = library default)")
    ap.add_argument("--out", required=True, help="output prefix, without extension")
    args = ap.parse_args()

    from faster_whisper import WhisperModel

    audio = read_slice(Path(args.raw), args.start, args.duration)
    audio_seconds = len(audio) / SAMPLE_RATE

    load_started = time.perf_counter()
    model = WhisperModel(
        args.model,
        device=args.device,
        compute_type=args.compute_type,
        cpu_threads=args.threads or 0,
    )
    load_s = time.perf_counter() - load_started

    run_started = time.perf_counter()
    segments, info = model.transcribe(
        audio,
        language=args.language,
        beam_size=args.beam,
        # The pipeline under test has its own VAD; a reference that drops the
        # quiet parts would score gaps as deletions.
        vad_filter=False,
        condition_on_previous_text=False,
    )
    collected = [
        {"start": round(s.start, 3), "end": round(s.end, 3), "text": s.text.strip()}
        for s in segments
    ]
    run_s = time.perf_counter() - run_started

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    with out.with_suffix(".srt").open("w", encoding="utf-8", newline="\n") as fh:
        for i, seg in enumerate(collected, 1):
            fh.write(f"{i}\n{srt_timestamp(seg['start'])} --> {srt_timestamp(seg['end'])}\n{seg['text']}\n\n")

    payload = {
        "model": args.model,
        "computeType": args.compute_type,
        "device": args.device,
        "language": info.language,
        "languageProbability": round(info.language_probability, 4),
        "raw": str(Path(args.raw)),
        "startSec": args.start,
        "durationSec": round(audio_seconds, 2),
        "loadSec": round(load_s, 1),
        "transcribeSec": round(run_s, 1),
        "realtimeFactor": round(run_s / audio_seconds, 3) if audio_seconds else None,
        "chars": sum(len(s["text"]) for s in collected),
        "segments": collected,
    }
    out.with_suffix(".json").write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")

    print(
        f"{args.model} {args.compute_type} on {args.device}: {audio_seconds:.0f}s audio, "
        f"{len(collected)} segments, {payload['chars']} chars, "
        f"{run_s:.1f}s transcribe ({payload['realtimeFactor']}x realtime), load {load_s:.1f}s"
    )
    print(f"wrote {out.with_suffix('.srt')} and {out.with_suffix('.json')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
