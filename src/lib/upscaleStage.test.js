// Run: node --test src/lib/upscaleStage.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpscaleStage } from './upscaleStage.js';
import { createFramePipeline } from './framePipeline.js';
import { VERTEX_FULLSCREEN, FRAGMENT_CATMULL_ROM, FRAGMENT_CAS } from './upscaleShaders.js';

function fakeUpscaleFactory({ supported = true, refuse = false } = {}) {
  const instances = [];
  const createUpscale = (args) => {
    const u = {
      supported,
      args,
      released: 0,
      wrap(stream) {
        return refuse ? stream : { upscaled: stream };
      },
      release: () => (u.released += 1),
    };
    instances.push(u);
    return u;
  };
  return { createUpscale, instances };
}

test('apply wraps the stream, reports ACTIVE, and claims the target size', () => {
  const f = fakeUpscaleFactory();
  const stage = createUpscaleStage({ createUpscale: f.createUpscale });
  const out = stage.apply({ kind: 'align', stream: { id: 's1' }, width: 1280, height: 720 });
  assert.deepEqual(out.stream, { upscaled: { id: 's1' } });
  assert.equal(out.width, 1920);
  assert.equal(out.height, 1080);
  assert.equal(stage.active, true);
  assert.deepEqual(f.instances[0].args.source, { width: 1280, height: 720 }, 'source size flows in');
  assert.match(stage.describe(), /1080p/);
});

test('a REFUSED wrap (renderer could not build) keeps 720p as the truth', () => {
  const f = fakeUpscaleFactory({ refuse: true });
  const stage = createUpscaleStage({ createUpscale: f.createUpscale });
  const stream = { id: 's1' };
  const out = stage.apply({ kind: 'align', stream, width: 1280, height: 720 });
  assert.equal(out.stream, stream, 'identity in, identity out');
  assert.equal(out.height, 720, 'no claimed resolution without produced pixels');
  assert.equal(stage.active, false);
  assert.match(stage.describe(), /pass-through/);
});

test('an unsupported platform is an honest passthrough', () => {
  const f = fakeUpscaleFactory({ supported: false });
  const stage = createUpscaleStage({ createUpscale: f.createUpscale });
  const stream = { id: 's1' };
  const out = stage.apply({ kind: 'align', stream, width: 1280, height: 720 });
  assert.equal(out.stream, stream);
  assert.equal(stage.active, false);
});

test('a second apply RELEASES the first wrap; a null stream deactivates', () => {
  const f = fakeUpscaleFactory();
  const stage = createUpscaleStage({ createUpscale: f.createUpscale });
  stage.apply({ kind: 'align', stream: { id: 's1' }, width: 1280, height: 720 });
  stage.apply({ kind: 'align', stream: { id: 's2' }, width: 1280, height: 720 });
  assert.equal(f.instances[0].released, 1, 'the predecessor was stopped first');
  const out = stage.apply({ kind: 'align', stream: null, width: 1280, height: 720 });
  assert.equal(out.stream, null);
  assert.equal(stage.active, false);
  assert.equal(f.instances[1].released, 1);
});

test('the PIPELINE reports what the stage delivers — 1080p only when active', () => {
  const active = createFramePipeline({
    upscale: createUpscaleStage({ createUpscale: fakeUpscaleFactory().createUpscale }),
  });
  active.run({ id: 'live' });
  assert.deepEqual(active.describe().delivering, { width: 1920, height: 1080 });
  assert.equal(active.describe().upscaleActive, true);

  const refused = createFramePipeline({
    upscale: createUpscaleStage({
      createUpscale: fakeUpscaleFactory({ refuse: true }).createUpscale,
    }),
  });
  refused.run({ id: 'live' });
  assert.deepEqual(refused.describe().delivering, { width: 1280, height: 720 });
  assert.equal(refused.describe().upscaleActive, false);
});

test('the shaders are the shape the renderer compiles: WebGL2, expected uniforms', () => {
  for (const src of [VERTEX_FULLSCREEN, FRAGMENT_CATMULL_ROM, FRAGMENT_CAS]) {
    assert.ok(src.startsWith('#version 300 es'), 'WebGL2 GLSL');
  }
  assert.match(FRAGMENT_CATMULL_ROM, /uniform sampler2D src[\s\S]*uniform vec2 srcSize/);
  assert.match(FRAGMENT_CAS, /uniform vec2 dstSize[\s\S]*uniform float sharpness/);
  assert.match(FRAGMENT_CATMULL_ROM, /1\.0 - uv\.y/, 'the one vertical flip lives in pass 1');
  assert.ok(!FRAGMENT_CAS.includes('1.0 - uv.y'), 'and pass 2 is identity — flip parity of one');
});
