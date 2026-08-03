// Run: node --test src/lib/alignStage.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlignStage } from './alignStage.js';
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

test('observed tails move the target the wrap reads — the policy drives the mechanism', () => {
  const f = fakeDelayFactory();
  const stage = createAlignStage({ createDelay: f.createDelay, elastic: createElasticDelay() });
  stage.apply({ kind: 'receive', stream: { id: 's1' }, width: 1280, height: 720 });
  assert.equal(f.instances[0].targetMs(), 0);
  for (let i = 0; i < 6; i += 1) stage.observeTail(800);
  // 0 → 250 → 500 → 750, then the 50ms drift sits inside the deadband: the
  // policy's glide-and-settle, seen exactly through the mechanism's eyes.
  assert.equal(f.instances[0].targetMs(), 750, 'the live wrap sees the slewed target without rewrapping');
});

test('release() resets the clock too — a new session starts from zero', () => {
  const f = fakeDelayFactory();
  const stage = createAlignStage({ createDelay: f.createDelay });
  stage.apply({ kind: 'receive', stream: { id: 's1' }, width: 1280, height: 720 });
  for (let i = 0; i < 6; i += 1) stage.observeTail(1200);
  assert.ok(stage.targetMs() > 0);
  stage.release();
  assert.equal(stage.targetMs(), 0);
  assert.equal(stage.active, false);
});
