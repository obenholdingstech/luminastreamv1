// Run: node --test src/lib/audioExtract.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXTRACT_MAX_SECONDS,
  EXTRACT_SAMPLE_RATE,
  downmixToMono,
  encodeWavMono16,
  extractSample,
  resampleLinearMono,
  wavToDataUrl,
} from './audioExtract.js';

test('downmix: stereo averages to mono and trims to the cap', () => {
  const left = new Float32Array([1, 1, 1, 1]);
  const right = new Float32Array([0, 0, 0, 0]);
  const mono = downmixToMono([left, right], 2, 1); // 2Hz, cap 1s → 2 samples
  assert.equal(mono.length, 2);
  assert.equal(mono[0], 0.5);
});

test('the WAV header is honest: RIFF/WAVE, mono, 16-bit, the right sizes', () => {
  const wav = encodeWavMono16(new Float32Array([0, 0.5, -0.5]), 44100);
  const text = (o, n) => String.fromCharCode(...wav.subarray(o, o + n));
  assert.equal(text(0, 4), 'RIFF');
  assert.equal(text(8, 4), 'WAVE');
  const view = new DataView(wav.buffer);
  assert.equal(view.getUint16(22, true), 1, 'mono');
  assert.equal(view.getUint32(24, true), 44100);
  assert.equal(view.getUint16(34, true), 16, 'bits');
  assert.equal(view.getUint32(40, true), 6, '3 samples × 2 bytes');
  assert.equal(view.getInt16(46, true), 16384, '0.5 → 16384');
});

test('clipping clamps instead of wrapping — a hot signal must not become noise', () => {
  const wav = encodeWavMono16(new Float32Array([2, -2]), 8000);
  const view = new DataView(wav.buffer);
  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(view.getInt16(46, true), -32767);
});

test('extractSample: video-with-audio decodes to a data URL; silent containers refuse plainly', async () => {
  const decode = async () => ({ sampleRate: 4, channels: [new Float32Array([0.1, 0.2, 0.3, 0.4])] });
  const out = await extractSample({ arrayBuffer: async () => new ArrayBuffer(0) }, decode, 0.5);
  assert.match(out.sampleData, /^data:audio\/wav;base64,/);
  assert.equal(out.seconds, 0.5, 'trimmed to the cap');

  await assert.rejects(
    () => extractSample({ arrayBuffer: async () => new ArrayBuffer(0) }, async () => ({ sampleRate: 4, channels: [] })),
    /no audio track/,
  );
});

test('resample: identity at same rate, interpolation across rates, empty stays empty', () => {
  const same = new Float32Array([0.1, 0.2]);
  assert.equal(resampleLinearMono(same, 44100, 44100), same, 'same rate = same array, no copy');
  assert.equal(resampleLinearMono(new Float32Array(0), 96000, 44100).length, 0);
  // 4 samples at 2Hz → 2 samples at 1Hz: sample TIME is preserved — output
  // sample i reads input position i·(from/to), so [0,2], never a stretched
  // [0,3] (endpoint-mapping would shift every moment of the signal).
  const down = resampleLinearMono(new Float32Array([0, 1, 2, 3]), 2, 1);
  assert.equal(down.length, 2);
  assert.equal(down[0], 0);
  assert.equal(down[1], 2);
});

test('a 96kHz source still lands at the declared rate and under the caps', async () => {
  // A full-length capped extract from a high-rate master: the WAV must be
  // encoded at EXTRACT_SAMPLE_RATE, not the source rate — at 96kHz the
  // unresampled encoding would be ~19MB, straight through the vendor cap.
  const srcRate = 96_000;
  const channel = new Float32Array(srcRate * (EXTRACT_MAX_SECONDS + 5));
  const decode = async () => ({ sampleRate: srcRate, channels: [channel] });
  const out = await extractSample({ arrayBuffer: async () => new ArrayBuffer(0) }, decode);
  assert.equal(out.seconds, EXTRACT_MAX_SECONDS, 'trimmed to the cap in source time');
  const wav = Buffer.from(out.sampleData.split(',')[1], 'base64');
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(view.getUint32(24, true), EXTRACT_SAMPLE_RATE, 'header carries the declared rate');
  assert.ok(wav.byteLength < 10 * 1024 * 1024, 'under the vendor file cap');
  assert.ok(out.sampleData.length < 14_000_000, 'under our sample wall as base64');
});

test('the cap keeps the extracted WAV under both walls', () => {
  const bytes = EXTRACT_MAX_SECONDS * 44100 * 2 + 44;
  assert.ok(bytes < 10 * 1024 * 1024, 'under the vendor file cap');
  assert.ok((bytes * 4) / 3 < 14_000_000, 'under our sample wall as base64');
});

test('wavToDataUrl round-trips bytes', () => {
  const url = wavToDataUrl(new Uint8Array([1, 2, 250]));
  const b64 = url.split(',')[1];
  assert.deepEqual([...Buffer.from(b64, 'base64')], [1, 2, 250]);
});
