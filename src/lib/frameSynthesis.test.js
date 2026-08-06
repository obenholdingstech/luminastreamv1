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

// Test-friendly cadence: real frames every 50ms (20fps, µs timestamps);
// target 40fps → a grid tick every 25ms. Per pair: one synthesized frame at
// t=0.5 (the 25ms tick) and the REAL frame snapped at the 50ms tick.
const INTERVAL_US = 50_000;
const TARGET = 40; // tick 25_000µs
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

test('the grid resamples 20fps to 40: synth at the mid tick, the REAL frame snapped at its own tick', async () => {
  const f1 = frame(0);
  const f2 = frame(1);
  const f3 = frame(2);
  const p = fakePlatform([f1, f2, f3]);
  const r = fakeRenderer();
  const synth = createFrameSynthesis({
    ...p,
    controller: { current: { targetFps: TARGET, renderer: r } },
    sleep: noSleep,
  });
  synth.wrap(stream());
  await settle();

  const kinds = p.written.map((w) => w.synth ?? w.n);
  assert.deepEqual(
    kinds,
    [0, '0c-1@0.5', 1, '1c-2@0.5', 2],
    'per pair: one invented middle, then the vendor frame itself — never a synthetic copy of it',
  );
  const stamps = p.written.map((w) => w.timestamp);
  assert.deepEqual([...stamps].sort((a, b) => a - b), stamps, 'timestamps strictly ordered');
  assert.equal(stamps[1], 25_000, 'the synthesized frame sits ON the grid');
  assert.deepEqual(
    r.calls.map((c) => c.t),
    [0.5, 0.5],
    'fractional t computed from the tick position inside the pair',
  );
  synth.release();
});

test('when native OUTRUNS the grid, real frames are dropped (closed), never queued', async () => {
  // target 10fps → tick 100ms; native every 50ms. f2 falls between ticks and
  // must be resampled AWAY — closed by the loop, invisible downstream.
  const f1 = frame(0);
  const f2 = frame(1);
  const f3 = frame(2);
  const p = fakePlatform([f1, f2, f3]);
  const r = fakeRenderer();
  const synth = createFrameSynthesis({
    ...p,
    controller: { current: { targetFps: 10, renderer: r } },
    sleep: noSleep,
  });
  synth.wrap(stream());
  await settle();
  assert.deepEqual(p.written.map((w) => w.synth ?? w.n), [0, 2], 'f2 resampled away');
  assert.equal(f2.closed, 1, 'the dropped real frame is closed exactly once');
  assert.equal(r.calls.length, 0, 'nothing to invent — the grid landed on real frames');
  synth.release();
});

test("'off' is a pure forward: every frame untouched, the renderer never consulted", async () => {
  const f1 = frame(1);
  const f2 = frame(2);
  const f3 = frame(3);
  const p = fakePlatform([f1, f2, f3]);
  const r = fakeRenderer();
  const controller = { current: { targetFps: null, renderer: null } };
  const synth = createFrameSynthesis({ ...p, controller, sleep: noSleep });
  synth.wrap(stream());
  await settle();
  assert.deepEqual(p.written.map((w) => w.n), [1, 2, 3], 'pure forward in off');
  assert.equal(r.calls.length, 0);
  synth.release();
});

test('a mode switch mid-stream takes effect without rewrapping', async () => {
  const frames = [frame(0), frame(1), frame(2), frame(3)];
  const p = fakePlatform(frames);
  const r = fakeRenderer();
  const controller = { current: { targetFps: null, renderer: null } };
  // Hold the reader between frames so we can flip the mode deterministically:
  let releaseNext;
  const gate = () => new Promise((res) => (releaseNext = res));
  const queue = [...frames];
  p.Processor = function () {
    this.readable = {
      getReader: () => ({
        read: async () => {
          if (queue.length === 2) await gate(); // pause before frame 2
          return queue.length > 0 ? { value: queue.shift(), done: false } : { done: true };
        },
        releaseLock: () => {},
      }),
    };
  };
  const synth = createFrameSynthesis({ ...p, controller, sleep: noSleep });
  synth.wrap(stream());
  await settle();
  assert.deepEqual(p.written.map((w) => w.n), [0, 1], 'forwarding while off');
  controller.current = { targetFps: TARGET, renderer: r };
  releaseNext();
  await settle();
  const rest = p.written.slice(2).map((w) => w.synth ?? w.n);
  assert.deepEqual(rest, [2, '2c-3@0.5', 3], 'first pair after the switch synthesizes on the grid');
  synth.release();
});

test('a discontinuity (gap outside sanity) restarts the pair AND the grid instead of smearing across it', async () => {
  const f1 = frame(0, 0);
  const f2 = frame(1, INTERVAL_US);
  const f3 = frame(2, INTERVAL_US + 400_000); // a 400ms stall
  const f4 = frame(3, INTERVAL_US + 450_000); // clean pair after the stall
  const p = fakePlatform([f1, f2, f3, f4]);
  const r = fakeRenderer();
  const synth = createFrameSynthesis({
    ...p,
    controller: { current: { targetFps: TARGET, renderer: r } },
    sleep: noSleep,
  });
  synth.wrap(stream());
  await settle();
  assert.deepEqual(
    p.written.map((w) => w.synth ?? w.n),
    [0, '0c-1@0.5', 1, 2, '2c-3@0.5', 3],
    'the stall pair is forwarded raw; the grid restarts from the far side',
  );
  assert.equal(r.calls.length, 2, 'no interpolation across the stall');
  synth.release();
});

test('a throwing renderer forwards the real frame, reports, and the stream survives', async () => {
  const p = fakePlatform([frame(0), frame(1), frame(2)]);
  const errors = [];
  const bad = {
    synthesize() {
      throw new Error('device lost');
    },
    dispose() {},
  };
  const controller = { current: { targetFps: TARGET, renderer: bad } };
  const synth = createFrameSynthesis({
    ...p,
    controller,
    sleep: noSleep,
    onRenderError: (e) => {
      errors.push(e);
      controller.current = { targetFps: null, renderer: null }; // what the stage does
    },
  });
  synth.wrap(stream());
  await settle();
  assert.equal(errors.length, 1, 'reported once, then the stage demoted');
  assert.deepEqual(p.written.map((w) => w.n), [0, 1, 2], 'every real frame still arrived');
  synth.release();
});

test('the transfer contract: emitted frames are NOT closed by the loop; pair-state clones and dropped frames are', async () => {
  const f1 = frame(0);
  const f2 = frame(1);
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
    controller: { current: { targetFps: TARGET, renderer: r } },
    sleep: noSleep,
  });
  synth.wrap(stream());
  await settle();
  synth.release();
  await settle();
  // Both reals were emitted here (f1 opens the chain, f2 snaps to its tick) —
  // a successful write TRANSFERS the frame; closing it would double-free.
  assert.equal(f1.closed, 0, 'written input left to the generator');
  assert.equal(f2.closed, 0, 'snapped input left to the generator');
  assert.ok(clones.length > 0, 'pair-state was actually cloned');
  for (const c of clones) assert.equal(c.closed, 1, 'pair-state clone closed exactly once');
});

test('a rejected write closes the frame being written AND the rest of the paced queue', async () => {
  // Pair (0,1) at target 40 produces [synth@25ms, real 1]. The writer accepts
  // the first write (real frame 0) and rejects the next — the synth is closed
  // by writeOrClose, and the snapped real must be closed by the queue
  // cleanup. An unclosed VideoFrame pins GPU memory.
  const made = [];
  const renderer = {
    synthesize(a, b, t, ts) {
      const out = { synth: t, timestamp: ts, closed: 0, close() { this.closed += 1; } };
      made.push(out);
      return out;
    },
    dispose() {},
  };
  const f1 = frame(0);
  const f2 = frame(1);
  const p = fakePlatform([f1, f2]);
  let writes = 0;
  p.Generator = function () {
    this.kind = 'video';
    this.writable = {
      getWriter: () => ({
        write: async () => {
          writes += 1;
          if (writes >= 2) throw new Error('generator gone');
        },
        releaseLock: () => {},
      }),
    };
  };
  const synth = createFrameSynthesis({
    ...p,
    controller: { current: { targetFps: TARGET, renderer } },
    sleep: noSleep,
  });
  synth.wrap(stream());
  await settle();
  assert.equal(made.length, 1, 'the mid was rendered before the failing write');
  assert.equal(made[0].closed, 1, 'the frame being written is closed by writeOrClose');
  assert.equal(f2.closed, 1, 'the snapped real owned by the failed sequence is closed');
  synth.release();
});

test('per-frame render cost reaches onSample — snapped reals cost nothing and sample nothing', async () => {
  const p = fakePlatform([frame(0), frame(1), frame(2)]);
  const samples = [];
  const synth = createFrameSynthesis({
    ...p,
    controller: { current: { targetFps: TARGET, renderer: fakeRenderer() } },
    sleep: noSleep,
    onSample: (ms) => samples.push(ms),
  });
  synth.wrap(stream());
  await settle();
  assert.equal(samples.length, 2, 'one sample per SYNTHESIZED frame (2 pairs × 1 mid)');
  for (const s of samples) assert.ok(Number.isFinite(s) && s >= 0);
  synth.release();
});

test('no video track or missing platform → the original stream, honesty by identity', () => {
  const p = fakePlatform([]);
  const synth = createFrameSynthesis({
    ...p,
    controller: { current: { targetFps: TARGET, renderer: fakeRenderer() } },
  });
  const bare = { getVideoTracks: () => [], getAudioTracks: () => [] };
  assert.equal(synth.wrap(bare), bare);
  const unsupported = createFrameSynthesis({
    controller: { current: { targetFps: TARGET, renderer: fakeRenderer() } },
    Processor: undefined,
    Generator: undefined,
  });
  const s = stream();
  assert.equal(unsupported.wrap(s), s);
});
