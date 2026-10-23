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
    this.pendingEnergySum = 0;
    this.lowPassSample = 0;
    this.hasLowPassSample = false;
    this.lowPassAlpha = this.calculateLowPassAlpha(7200);
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
    for (let i = 0; i < frameLength; i += 1) {
      let monoSample = 0;
      for (let channel = 0; channel < input.length; channel += 1) {
        monoSample += input[channel][i] || 0;
      }
      monoSample = this.lowPass(monoSample / input.length);

      if (!this.hasLastSample) {
        this.lastMonoSample = monoSample;
        this.hasLastSample = true;
        this.inputIndex += 1;
        continue;
      }

      while (this.nextOutputIndex <= this.inputIndex) {
        const fraction = this.nextOutputIndex - (this.inputIndex - 1);
        const interpolated = this.lastMonoSample + (monoSample - this.lastMonoSample) * fraction;
        const pcmSample = this.floatToInt16(interpolated);
        this.pendingBuffer[this.pendingCount] = pcmSample;
        this.pendingEnergySum += (pcmSample / 0x8000) ** 2;
        this.pendingCount += 1;

        if (this.pendingCount >= this.chunkSamples) {
          this.flushChunk();
        }

        this.nextOutputIndex += this.sampleStep;
      }

      this.lastMonoSample = monoSample;
      this.inputIndex += 1;
    }

    return true;
  }

  floatToInt16(sample) {
    const clamped = Math.max(-1, Math.min(1, sample));
    return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }

  calculateLowPassAlpha(cutoffHz) {
    const dt = 1 / sampleRate;
    const rc = 1 / (2 * Math.PI * cutoffHz);
    return dt / (rc + dt);
  }

  lowPass(sample) {
    if (!this.hasLowPassSample) {
      this.lowPassSample = sample;
      this.hasLowPassSample = true;
      return sample;
    }

    this.lowPassSample += this.lowPassAlpha * (sample - this.lowPassSample);
    return this.lowPassSample;
  }

  flushChunk() {
    const rms = Math.sqrt(this.pendingEnergySum / this.chunkSamples);
    const buffer = this.createChunkBuffer();
    this.resetPendingChunk();
    this.postChunk(buffer, rms);
  }

  createChunkBuffer() {
    const buffer = new ArrayBuffer(this.chunkSamples * 2);
    const view = new DataView(buffer);

    for (let i = 0; i < this.chunkSamples; i += 1) {
      view.setInt16(i * 2, this.pendingBuffer[i], true);
    }

    return buffer;
  }

  resetPendingChunk() {
    this.pendingCount = 0;
    this.pendingEnergySum = 0;
  }

  postChunk(buffer, rms) {
    this.port.postMessage({
      type: PCM_CHUNK,
      buffer,
      rms
    }, [buffer]);
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
