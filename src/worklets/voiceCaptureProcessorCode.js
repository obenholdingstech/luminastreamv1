// AudioWorklet processor — runs on a DEDICATED audio thread (not the main thread).
// Captures mic audio, resamples to 16kHz, converts to Int16 PCM, sends chunks via MessagePort.
// This eliminates ScriptProcessor's main-thread contention with video rendering
// and replaces its 85ms buffer (4096 samples) with a 2.67ms quantum (128 samples).

export const voiceCaptureProcessorCode = `
class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.chunkSamples = 1600; // 100ms at 16kHz — ElevenLabs minimum
    this.inputRate = sampleRate; // global in AudioWorkletGlobalScope
    this.buffer = [];
    this.bufferLength = 0;

    this.port.onmessage = (e) => {
      if (e.data.type === 'config') {
        this.chunkSamples = e.data.chunkSamples || 1600;
        this.targetRate = e.data.targetRate || 16000;
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;

    const channelData = input[0]; // 128 samples at native rate (2.67ms quantum)

    // Resample from native rate to target rate
    const resampled = this.resample(channelData, this.inputRate, this.targetRate);

    // Accumulate
    this.buffer.push(resampled);
    this.bufferLength += resampled.length;

    // Send chunks when enough samples accumulated
    while (this.bufferLength >= this.chunkSamples) {
      const chunk = new Float32Array(this.chunkSamples);
      let offset = 0;
      while (offset < this.chunkSamples) {
        const buf = this.buffer[0];
        const needed = this.chunkSamples - offset;
        if (buf.length <= needed) {
          chunk.set(buf, offset);
          offset += buf.length;
          this.buffer.shift();
          this.bufferLength -= buf.length;
        } else {
          chunk.set(buf.subarray(0, needed), offset);
          this.buffer[0] = buf.subarray(needed);
          this.bufferLength -= needed;
          offset = this.chunkSamples;
        }
      }

      // Convert to Int16 PCM (little-endian)
      const pcm16 = new Int16Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }

      // Transfer the buffer to main thread (zero-copy via Transferable)
      this.port.postMessage({ type: 'chunk', pcm16: pcm16.buffer }, [pcm16.buffer]);
    }

    return true;
  }

  resample(input, inputRate, targetRate) {
    if (inputRate === targetRate) return input;
    const ratio = inputRate / targetRate;
    const outLen = Math.floor(input.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const idx = i * ratio;
      const lo = Math.floor(idx);
      const hi = Math.min(lo + 1, input.length - 1);
      const frac = idx - lo;
      out[i] = input[lo] * (1 - frac) + input[hi] * frac;
    }
    return out;
  }
}

registerProcessor('voice-capture-processor', VoiceCaptureProcessor);
`;