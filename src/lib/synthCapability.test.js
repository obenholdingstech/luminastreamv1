// Run: node --test src/lib/synthCapability.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SYNTH_TARGET_FPS,
  TIER_BUDGET_MS,
  TIER_PLAN,
  createSynthGovernor,
  decideSynthTier,
  demotedTier,
} from './synthCapability.js';

test('a tier is granted only on PROOF: built renderer AND bench inside budget', () => {
  assert.equal(
    decideSynthTier({ motionBuilt: true, motionBenchMs: TIER_BUDGET_MS.motion }),
    'motion',
    'at-budget motion passes',
  );
  assert.equal(
    decideSynthTier({ motionBuilt: true, motionBenchMs: TIER_BUDGET_MS.motion + 0.1, blendBuilt: true, blendBenchMs: 2 }),
    'blend',
    'over-budget motion falls to a proven blend',
  );
  assert.equal(
    decideSynthTier({ motionBuilt: false, motionBenchMs: 1, blendBuilt: false, blendBenchMs: 1 }),
    'off',
    'a bench without a build proves nothing',
  );
  assert.equal(
    decideSynthTier({ motionBuilt: true, blendBuilt: true }),
    'off',
    'a build without a bench proves nothing either',
  );
  assert.equal(decideSynthTier(), 'off', 'no evidence at all → off');
  assert.equal(
    decideSynthTier({ motionBuilt: true, motionBenchMs: NaN, blendBuilt: true, blendBenchMs: Infinity }),
    'off',
    'junk measurements grant nothing',
  );
});

test('the output target is the CEO-locked 30fps for BOTH tiers — a rate, not a multiplier', () => {
  // 6 Aug 2026: 57fps was overshoot (uncanny smoothness on avatar detail).
  // The tiers differ in HOW a frame is made, never in how many.
  assert.equal(SYNTH_TARGET_FPS, 30);
  assert.equal(TIER_PLAN.motion.targetFps, 30);
  assert.equal(TIER_PLAN.blend.targetFps, 30);
  assert.equal(TIER_PLAN.off.targetFps, null);
  assert.equal(TIER_BUDGET_MS.motion, 20, '1000/30 × 0.6 — the shipped budget, pinned');
  assert.equal(TIER_BUDGET_MS.blend, 20, 'same grid, same budget');
});

test('the demotion ladder is motion → blend → off, and off is the floor', () => {
  assert.equal(demotedTier('motion'), 'blend');
  assert.equal(demotedTier('blend'), 'off');
  assert.equal(demotedTier('off'), 'off');
  assert.equal(demotedTier('nonsense'), 'off', 'unknown tiers fall to the floor');
});

test('the governor demotes on SUSTAINED overload, exactly once', () => {
  const g = createSynthGovernor({ budgetMs: 10, demoteAtStrikes: 5 });
  for (let i = 0; i < 4; i++) assert.equal(g.observe(11), 'ok');
  assert.equal(g.observe(11), 'demote', 'the fifth consecutive strike demotes');
  assert.equal(g.observe(11), 'demoted', 'and only the first crossing says so');
  assert.equal(g.demoted, true);
});

test('good frames pay strikes down — a lone spike never demotes', () => {
  const g = createSynthGovernor({ budgetMs: 10, demoteAtStrikes: 5, goodFramePaysStrikes: 2 });
  // spike, recover, spike, recover — forever short of the threshold
  for (let i = 0; i < 40; i++) {
    g.observe(12);
    g.observe(12);
    g.observe(3); // pays 2 strikes back
  }
  assert.equal(g.demoted, false, 'alternating load holds the tier');
});

test('junk measurements convict nobody', () => {
  const g = createSynthGovernor({ budgetMs: 10, demoteAtStrikes: 2 });
  assert.equal(g.observe(NaN), 'ok');
  assert.equal(g.observe(undefined), 'ok');
  assert.equal(g.strikes, 0);
});
