// Run: node --test src/lib/audioExtract.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXTRACT_MAX_SECONDS,
  downmixToMono,
  encodeWavMono16,
  extractSample,
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
