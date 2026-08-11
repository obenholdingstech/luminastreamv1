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
  const out = await compressToTarget(async (rung) => ({
    bytes: 5_000_000 + rung.maxDim, // all over target; smallest dim wins
    dataUrl: `u-${rung.maxDim}-${rung.quality}`,
  }));
  assert.equal(out.fitted, false);
  assert.equal(out.dataUrl, 'u-1024-0.7', 'the smallest attempt, so the server wall gets our best');
});

test('the ladder ends small enough that photos realistically fit', () => {
  const last = compressionLadder().at(-1);
  assert.ok(last.maxDim <= 1024 && last.quality <= 0.7);
  assert.ok(AVATAR_TARGET_BYTES < 5 * 1024 * 1024, 'the target respects the vendor wall');
});
