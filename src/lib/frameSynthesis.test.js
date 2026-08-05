// Run: node --test src/lib/frameSynthesis.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrameSynthesis } from './frameSynthesis.js';

// The same fake-platform shape frameUpscale's tests use, plus clone(): the
// synthesis loop keeps a clone as pair-state because a written frame is
// transferred.
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

// Timestamps in MICROSECONDS at the real 19fps cadence (~52.6ms).
const INTERVAL_US = 52_600;
function frame(n, ts = n * INTERVAL_US) {
  return {
    n,
    timestamp: ts,
    closed: 0,
    close() {
      this.closed += 1;
    },
    clone() {
      return frame(`${n}c`, ts);
    },
  };
}
const stream = () => ({
  getVideoTracks: () => [{ kind: 'video' }],
  getAudioTracks: () => [],
});
const settle = () => new Promise((r) => setTimeout(r, 20));
const noSleep = () => Promise.resolve();

function fakeRenderer() {
  const calls = [];
  return {
    calls,
    synthesize(a, b, t, ts) {
      calls.push({ a: a.n, b: b.n, t, ts });
      return { synth: `${a.n}-${b.n}@${t}`, timestamp: ts, closed: 0, close() { this.closed += 1; } };
    },
    dispose() {},
  };
}

test('factor 2 doubles the stream: real, mid, real — timestamps interleaved and ordered', async () => {
  const f1 = frame(1);
  const f2 = frame(2);
  const f3 = frame(3);
  const p = fakePlatform([f1, f2, f3]);
  const r = fakeRenderer();
  const controller = { current: { factor: 2, renderer: r } };
  const synth = createFrameSynthesis({ ...p, controller, sleep: noSleep });
  synth.wrap(stream());
  await settle();

  const kinds = p.written.map((w) => w.synth ?? w.n);
  assert.deepEqual(kinds, [1, '1c-2@0.5', 2, '2c-3@0.5', 3], 'mid frames sit between reals');
  const stamps = p.written.map((w) => w.timestamp);
  assert.deepEqual([...stamps].sort((a, b) => a - b), stamps, 'timestamps strictly ordered');
  assert.equal(stamps[1], Math.round(1.5 * INTERVAL_US), 'the midpoint carries the midpoint time');
  synth.release();
});

test('factor 3 emits two intermediates per pair at 1/3 and 2/3', async () => {
  const p = fakePlatform([frame(1), frame(2)]);
  const r = fakeRenderer();
  const synth = createFrameSynthesis({
    ...p,
    controller: { current: { factor: 3, renderer: r } },
    sleep: noSleep,
  });
  synth.wrap(stream());
  await settle();
  assert.deepEqual(
    r.calls.map((c) => c.t),
    [1 / 3, 2 / 3],
  );
  assert.equal(p.written.length, 4, 'real, mid, mid, real');
});

test("'off' forwards untouched and drops pair-state so a later upgrade cannot bridge the gap", async () => {
  const f1 = frame(1);
  const f2 = frame(2);
  const f3 = frame(3);
  const p = fakePlatform([f1, f2, f3]);
  const r = fakeRenderer();
  const controller = { current: { factor: 2, renderer: r } };
  const synth = createFrameSynthesis({ ...p, controller, sleep: noSleep });
  // Start in 'off'; upgrade AFTER f2 has already passed.
  controller.current = { factor: 1, renderer: null };
  synth.wrap(stream());
  await settle();
  assert.deepEqual(p.written.map((w) => w.n), [1, 2, 3], 'pure forward in off');
  assert.equal(r.calls.length, 0);
  synth.release();
});

test('a mode switch mid-stream takes effect without rewrapping', async () => {
  const frames = [frame(1), frame(2), frame(3), frame(4)];
  const p = fakePlatform(frames);
  const r = fakeRenderer();
  const controller = { current: { factor: 1, renderer: null } };
  // Hold the reader between frames so we can flip the mode deterministically:
  let releaseNext;
  const gate = () => new Promise((res) => (releaseNext = res));
  const queue = [...frames];
  p.Processor = function () {
    this.readable = {
      getReader: () => ({
        read: async () => {
          if (queue.length === 2) await gate(); // pause before frame 3
          return queue.length > 0 ? { value: queue.shift(), done: false } : { done: true };
        },
        releaseLock: () => {},
      }),
    };
  };
  const synth = createFrameSynthesis({ ...p, controller, sleep: noSleep });
  synth.wrap(stream());
  await settle();
  assert.deepEqual(p.written.map((w) => w.n), [1, 2], 'forwarding while off');
  controller.current = { factor: 2, renderer: r };
  releaseNext();
  await settle();
  const rest = p.written.slice(2).map((w) => w.synth ?? w.n);
  assert.deepEqual(rest, [3, '3c-4@0.5', 4], 'first pair after the switch synthesizes');
  synth.release();
});

test('a discontinuity (gap outside sanity) restarts the pair instead of smearing across it', async () => {
  const f1 = frame(1, 0);
  const f2 = frame(2, INTERVAL_US);
  const f3 = frame(3, INTERVAL_US + 400_000); // a 400ms stall
  const p = fakePlatform([f1, f2, f3]);
  const r = fakeRenderer();
  const synth = createFrameSynthesis({
    ...p,
    controller: { current: { factor: 2, renderer: r } },
    sleep: noSleep,
  });
  synth.wrap(stream());
  await settle();
  assert.equal(r.calls.length, 1, 'only the sane pair synthesized');
  assert.deepEqual(p.written.map((w) => w.synth ?? w.n), [1, '1c-2@0.5', 2, 3]);
  synth.release();
});

test('a throwing renderer forwards the real frame, reports, and the stream survives', async () => {
  const p = fakePlatform([frame(1), frame(2), frame(3)]);
  const errors = [];
  const bad = {
    synthesize() {
      throw new Error('device lost');
    },
    dispose() {},
  };
  const controller = { current: { factor: 2, renderer: bad } };
  const synth = createFrameSynthesis({
    ...p,
    controller,
    sleep: noSleep,
    onRenderError: (e) => {
      errors.push(e);
      controller.current = { factor: 1, renderer: null }; // what the stage does
    },
  });
  synth.wrap(stream());
  await settle();
  assert.equal(errors.length, 1, 'reported once, then the stage demoted');
  assert.deepEqual(p.written.map((w) => w.n), [1, 2, 3], 'every real frame still arrived');
  synth.release();
});

test('every input is closed exactly once; pair-state clones are closed too', async () => {
  const f1 = frame(1);
  const f2 = frame(2);
  const clones = [];
  const origClone = f1.clone.bind(f1);
  f1.clone = () => {
    const c = origClone();
    clones.push(c);
    return c;
  };
  const p = fakePlatform([f1, f2]);
  const r = fakeRenderer();
  const synth = createFrameSynthesis({
    ...p,
    controller: { current: { factor: 2, renderer: r } },
    sleep: noSleep,
  });
  synth.wrap(stream());
  await settle();
  synth.release();
  await settle();
  // Inputs are written (transferred), never closed by the loop while alive;
  // clones ARE the loop's own and must be closed when replaced or on exit.
  for (const c of clones) assert.equal(c.closed, 1, 'pair-state clone closed exactly once');
});

test('per-frame render cost reaches onSample — the governor sees what synthesis costs', async () => {
  const p = fakePlatform([frame(1), frame(2), frame(3)]);
  const samples = [];
  const synth = createFrameSynthesis({
    ...p,
    controller: { current: { factor: 2, renderer: fakeRenderer() } },
    sleep: noSleep,
    onSample: (ms) => samples.push(ms),
  });
  synth.wrap(stream());
  await settle();
  assert.equal(samples.length, 2, 'one sample per synthesized frame');
  for (const s of samples) assert.ok(Number.isFinite(s) && s >= 0);
  synth.release();
});

test('no video track or missing platform → the original stream, honesty by identity', () => {
  const p = fakePlatform([]);
  const synth = createFrameSynthesis({
    ...p,
    controller: { current: { factor: 2, renderer: fakeRenderer() } },
  });
  const bare = { getVideoTracks: () => [], getAudioTracks: () => [] };
  assert.equal(synth.wrap(bare), bare);
  const unsupported = createFrameSynthesis({
    controller: { current: { factor: 2, renderer: fakeRenderer() } },
    Processor: undefined,
    Generator: undefined,
  });
  const s = stream();
  assert.equal(unsupported.wrap(s), s);
});
