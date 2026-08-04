// Run: node --test src/lib/elasticDelay.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElasticDelay, ELASTIC_DEFAULTS } from './elasticDelay.js';

test('a steady measurement pulls the target up in bounded glides, never a jump', () => {
  const d = createElasticDelay();
  d.observe(900);
  assert.equal(d.targetMs(), 400, 'first move is one slew step, not the whole distance');
  d.observe(900);
  d.observe(900);
  d.observe(900);
  // 400 → 800, then the 100ms drift sits inside the deadband: settled
  // within lip-sync tolerance is settled.
  assert.ok(Math.abs(d.targetMs() - 900) <= ELASTIC_DEFAULTS.deadbandMs, 'arrives within the deadband');
});

test('sub-deadband jitter moves NOTHING — the picture does not chase noise', () => {
  const d = createElasticDelay();
  for (const t of [600, 600, 600, 600]) d.observe(t);
  const settled = d.targetMs();
  for (const t of [650, 560, 640, 580, 610]) d.observe(t);
  assert.equal(d.targetMs(), settled, 'a ±100ms wobble is lip-sync tolerance, not drift');
});

test('one outlier cannot yank the target — the median holds', () => {
  const d = createElasticDelay();
  for (const t of [500, 500, 500, 500, 500]) d.observe(t);
  const before = d.targetMs();
  d.observe(1900); // one cold-start spike among the memory of a calm stream
  assert.equal(d.targetMs(), before, 'median of the window barely moves; deadband absorbs it');
});

test('backlog drains: a quieting stream glides the delay DOWN too', () => {
  const d = createElasticDelay();
  for (let i = 0; i < 8; i += 1) d.observe(1500);
  const loaded = d.targetMs();
  for (let i = 0; i < 8; i += 1) d.observe(300);
  assert.ok(d.targetMs() < loaded, 'elastic means both directions');
  assert.ok(
    Math.abs(d.targetMs() - 300) <= ELASTIC_DEFAULTS.deadbandMs,
    'and it settles on the new truth, within lip-sync tolerance',
  );
});

test('the ceiling is absolute — video never stands further back than maxDelayMs', () => {
  const d = createElasticDelay();
  for (let i = 0; i < 20; i += 1) d.observe(10_000);
  assert.equal(d.targetMs(), ELASTIC_DEFAULTS.maxDelayMs);
});

test('junk samples change nothing; reset forgets everything', () => {
  const d = createElasticDelay();
  for (const junk of [NaN, -50, Infinity, undefined, 'fast']) d.observe(junk);
  assert.equal(d.targetMs(), 0);
  for (let i = 0; i < 6; i += 1) d.observe(800);
  assert.ok(d.targetMs() > 0);
  d.reset();
  assert.equal(d.targetMs(), 0, 'a new session has a new clock');
});
