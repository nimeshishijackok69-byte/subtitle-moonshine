(function (global) {
  "use strict";

  const SAMPLE_RATE = 16000;
  const FRAME_LENGTH = 400;
  const FRAME_SHIFT = 160;
  const FFT_SIZE = 512;
  const HALF_FFT = FFT_SIZE >> 1; // 256-pt complex FFT for 512-pt real sequence
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

  function buildBitReverse(size) {
    const table = new Uint16Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i += 1) {
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

  function buildTwiddles(size) {
    const half = size >> 1;
    const cos = new Float64Array(half);
    const sin = new Float64Array(half);
    for (let i = 0; i < half; i += 1) {
      const angle = (-2 * Math.PI * i) / size;
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

    const binMel = new Float64Array(HALF_FFT + 1);
    for (let i = 0; i < binMel.length; i += 1) {
      binMel[i] = mel((i * SAMPLE_RATE) / FFT_SIZE);
    }

    const melStart = new Uint16Array(NUM_BINS);
    const melEnd = new Uint16Array(NUM_BINS);
    const melWOff = new Uint16Array(NUM_BINS);
    const flatWeights = [];

    for (let filter = 1; filter <= NUM_BINS; filter += 1) {
      const left = points[filter - 1];
      const center = points[filter];
      const right = points[filter + 1];
      const fIdx = filter - 1;
      let start = -1;
      let end = 0;
      melWOff[fIdx] = flatWeights.length;
      for (let bin = 0; bin < binMel.length; bin += 1) {
        const m = binMel[bin];
        let weight = 0;
        if (m >= left && m <= center) {
          weight = (m - left) / (center - left);
        } else if (m > center && m <= right) {
          weight = (right - m) / (right - center);
        }
        if (weight > 0) {
          if (start === -1) start = bin;
          end = bin + 1;
          flatWeights.push(weight);
        }
      }
      melStart[fIdx] = start === -1 ? 0 : start;
      melEnd[fIdx] = end;
    }

    return {
      melStart,
      melEnd,
      melWOff,
      melWeights: Float64Array.from(flatWeights)
    };
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
      this.bitReverse = buildBitReverse(HALF_FFT);
      this.twiddles256 = buildTwiddles(HALF_FFT);
      this.unpackTwiddles = buildTwiddles(FFT_SIZE);
      this.mel = buildMelFilters();
      this.window = buildWindow();
      this.re = new Float64Array(HALF_FFT);
      this.im = new Float64Array(HALF_FFT);
      this.power = new Float64Array(HALF_FFT + 1);
      this.fbankBuf = new Float32Array(0);
      this.lfrOutBuf = new Float32Array(0);
      this.cacheKey = null;
      this.cachedFrames = 0;
      this.cachedSampleLen = 0;
    }

    invalidateCache() {
      this.cacheKey = null;
      this.cachedFrames = 0;
      this.cachedSampleLen = 0;
    }

    computeFeatures(samples, cacheKey = null) {
      if (!samples || samples.length < FRAME_LENGTH) return null;

      const frameCount = 1 + Math.floor((samples.length - FRAME_LENGTH) / FRAME_SHIFT);
      if (frameCount < 1) return null;

      const fbankLen = frameCount * NUM_BINS;
      if (this.fbankBuf.length < fbankLen) {
        const grown = new Float32Array(fbankLen);
        if (this.cachedFrames > 0) {
          grown.set(this.fbankBuf.subarray(0, this.cachedFrames * NUM_BINS));
        }
        this.fbankBuf = grown;
      }
      const fbank = this.fbankBuf.subarray(0, fbankLen);

      let startFrame = 0;
      if (
        cacheKey !== null &&
        cacheKey === this.cacheKey &&
        samples.length >= this.cachedSampleLen &&
        this.cachedFrames > 0 &&
        this.cachedFrames <= frameCount
      ) {
        startFrame = this.cachedFrames;
      }

      const win = this.window;
      const re = this.re;
      const im = this.im;
      const power = this.power;
      const { melStart, melEnd, melWOff, melWeights } = this.mel;
      const oneMinusPre = 1 - PREEMPHASIS;

      for (let frameIndex = startFrame; frameIndex < frameCount; frameIndex += 1) {
        const offset = frameIndex * FRAME_SHIFT;
        let mean = 0;
        for (let i = 0; i < FRAME_LENGTH; i += 1) {
          mean += samples[offset + i];
        }
        mean /= FRAME_LENGTH;
        const dcBias = oneMinusPre * mean;

        // Fused DC removal, pre-emphasis, Hamming window, and real-to-complex
        // 256-pt packing: re[n] = frame[2n], im[n] = frame[2n+1].
        re.fill(0);
        im.fill(0);
        let prev = samples[offset];
        re[0] = (prev * oneMinusPre - dcBias) * win[0];
        let cur = samples[offset + 1];
        im[0] = (cur - PREEMPHASIS * prev - dcBias) * win[1];
        prev = cur;

        for (let i = 2; i < FRAME_LENGTH; i += 2) {
          const s0 = samples[offset + i];
          const w0 = (s0 - PREEMPHASIS * prev - dcBias) * win[i];
          const s1 = samples[offset + i + 1];
          const w1 = (s1 - PREEMPHASIS * s0 - dcBias) * win[i + 1];
          prev = s1;
          const idx = i >> 1;
          re[idx] = w0;
          im[idx] = w1;
        }

        this.fft256();
        this.computeRealSpectrumPower();

        const base = frameIndex * NUM_BINS;
        for (let filter = 0; filter < NUM_BINS; filter += 1) {
          const sBin = melStart[filter];
          const eBin = melEnd[filter];
          let w = melWOff[filter];
          let energy = 0;
          for (let bin = sBin; bin < eBin; bin += 1, w += 1) {
            energy += power[bin] * melWeights[w];
          }
          fbank[base + filter] = Math.log(energy > 1.1920929e-7 ? energy : 1.1920929e-7);
        }
      }

      if (cacheKey !== null) {
        this.cacheKey = cacheKey;
        this.cachedFrames = frameCount;
        this.cachedSampleLen = samples.length;
      }

      return this.applyLfrDirect(fbank, frameCount);
    }

    fft256() {
      const re = this.re;
      const im = this.im;
      const reverse = this.bitReverse;
      for (let i = 0; i < HALF_FFT; i += 1) {
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

      const cos = this.twiddles256.cos;
      const sin = this.twiddles256.sin;
      for (let size = 2; size <= HALF_FFT; size <<= 1) {
        const half = size >> 1;
        const step = HALF_FFT / size;
        for (let j = 0; j < half; j += 1) {
          const k = j * step;
          const ck = cos[k];
          const sk = sin[k];
          for (let a = j; a < HALF_FFT; a += size) {
            const b = a + half;
            const tr = re[b] * ck - im[b] * sk;
            const ti = re[b] * sk + im[b] * ck;
            re[b] = re[a] - tr;
            im[b] = im[a] - ti;
            re[a] += tr;
            im[a] += ti;
          }
        }
      }
    }

    computeRealSpectrumPower() {
      const re = this.re;
      const im = this.im;
      const power = this.power;
      const cos = this.unpackTwiddles.cos;
      const sin = this.unpackTwiddles.sin;

      // DC (k = 0) and Nyquist (k = 256)
      const dc = re[0] + im[0];
      const nyq = re[0] - im[0];
      power[0] = dc * dc;
      power[HALF_FFT] = nyq * nyq;

      // Conjugate-symmetry unpack for bins 1..255
      const halfBins = HALF_FFT >> 1; // 128
      for (let k = 1; k < halfBins; k += 1) {
        const nk = HALF_FFT - k;
        const rk = re[k];
        const ik = im[k];
        const rnk = re[nk];
        const ink = im[nk];

        const evenRe = 0.5 * (rk + rnk);
        const evenIm = 0.5 * (ik - ink);
        const oddRe = 0.5 * (ik + ink);
        const oddIm = 0.5 * (rnk - rk);

        const ck = cos[k];
        const sk = sin[k];
        const twRe = oddRe * ck - oddIm * sk;
        const twIm = oddRe * sk + oddIm * ck;

        const xkRe = evenRe + twRe;
        const xkIm = evenIm + twIm;
        power[k] = xkRe * xkRe + xkIm * xkIm;

        const xnkRe = evenRe - twRe;
        const xnkIm = twIm - evenIm;
        power[nk] = xnkRe * xnkRe + xnkIm * xnkIm;
      }

      const midRe = re[halfBins];
      const midIm = im[halfBins];
      power[halfBins] = midRe * midRe + midIm * midIm;
    }

    applyLfrDirect(fbank, frameCount) {
      const leftPad = (LFR_M - 1) >> 1; // 3
      const lfrFrames = Math.ceil(frameCount / LFR_N);
      const dim = NUM_BINS * LFR_M;
      const outLen = lfrFrames * dim;
      if (this.lfrOutBuf.length < outLen) {
        this.lfrOutBuf = new Float32Array(outLen);
      }
      const out = this.lfrOutBuf.subarray(0, outLen);
      const negMean = this.negMean;
      const invStd = this.invStd;
      const maxFrame = frameCount - 1;

      for (let t = 0; t < lfrFrames; t += 1) {
        const baseFrame = t * LFR_N - leftPad;
        const dstBase = t * dim;
        for (let m = 0; m < LFR_M; m += 1) {
          const rawIdx = baseFrame + m;
          const clampedFrame = rawIdx < 0 ? 0 : rawIdx > maxFrame ? maxFrame : rawIdx;
          const srcOff = clampedFrame * NUM_BINS;
          const mOff = m * NUM_BINS;
          const dstOff = dstBase + mOff;
          for (let d = 0; d < NUM_BINS; d += 1) {
            out[dstOff + d] = (fbank[srcOff + d] + negMean[mOff + d]) * invStd[mOff + d];
          }
        }
      }

      return { data: out, frames: lfrFrames, dim };
    }
  }

  global.SenseVoiceFrontend = SenseVoiceFrontend;
  if (typeof module !== "undefined" && module.exports) module.exports = SenseVoiceFrontend;
})(globalThis);
