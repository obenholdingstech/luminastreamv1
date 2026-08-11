// Run: node --test src/lib/imageCompress.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { AVATAR_TARGET_BYTES, compressToTarget, compressionLadder } from './imageCompress.js';

test('the ladder walks largest-first and stops at the first rung that fits', async () => {
  const tried = [];
  const out = await compressToTarget(async (rung) => {
    tried.push(rung.maxDim);
    // 4096 → too big; 2048@0.9 → fits
    return { bytes: rung.maxDim === 4096 ? 9_000_000 : 3_000_000, dataUrl: `u-${rung.maxDim}-${rung.quality}` };
  });
  assert.equal(out.fitted, true);
  assert.equal(out.dataUrl, 'u-2048-0.9');
  assert.deepEqual(tried, [4096, 2048], 'stopped as soon as it fit');
});

test('nothing fits → the SMALLEST attempt comes back, marked unfitted', async () => {
  // The smallest output is deliberately NOT the final rung (JPEG at a low
  // dimension but higher quality can outweigh a mid rung) — so returning
  // "whatever was tried last" instead of the true minimum fails here.
  const sizes = {
    '4096-0.92': 9_000_000,
    '2048-0.9': 8_000_000,
    '2048-0.8': 7_000_000,
    '1600-0.8': 6_000_000,
    '1280-0.75': 5_000_000,
    '1024-0.7': 5_500_000,
  };
  const out = await compressToTarget(async (rung) => {
    const key = `${rung.maxDim}-${rung.quality}`;
    return { bytes: sizes[key], dataUrl: `u-${key}` };
  });
  assert.equal(out.fitted, false);
  assert.equal(out.dataUrl, 'u-1280-0.75', 'the smallest attempt, not the final rung');
});

test('the ladder ends small enough that photos realistically fit', () => {
  const last = compressionLadder().at(-1);
  assert.ok(last.maxDim <= 1024 && last.quality <= 0.7);
  assert.ok(AVATAR_TARGET_BYTES < 5 * 1024 * 1024, 'the target respects the vendor wall');
});
