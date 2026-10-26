const PCM_CHUNK = "PCM_CHUNK";

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const processorOptions = options.processorOptions || {};
    this.targetSampleRate = processorOptions.targetSampleRate || 16000;
    this.chunkSamples = Math.max(
      160,
      Math.round(this.targetSampleRate * (processorOptions.chunkMs || 40) / 1000)
    );
    this.sampleStep = sampleRate / this.targetSampleRate;
    this.nextOutputIndex = 0;
    this.inputIndex = 0;
    this.lastMonoSample = 0;
    this.hasLastSample = false;
    this.pendingBuffer = new Int16Array(this.chunkSamples);
    this.pendingCount = 0;

    // 4th-order cascaded Butterworth lowpass anti-aliasing filter (fc = 7500 Hz at source sampleRate)
    // Stage 1: Q = 1 / (2 * cos(3pi/8)) ~= 1.306563
    // Stage 2: Q = 1 / (2 * cos(pi/8)) ~= 0.541196
    // Only needed when the source rate is above the 16 kHz target. Below that
    // there is nothing to alias, and fc=7500 would sit above the source Nyquist,
    // making alpha negative and the poles unstable (NaN state, then silence).
    const q1 = 1 / (2 * Math.cos((3 * Math.PI) / 8));
    const q2 = 1 / (2 * Math.cos(Math.PI / 8));
    if (sampleRate > this.targetSampleRate) {
      const fc = Math.min(7500, sampleRate * 0.45);
      this.biquad1 = this.designLowPassBiquad(fc, sampleRate, q1);
      this.biquad2 = this.designLowPassBiquad(fc, sampleRate, q2);
    } else {
      this.biquad1 = null;
      this.biquad2 = null;
    }
  }

  designLowPassBiquad(fc, fs, Q) {
    // Bilinear transform lowpass biquad
    const w0 = (2 * Math.PI * fc) / fs;
    const cosw0 = Math.cos(w0);
    const sinw0 = Math.sin(w0);
    const alpha = sinw0 / (2 * Q);
    const b0 = (1 - cosw0) / 2;
    const b1 = 1 - cosw0;
    const b2 = (1 - cosw0) / 2;
    const a0 = 1 + alpha;
    const a1 = -2 * cosw0;
    const a2 = 1 - alpha;
    return {
      b0: b0 / a0,
      b1: b1 / a0,
      b2: b2 / a0,
      a1: a1 / a0,
      a2: a2 / a0,
      s1: 0,
      s2: 0
    };
  }

  processBiquad(b, x) {
    // Direct Form II Transposed
    const y = b.b0 * x + b.s1;
    b.s1 = b.b1 * x - b.a1 * y + b.s2;
    b.s2 = b.b2 * x - b.a2 * y;
    return y;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    if (output?.[0]) {
      output[0].fill(0);
    }

    if (!input || input.length === 0 || input[0].length === 0) {
      return true;
    }

    const frameLength = input[0].length;
    const channels = input.length;

    for (let i = 0; i < frameLength; i += 1) {
      let monoSample = 0;
      for (let channel = 0; channel < channels; channel += 1) {
        monoSample += input[channel][i] || 0;
      }
      monoSample /= channels;

      // 4th-order anti-aliasing filter (bypassed when the source rate is already
      // at or below the 16 kHz target)
      if (this.biquad1) {
        monoSample = this.processBiquad(this.biquad2, this.processBiquad(this.biquad1, monoSample));
      }

      if (!this.hasLastSample) {
        this.lastMonoSample = monoSample;
        this.hasLastSample = true;
        this.inputIndex += 1;
        continue;
      }

      while (this.nextOutputIndex <= this.inputIndex) {
        const fraction = this.nextOutputIndex - (this.inputIndex - 1);
        const interpolated = this.lastMonoSample + (monoSample - this.lastMonoSample) * fraction;
        const clamped = Math.max(-1, Math.min(1, interpolated));
        const pcmSample = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
        this.pendingBuffer[this.pendingCount] = pcmSample;
        this.pendingCount += 1;

        if (this.pendingCount >= this.chunkSamples) {
          this.flushChunk();
        }

        this.nextOutputIndex += this.sampleStep;
      }

      this.lastMonoSample = monoSample;
      this.inputIndex += 1;
    }

    // Re-baseline indices to prevent numeric precision drift over long sessions
    if (this.inputIndex > 1000000) {
      this.inputIndex -= 1000000;
      this.nextOutputIndex -= 1000000;
    }

    return true;
  }

  flushChunk() {
    // Fast native memory copy to transferable ArrayBuffer
    const buffer = new Int16Array(this.pendingBuffer).buffer;
    this.pendingCount = 0;
    this.port.postMessage({
      type: PCM_CHUNK,
      buffer
    }, [buffer]);
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
