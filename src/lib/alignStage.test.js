// Run: node --test src/lib/alignStage.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { clampVideoPathMs, createAlignStage } from './alignStage.js';
import { createElasticDelay } from './elasticDelay.js';

function fakeDelayFactory({ supported = true } = {}) {
  const instances = [];
  const createDelay = (targetMs) => {
    const d = {
      supported,
      targetMs,
      wrapped: null,
      released: 0,
      wrap(stream) {
        d.wrapped = stream;
        return { delayed: stream };
      },
      release: () => (d.released += 1),
    };
    instances.push(d);
    return d;
  };
  return { createDelay, instances };
}

test('apply wraps the stream and the stage reports itself ACTIVE', () => {
  const f = fakeDelayFactory();
  const stage = createAlignStage({ createDelay: f.createDelay });
  const out = stage.apply({ kind: 'receive', stream: { id: 's1' }, width: 1280, height: 720 });
  assert.deepEqual(out.stream, { delayed: { id: 's1' } });
  assert.equal(stage.active, true);
  assert.match(stage.describe(), /audio is the master clock/);
});

test('a second apply RELEASES the first wrap — no orphaned loops holding frames', () => {
  const f = fakeDelayFactory();
  const stage = createAlignStage({ createDelay: f.createDelay });
  stage.apply({ kind: 'receive', stream: { id: 's1' }, width: 1280, height: 720 });
  stage.apply({ kind: 'receive', stream: { id: 's2' }, width: 1280, height: 720 });
  assert.equal(f.instances.length, 2);
  assert.equal(f.instances[0].released, 1, 'the predecessor was stopped first');
  assert.equal(f.instances[1].released, 0);
});

test('a null stream (teardown) releases and deactivates', () => {
  const f = fakeDelayFactory();
  const stage = createAlignStage({ createDelay: f.createDelay });
  stage.apply({ kind: 'receive', stream: { id: 's1' }, width: 1280, height: 720 });
  const out = stage.apply({ kind: 'receive', stream: null, width: 1280, height: 720 });
  assert.equal(out.stream, null);
  assert.equal(stage.active, false);
  assert.equal(f.instances[0].released, 1);
});

test('an unsupported platform is an HONEST passthrough — inactive, stream untouched', () => {
  const f = fakeDelayFactory({ supported: false });
  const stage = createAlignStage({ createDelay: f.createDelay });
  const stream = { id: 's1' };
  const out = stage.apply({ kind: 'receive', stream, width: 1280, height: 720 });
  assert.equal(out.stream, stream, 'the original stream, not a wrap');
  assert.equal(stage.active, false);
  assert.match(stage.describe(), /pass-through/);
});

test('measured delays move the target the wrap reads — the policy drives the mechanism', () => {
  const f = fakeDelayFactory();
  const stage = createAlignStage({
    createDelay: f.createDelay,
    elastic: createElasticDelay(),
    videoPathMs: 300,
  });
  stage.apply({ kind: 'receive', stream: { id: 's1' }, width: 1280, height: 720 });
  assert.equal(f.instances[0].targetMs(), 0);
  for (let i = 0; i < 6; i += 1) stage.observeMouthToEar(1100);
  // The elastic sees 1100 − 300 = 800: 0 → 400 → 800, then it has arrived —
  // the policy's glide-and-settle, seen exactly through the mechanism's eyes.
  assert.equal(f.instances[0].targetMs(), 800, 'the live wrap sees the slewed target without rewrapping');
});

test('the video path is SUBTRACTED — frames already arrive that late for free', () => {
  const observed = [];
  const stage = createAlignStage({
    elastic: { observe: (ms) => observed.push(ms), targetMs: () => 0, reset: () => {} },
    videoPathMs: 300,
  });
  stage.observeMouthToEar(1500);
  stage.observeMouthToEar(100); // faster than the video path itself
  stage.observeMouthToEar(NaN); // junk
  assert.deepEqual(observed, [1200, 0], 'subtracted, floored at zero, junk refused');
});

test('the trim knob: applies from the next observation, clamps, refuses junk', () => {
  const observed = [];
  const stage = createAlignStage({
    elastic: { observe: (ms) => observed.push(ms), targetMs: () => 0, reset: () => {} },
    videoPathMs: 700,
  });
  stage.observeMouthToEar(1500); // 1500 − 700
  stage.setVideoPathMs(500);
  stage.observeMouthToEar(1500); // 1500 − 500
  stage.setVideoPathMs(99_999); // clamped to the ceiling
  stage.observeMouthToEar(3000); // 3000 − 2000
  stage.setVideoPathMs(NaN); // refused — the ceiling stays
  stage.observeMouthToEar(3000);
  stage.setVideoPathMs(-50); // clamped to zero
  stage.observeMouthToEar(400);
  assert.deepEqual(observed, [800, 1000, 1000, 1000, 400]);
  assert.equal(stage.videoPathMs(), 0);
});

test('clampVideoPathMs is THE boundary: zero legal, junk null, extremes clamped', () => {
  assert.equal(clampVideoPathMs(0), 0, 'zero is a claim, not junk');
  assert.equal(clampVideoPathMs(700), 700);
  assert.equal(clampVideoPathMs(99_999), 2000);
  assert.equal(clampVideoPathMs(-5), 0);
  assert.equal(clampVideoPathMs(NaN), null);
  assert.equal(clampVideoPathMs('700'), null, 'strings are the CALLER\'s parsing problem');
  assert.equal(clampVideoPathMs(undefined), null);
});

test('a constructor fed junk falls back to the default, not to broken state', () => {
  const observed = [];
  const stage = createAlignStage({
    elastic: { observe: (ms) => observed.push(ms), targetMs: () => 0, reset: () => {} },
    videoPathMs: NaN,
  });
  stage.observeMouthToEar(1500);
  assert.deepEqual(observed, [1500 - 700], 'the drill-calibrated default took over');
});

test('release() resets the clock too — a new session starts from zero', () => {
  const f = fakeDelayFactory();
  const stage = createAlignStage({ createDelay: f.createDelay });
  stage.apply({ kind: 'receive', stream: { id: 's1' }, width: 1280, height: 720 });
  for (let i = 0; i < 6; i += 1) stage.observeMouthToEar(1600);
  assert.ok(stage.targetMs() > 0);
  stage.release();
  assert.equal(stage.targetMs(), 0);
  assert.equal(stage.active, false);
});
