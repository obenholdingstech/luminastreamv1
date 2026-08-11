// Run: node --test src/lib/streamStats.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { statChip, statLines } from './streamStats.js';

const FIDELITY = {
  vendorNative: { height: 720 },
  delivering: { height: 1080 },
  synthLabel: 'synthesized · motion',
  upscaleActive: true,
  alignActive: true,
};

test('the chip is the two glance numbers, and fps absence is silence not zero', () => {
  assert.equal(statChip({ presentingRaw: false, fidelity: FIDELITY, deliveredFps: 27 }), '1080p · 27fps');
  assert.equal(statChip({ presentingRaw: true, fidelity: FIDELITY, deliveredFps: null }), '720p');
});

test('raw passthrough claims vendor truth only — no pipeline lines at all', () => {
  const lines = statLines({ presentingRaw: true, fidelity: FIDELITY, deliveredFps: 24, appliedHoldMs: 50 });
  assert.deepEqual(lines.map(([term]) => term), ['source', 'resolution', 'measured rate']);
  assert.deepEqual(lines[1], ['resolution', '720p native']);
  assert.ok(!JSON.stringify(lines).includes('synth'), 'no synthesis claim for untouched pixels');
});

test('the pipeline panel keeps claim and measurement separate, dashes for the unknown', () => {
  const lines = statLines({ presentingRaw: false, fidelity: FIDELITY, deliveredFps: 27, appliedHoldMs: 50 });
  const map = Object.fromEntries(lines);
  assert.equal(map.resolution, '1080p');
  assert.equal(map['measured rate'], '27 fps');
  assert.equal(map.synthesis, 'synthesized · motion');
  assert.equal(map.upscale, 'active');
  assert.equal(map['video hold'], '0.1s behind live');
  const dashed = statLines({
    presentingRaw: false,
    fidelity: { ...FIDELITY, synthLabel: null, upscaleActive: false, alignActive: false },
    deliveredFps: null,
    appliedHoldMs: 0,
  });
  const d = Object.fromEntries(dashed);
  assert.equal(d['measured rate'], '—', 'no measurement is a dash, never 0');
  assert.equal(d.synthesis, '—');
  assert.equal(d.upscale, 'pending');
  assert.equal(d['video hold'], 'off');
});
