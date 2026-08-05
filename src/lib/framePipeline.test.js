// Run: node --test src/lib/framePipeline.test.js
//
// The pipeline's job today is to EXIST in the right shape — receive → align →
// upscale → present — so P3's A/V buffer and WebGL upscaler are slot-fills
// rather than a rebuild. These tests pin the shape and, as importantly, the
// honesty: a pass-through stage must never let the UI claim a resolution
// nothing produced.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFramePipeline,
  passthroughStage,
  STAGES,
  VENDOR_NATIVE,
  FIDELITY_TARGETS,
} from './framePipeline.js';

test('the pipeline is the canon order — receive, align, upscale, present', () => {
  assert.deepEqual(STAGES, ['receive', 'align', 'upscale', 'present']);
});

test('a bare pipeline passes frames through at the VENDOR native resolution', () => {
  const p = createFramePipeline();
  const stream = { id: 'vendor-stream' };
  const out = p.run(/** @type {any} */ (stream));
  assert.equal(out.stream, stream);
  assert.equal(out.width, VENDOR_NATIVE.width);
  assert.equal(out.height, VENDOR_NATIVE.height);
  assert.equal(out.kind, 'present');
});

test('an unfilled slot reports itself as pending — never as capability', () => {
  // The honesty rule: "720p, upscale pending" is true; implying FHD is not.
  const d = createFramePipeline().describe();
  assert.equal(d.upscaleActive, false);
  assert.equal(d.alignActive, false);
  assert.deepEqual(d.delivering, VENDOR_NATIVE);
  assert.equal(d.pending.length, 2);
  assert.ok(d.pending.some((s) => s.includes('align')));
  assert.ok(d.pending.some((s) => s.includes('upscale')));
  assert.ok(d.pending.every((s) => /P3|P6/.test(s)), 'each names the phase that fills it');
});

test('filling the upscale slot changes what the pipeline DELIVERS, with nothing else touched', () => {
  // The whole point of the shape: P3 supplies this object and no component
  // is restructured. Simulated here with a stage that reports 1080p.
  const upscale = {
    name: 'upscale',
    active: true,
    output: FIDELITY_TARGETS.fhd,
    apply: (frames) => ({ ...frames, width: 1920, height: 1080, upscaled: true }),
    describe: () => 'upscale: webgl-fsr',
  };
  const p = createFramePipeline({ upscale });
  const out = p.run(/** @type {any} */ ({ id: 's' }));
  assert.equal(out.width, 1920);
  assert.equal(out.height, 1080);

  const d = p.describe();
  assert.equal(d.upscaleActive, true);
  assert.deepEqual(d.delivering, FIDELITY_TARGETS.fhd);
  assert.deepEqual(d.vendorNative, VENDOR_NATIVE, 'the vendor number never changes');
  assert.equal(d.pending.length, 1, 'only align remains pending');
});

test('stages compose in order — align runs before upscale', () => {
  const order = [];
  const mk = (name) => ({
    name,
    active: true,
    apply: (f) => {
      order.push(name);
      return f;
    },
    describe: () => name,
  });
  createFramePipeline({ align: mk('align'), upscale: mk('upscale') }).run(null);
  assert.deepEqual(order, ['align', 'upscale'], 'aligning after upscaling would waste the work');
});

test('a pass-through stage is inert and says which phase fills it', () => {
  const s = passthroughStage('upscale', 'P3 — WebGL FSR-class');
  const frames = { kind: 'receive', stream: null, width: 1, height: 2 };
  assert.equal(s.apply(frames), frames, 'inert: the same object, untouched');
  assert.equal(s.active, false);
  assert.match(s.describe(), /P3/);
});

test('the vendor native resolution matches what the probe verified', () => {
  // Lucy 2.5 is 720p, period — the fact that makes the upscaler mandate real
  // rather than optional.
  assert.deepEqual(VENDOR_NATIVE, { width: 1280, height: 720 });
});
