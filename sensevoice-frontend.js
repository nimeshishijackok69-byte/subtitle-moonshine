(function (global) {
  "use strict";

  const SAMPLE_RATE = 16000;
  const FRAME_LENGTH = 400;
  const FRAME_SHIFT = 160;
  const FFT_SIZE = 512;
  const NUM_BINS = 80;
  const LOW_FREQ = 20;
  const HIGH_FREQ = 8000;
  const PREEMPHASIS = 0.97;
  const LFR_M = 7;
  const LFR_N = 6;
  const MEL_SCALE = 1127;

  function mel(f) {
    return MEL_SCALE * Math.log(1 + f / 700);
  }

  function buildBitReverse() {
    const table = new Uint16Array(FFT_SIZE);
    const bits = Math.log2(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i += 1) {
      let value = i;
      let reversed = 0;
      for (let bit = 0; bit < bits; bit += 1) {
        reversed = (reversed << 1) | (value & 1);
        value >>= 1;
      }
      table[i] = reversed;
    }
    return table;
  }

  function buildTwiddles() {
    const cos = new Float64Array(FFT_SIZE / 2);
    const sin = new Float64Array(FFT_SIZE / 2);
    for (let i = 0; i < FFT_SIZE / 2; i += 1) {
      const angle = (-2 * Math.PI * i) / FFT_SIZE;
      cos[i] = Math.cos(angle);
      sin[i] = Math.sin(angle);
    }
    return { cos, sin };
  }

  function buildMelFilters() {
    const lowMel = mel(LOW_FREQ);
    const highMel = mel(HIGH_FREQ);
    const points = new Float64Array(NUM_BINS + 2);
    for (let i = 0; i < points.length; i += 1) {
      points[i] = lowMel + ((highMel - lowMel) * i) / (NUM_BINS + 1);
    }

    const binMel = new Float64Array(FFT_SIZE / 2 + 1);
    for (let i = 0; i < binMel.length; i += 1) {
      binMel[i] = mel((i * SAMPLE_RATE) / FFT_SIZE);
    }

    const weights = [];
    for (let filter = 1; filter <= NUM_BINS; filter += 1) {
      const left = points[filter - 1];
      const center = points[filter];
      const right = points[filter + 1];
      const index = [];
      const value = [];
      for (let bin = 0; bin < binMel.length; bin += 1) {
        const m = binMel[bin];
        let weight = 0;
        if (m >= left && m <= center) {
          weight = (m - left) / (center - left);
        } else if (m > center && m <= right) {
          weight = (right - m) / (right - center);
        }
        if (weight > 0) {
          index.push(bin);
          value.push(weight);
        }
      }
      weights.push({ index: Uint16Array.from(index), value: Float64Array.from(value) });
    }
    return weights;
  }

  function buildWindow() {
    const window = new Float64Array(FRAME_LENGTH);
    for (let i = 0; i < FRAME_LENGTH; i += 1) {
      window[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME_LENGTH - 1));
    }
    return window;
  }

  class SenseVoiceFrontend {
    constructor(config) {
      this.negMean = Float32Array.from(config.negMean);
      this.invStd = Float32Array.from(config.invStd);
      this.language = config.language ?? 11;
      this.textNorm = config.textNorm ?? 14;
      this.bitReverse = buildBitReverse();
      this.twiddles = buildTwiddles();
      this.melFilters = buildMelFilters();
      this.window = buildWindow();
      this.re = new Float64Array(FFT_SIZE);
      this.im = new Float64Array(FFT_SIZE);
      this.power = new Float64Array(FFT_SIZE / 2 + 1);
      this.frame = new Float64Array(FRAME_LENGTH);
    }

    computeFeatures(samples) {
      if (!samples || samples.length < FRAME_LENGTH) return null;

      const frameCount = 1 + Math.floor((samples.length - FRAME_LENGTH) / FRAME_SHIFT);
      if (frameCount < 1) return null;

      const fbank = new Float32Array(frameCount * NUM_BINS);
      for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        const offset = frameIndex * FRAME_SHIFT;
        let mean = 0;
        for (let i = 0; i < FRAME_LENGTH; i += 1) {
          const value = samples[offset + i];
          this.frame[i] = value;
          mean += value;
        }
        mean /= FRAME_LENGTH;
        for (let i = 0; i < FRAME_LENGTH; i += 1) this.frame[i] -= mean;

        for (let i = FRAME_LENGTH - 1; i > 0; i -= 1) {
          this.frame[i] -= PREEMPHASIS * this.frame[i - 1];
        }
        this.frame[0] -= PREEMPHASIS * this.frame[0];

        this.re.fill(0);
        this.im.fill(0);
        for (let i = 0; i < FRAME_LENGTH; i += 1) {
          this.re[i] = this.frame[i] * this.window[i];
        }

        this.fft();
        const power = this.power;
        for (let i = 0; i < power.length; i += 1) {
          power[i] = this.re[i] * this.re[i] + this.im[i] * this.im[i];
        }

        const base = frameIndex * NUM_BINS;
        for (let filter = 0; filter < NUM_BINS; filter += 1) {
          const spec = this.melFilters[filter];
          let energy = 0;
          for (let i = 0; i < spec.index.length; i += 1) {
            energy += power[spec.index[i]] * spec.value[i];
          }
          fbank[base + filter] = Math.log(Math.max(energy, 1.1920929e-7));
        }
      }

      return this.applyLfr(fbank, frameCount);
    }

    fft() {
      const re = this.re;
      const im = this.im;
      const reverse = this.bitReverse;
      for (let i = 0; i < FFT_SIZE; i += 1) {
        const j = reverse[i];
        if (j > i) {
          const tr = re[i];
          const ti = im[i];
          re[i] = re[j];
          im[i] = im[j];
          re[j] = tr;
          im[j] = ti;
        }
      }

      const cos = this.twiddles.cos;
      const sin = this.twiddles.sin;
      for (let size = 2; size <= FFT_SIZE; size <<= 1) {
        const half = size >> 1;
        const step = FFT_SIZE / size;
        for (let start = 0; start < FFT_SIZE; start += size) {
          for (let j = 0; j < half; j += 1) {
            const k = j * step;
            const a = start + j;
            const b = a + half;
            const tr = re[b] * cos[k] - im[b] * sin[k];
            const ti = re[b] * sin[k] + im[b] * cos[k];
            re[b] = re[a] - tr;
            im[b] = im[a] - ti;
            re[a] += tr;
            im[a] += ti;
          }
        }
      }
    }

    applyLfr(fbank, frameCount) {
      const leftPad = Math.floor((LFR_M - 1) / 2);
      const lfrFrames = Math.ceil(frameCount / LFR_N);
      const paddedCount = frameCount + leftPad;
      const lastIndex = Math.floor((paddedCount - LFR_M) / LFR_N) + 1;
      let padding = LFR_M - (paddedCount - lastIndex * LFR_N);
      let extra = 0;
      if (padding > 0) {
        extra = Math.floor(
          ((2 * LFR_M - 2 * paddedCount + (lfrFrames - 1 + lastIndex) * LFR_N) / 2) *
            (lfrFrames - lastIndex)
        );
      }

      const sourceFrames = paddedCount + Math.max(0, extra);
      const source = new Float32Array(sourceFrames * NUM_BINS);
      for (let i = 0; i < leftPad; i += 1) {
        source.set(fbank.subarray(0, NUM_BINS), i * NUM_BINS);
      }
      source.set(fbank, leftPad * NUM_BINS);
      for (let i = 0; i < extra; i += 1) {
        const src = (paddedCount - 1) * NUM_BINS;
        const dst = (paddedCount + i) * NUM_BINS;
        source.set(source.subarray(src, src + NUM_BINS), dst);
      }

      const dim = NUM_BINS * LFR_M;
      const out = new Float32Array(lfrFrames * dim);
      for (let t = 0; t < lfrFrames; t += 1) {
        const src = t * LFR_N * NUM_BINS;
        const dst = t * dim;
        for (let m = 0; m < LFR_M; m += 1) {
          const from = src + m * NUM_BINS;
          const to = dst + m * NUM_BINS;
          for (let d = 0; d < NUM_BINS; d += 1) {
            const value = source[from + d] || 0;
            out[to + d] = (value + this.negMean[m * NUM_BINS + d]) * this.invStd[m * NUM_BINS + d];
          }
        }
      }

      return { data: out, frames: lfrFrames, dim };
    }
  }

  global.SenseVoiceFrontend = SenseVoiceFrontend;
  if (typeof module !== "undefined" && module.exports) module.exports = SenseVoiceFrontend;
})(globalThis);
