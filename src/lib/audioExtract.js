// In-browser audio extraction (CEO mandate, 11 Aug 2026): the clone modal
// accepts big audio files AND video containers (.mp4/.mov/.webm); the
// browser decodes the audio track, trims it to what cloning actually
// needs, and produces a compact mono WAV — so a 150MB screen recording
// becomes a ~9MB sample without the file ever crossing the wire whole.
//
// The DECODE is injected (AudioContext lives in browsers); everything
// else — trim math, downmix, and the WAV encoder — is pure typed-array
// work, unit-tested in Node.

// Cloning wants 1–2 minutes of clean speech; 100s mono 16-bit 44.1kHz is
// ~8.8MB — safely under both our sample wall and the vendor's file cap.
export const EXTRACT_MAX_SECONDS = 100;
export const EXTRACT_SAMPLE_RATE = 44_100;
export const MAX_MEDIA_BYTES = 150 * 1024 * 1024;

export const AUDIO_OR_VIDEO_ACCEPT = 'audio/*,video/mp4,video/quicktime,video/webm';

/** Downmix any channel count to mono Float32, trimmed to maxSeconds. */
export function downmixToMono(channels, sampleRate, maxSeconds = EXTRACT_MAX_SECONDS) {
  if (!channels.length) return new Float32Array(0);
  const limit = Math.min(channels[0].length, Math.floor(sampleRate * maxSeconds));
  const mono = new Float32Array(limit);
  for (const channel of channels) {
    for (let i = 0; i < limit; i += 1) mono[i] += channel[i] / channels.length;
  }
  return mono;
}

/** Mono Float32 → 16-bit PCM WAV bytes. Pure, testable, no browser APIs. */
export function encodeWavMono16(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const writeStr = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }
  return new Uint8Array(buf);
}

/** Uint8Array → base64 data URL, chunked so big samples don't blow the stack. */
export function wavToDataUrl(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
}

/**
 * The whole pipeline with an injected decoder:
 * `decode(arrayBuffer) → Promise<{ sampleRate, channels: Float32Array[] }>`.
 * Returns { sampleData (data URL), seconds } or throws with a plain sentence.
 */
export async function extractSample(file, decode, maxSeconds = EXTRACT_MAX_SECONDS) {
  const decoded = await decode(await file.arrayBuffer());
  if (!decoded?.channels?.length || !decoded.channels[0].length) {
    throw new Error('no audio track found in that file');
  }
  const mono = downmixToMono(decoded.channels, decoded.sampleRate, maxSeconds);
  const wav = encodeWavMono16(mono, decoded.sampleRate);
  return { sampleData: wavToDataUrl(wav), seconds: mono.length / decoded.sampleRate };
}

/** The browser decoder for the pipeline above — AudioContext-backed. */
export async function browserDecode(arrayBuffer) {
  const Ctx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!Ctx) throw new Error('this browser cannot decode audio');
  const ctx = new Ctx();
  try {
    const audio = await ctx.decodeAudioData(arrayBuffer);
    const channels = [];
    for (let c = 0; c < audio.numberOfChannels; c += 1) channels.push(audio.getChannelData(c));
    return { sampleRate: audio.sampleRate, channels };
  } finally {
    ctx.close?.().catch?.(() => {});
  }
}
