// Run: node --test src/lib/synthStage.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSynthStage } from './synthStage.js';
import { TIER_BUDGET_MS, GOVERNOR_DEFAULTS } from './synthCapability.js';

function fakeSynthesisFactory(record = {}) {
  return (deps) => {
    record.deps = deps;
    return {
      supported: true,
      wrap: (s) => {
        record.wrapped = s;
        return { wrappedFrom: s };
      },
      release: () => {
        record.released = (record.released ?? 0) + 1;
      },
    };
  };
}

const renderer = (name) => ({
  name,
  disposed: 0,
  dispose() {
    this.disposed += 1;
  },
  synthesize: () => ({}),
});

const frames = () => ({ kind: 'align', stream: { s: 1, getVideoTracks: () => [{}] }, width: 1280, height: 720 });

test('before any verdict the stage is off and wrap still installs (late verdicts switch on live)', () => {
  const record = {};
  const stage = createSynthStage({ createSynthesis: fakeSynthesisFactory(record) });
  assert.equal(stage.tier, 'off');
  const out = stage.apply(frames());
  assert.notEqual(out.stream, undefined);
  assert.equal(stage.active, false, 'wrapped but off is NOT active — honesty');
  assert.equal(record.deps.controller.current.targetFps, null);
});

test('adopt grants the tier and arms the controller with the granted renderer', () => {
  const record = {};
  const stage = createSynthStage({ createSynthesis: fakeSynthesisFactory(record) });
  stage.apply(frames());
  const motion = renderer('motion');
  const blend = renderer('blend');
  stage.adopt({ tier: 'motion', renderers: { motion, blend } });
  assert.equal(stage.tier, 'motion');
  assert.equal(stage.active, true);
  assert.equal(record.deps.controller.current.targetFps, 30, 'the CEO-locked target rate');
  assert.equal(record.deps.controller.current.renderer, motion);
  assert.equal(stage.label, 'synthesized · motion');
});

test('a granted tier whose renderer is missing collapses to off — a wish is not a mode', () => {
  const stage = createSynthStage({ createSynthesis: fakeSynthesisFactory() });
  stage.adopt({ tier: 'motion', renderers: { blend: renderer('blend') } });
  assert.equal(stage.tier, 'off');
});

test('sustained overload demotes ONE rung at a time, each tier judged by a FRESH governor', () => {
  const record = {};
  const stage = createSynthStage({ createSynthesis: fakeSynthesisFactory(record) });
  stage.apply(frames());
  const motion = renderer('motion');
  const blend = renderer('blend');
  const tiers = [];
  stage.subscribe((t) => tiers.push(t));
  stage.adopt({ tier: 'motion', renderers: { motion, blend } });

  const over = TIER_BUDGET_MS.motion + 5;
  for (let i = 0; i < GOVERNOR_DEFAULTS.demoteAtStrikes; i++) record.deps.onSample(over);

  assert.equal(stage.tier, 'blend', 'demoted one rung, not to the floor');
  assert.equal(motion.disposed, 1, 'the failed renderer is gone');
  assert.equal(record.deps.controller.current.renderer, blend);
  assert.deepEqual(tiers, ['motion', 'blend']);

  // Fresh-governor discrimination (mutation check: a governor carried over
  // from motion would already be demoted/striked and fall through early):
  // one-short of the threshold must HOLD the tier...
  for (let i = 0; i < GOVERNOR_DEFAULTS.demoteAtStrikes - 1; i++) record.deps.onSample(over);
  assert.equal(stage.tier, 'blend', 'blend answers to its own strike count, not motion leftovers');
  // ...and the final strike lands it on the floor.
  record.deps.onSample(over);
  assert.equal(stage.tier, 'off', 'blend overload lands on the floor');
  assert.equal(blend.disposed, 1);
});

test('a renderer failure mid-stream demotes on the spot', () => {
  const record = {};
  const stage = createSynthStage({ createSynthesis: fakeSynthesisFactory(record) });
  stage.apply(frames());
  const motion = renderer('motion');
  const blend = renderer('blend');
  stage.adopt({ tier: 'motion', renderers: { motion, blend } });
  record.deps.onRenderError(new Error('device lost'));
  assert.equal(stage.tier, 'blend');
  assert.equal(motion.disposed, 1);
});

test('release disposes every renderer and returns the stage to off', () => {
  const record = {};
  const stage = createSynthStage({ createSynthesis: fakeSynthesisFactory(record) });
  stage.apply(frames());
  const motion = renderer('motion');
  const blend = renderer('blend');
  stage.adopt({ tier: 'motion', renderers: { motion, blend } });
  stage.release();
  assert.equal(motion.disposed, 1);
  assert.equal(blend.disposed, 1);
  assert.equal(stage.tier, 'off');
  assert.equal(record.released, 1);
});

test('an unsupported platform leaves the frames untouched — identity is the honesty', () => {
  const stage = createSynthStage({
    createSynthesis: () => ({ supported: false, wrap: (s) => s, release: () => {} }),
  });
  const f = frames();
  assert.equal(stage.apply(f), f);
  assert.equal(stage.active, false);
});
