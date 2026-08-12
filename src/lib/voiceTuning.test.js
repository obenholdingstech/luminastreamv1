// Run: node --test src/lib/voiceTuning.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { TUNING_KNOB_NAMES, tuningSliders } from './voiceTuning.js';

const METADATA = [
  { name: 'voice', kind: 'enum', choices: [] },
  { name: 'stability', kind: 'float', label: 'Stability', lo: 0, hi: 1, step: 0.05, default: 0.5,
    hint: 'low = more emotional range', timing: 'next utterance' },
  { name: 'similarity_boost', kind: 'float', label: 'Similarity Boost', lo: 0, hi: 1, step: 0.05,
    default: 0.75, timing: 'next utterance',
    unsupported_models: { eleven_v3: 'not available on Eleven v3' } },
  { name: 'style', kind: 'float', label: 'Style', lo: 0, hi: 1, step: 0.05, default: 0,
    timing: 'next utterance' },
  { name: 'tts_model', kind: 'enum', choices: ['eleven_flash_v2_5'] },
];

test('the three taste knobs become sliders, in the mandated order, applied truth first', () => {
  const sliders = tuningSliders(METADATA, { stability: 0.2, tts_model: 'eleven_flash_v2_5' });
  assert.deepEqual(sliders.map((s) => s.name), TUNING_KNOB_NAMES);
  assert.equal(sliders[0].value, 0.2, 'the APPLIED value, not the default');
  assert.equal(sliders[1].value, 0.75, 'no applied value → the registry default');
  assert.equal(sliders[0].lo, 0);
  assert.equal(sliders[0].step, 0.05);
  assert.equal(sliders[0].timing, 'next utterance');
});

test('a knob the current model refuses is disabled WITH the model’s reason', () => {
  const onV3 = tuningSliders(METADATA, { tts_model: 'eleven_v3' });
  assert.equal(onV3.find((s) => s.name === 'similarity_boost').disabledReason,
    'not available on Eleven v3');
  assert.equal(onV3.find((s) => s.name === 'stability').disabledReason, null);
  const onFlash = tuningSliders(METADATA, { tts_model: 'eleven_flash_v2_5' });
  assert.equal(onFlash.find((s) => s.name === 'similarity_boost').disabledReason, null);
});

test('no broadcast, wrong shapes, or missing knobs → empty or partial, never invented', () => {
  assert.deepEqual(tuningSliders(null, {}), []);
  assert.deepEqual(tuningSliders({ stability: {} }, {}), [], 'a map is not the wire shape');
  const partial = tuningSliders([METADATA[1]], null);
  assert.deepEqual(partial.map((s) => s.name), ['stability'], 'rvc-era metadata yields only what exists');
});
