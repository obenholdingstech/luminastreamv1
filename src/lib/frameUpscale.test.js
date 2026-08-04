// Run: node --test src/lib/frameUpscale.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrameUpscale } from './frameUpscale.js';

// A processor whose readable hands out queued frames; a generator that
// records writes — the same fake-track shape frameDelay's tests use.
function fakePlatform(frames) {
  const written = [];
  const queue = [...frames];
  const Processor = function ({ track }) {
    this.track = track;
    this.readable = {
      getReader: () => ({
        read: async () =>
          queue.length > 0 ? { value: queue.shift(), done: false } : { done: true },
        releaseLock: () => {},
      }),
    };
  };
  const Generator = function () {
    this.kind = 'video';
    this.writable = {
      getWriter: () => ({
        write: async (f) => written.push(f),
        releaseLock: () => {},
      }),
    };
  };
  const StreamCtor = function (tracks) {
    this.tracks = tracks;
    this.getVideoTracks = () => tracks.filter((t) => t.kind === 'video');
    this.getAudioTracks = () => tracks.filter((t) => t.kind === 'audio');
  };
  return { Processor, Generator, StreamCtor, written };
}

const frame = (n) => ({ n, timestamp: n * 33, closed: 0, close() { this.closed += 1; } });
const stream = () => ({
  getVideoTracks: () => [{ kind: 'video' }],
  getAudioTracks: () => [],
});
const settle = () => new Promise((r) => setTimeout(r, 10));

test('frames flow through the renderer: input closed exactly once, output written', async () => {
  const f1 = frame(1);
  const f2 = frame(2);
  const p = fakePlatform([f1, f2]);
  const rendered = [];
  const up = createFrameUpscale({
    ...p,
    output: { width: 1920, height: 1080 },
    createRenderer: () => ({
      render: (f) => {
        rendered.push(f.n);
        return { big: f.n, timestamp: f.timestamp };
      },
      dispose: () => {},
    }),
  });
  const out = up.wrap(stream());
  await settle();
  assert.notEqual(out, null);
  assert.deepEqual(rendered, [1, 2]);
  assert.deepEqual(p.written.map((w) => w.big), [1, 2], 'outputs written in order');
  assert.equal(f1.closed, 1, 'input frames closed exactly once');
  assert.equal(f2.closed, 1);
  up.release();
});

test('a renderer that cannot be BUILT returns the original stream — honesty by identity', () => {
  const p = fakePlatform([]);
  const up = createFrameUpscale({
    ...p,
    output: { width: 1920, height: 1080 },
    createRenderer: () => {
      throw new Error('no webgl2');
    },
  });
  const s = stream();
  assert.equal(up.wrap(s), s, 'identity means "not upscaling"');
});

test('a renderer that breaks MID-STREAM stops the wrap and closes the frame in hand', async () => {
  const f1 = frame(1);
  const f2 = frame(2);
  const p = fakePlatform([f1, f2]);
  let disposed = 0;
  const up = createFrameUpscale({
    ...p,
    output: { width: 1920, height: 1080 },
    createRenderer: () => ({
      render: (f) => {
        if (f.n === 2) throw new Error('context lost');
        return { big: f.n, timestamp: f.timestamp };
      },
      dispose: () => (disposed += 1),
    }),
  });
  up.wrap(stream());
  await settle();
  assert.deepEqual(p.written.map((w) => w.big), [1], 'the good frame made it');
  assert.equal(f2.closed, 1, 'the frame that broke the GPU still gets closed');
  assert.equal(disposed, 1, 'the dead renderer is disposed');
});

test('missing platform classes are an honest passthrough, and release is idempotent', () => {
  const up = createFrameUpscale({
    Processor: undefined,
    Generator: undefined,
    output: { width: 1920, height: 1080 },
    createRenderer: () => ({}),
  });
  assert.equal(up.supported, false);
  const s = stream();
  assert.equal(up.wrap(s), s);
  up.release();
  up.release();
});

test('release stops the loop and disposes the renderer', async () => {
  const many = Array.from({ length: 50 }, (_, i) => frame(i));
  const p = fakePlatform(many);
  let disposed = 0;
  const up = createFrameUpscale({
    ...p,
    output: { width: 1920, height: 1080 },
    createRenderer: () => ({
      render: (f) => ({ big: f.n, timestamp: f.timestamp }),
      dispose: () => (disposed += 1),
    }),
  });
  up.wrap(stream());
  up.release();
  await settle();
  assert.ok(p.written.length < 50, 'the loop stopped early');
  assert.ok(disposed >= 1, 'the GL context was lost on purpose');
});
