import assert from 'node:assert/strict';
import test from 'node:test';

import { startMicLevelMeter } from './micLevelMeter.js';

// A fake Web Audio graph. Records what was called so teardown can be asserted
// rather than assumed — the failure path is the one nobody exercises by hand,
// and it is exactly where a leaked AudioContext hides.
function fakeAudio({ amplitude = 0, throwAt = null, closeThrows = false } = {}) {
  const log = { disconnects: 0, closes: 0, resumes: 0, contexts: 0, reads: 0 };

  const analyser = {
    fftSize: 0,
    getFloatTimeDomainData(buffer) {
      log.reads += 1;
      // `frame` throws on the Nth read, simulating the graph dying under us
      // mid-animation-frame rather than during setup.
      if (throwAt === 'frame' && log.reads >= 2) throw new Error('context invalidated');
      buffer.fill(amplitude);
    },
  };

  const source = {
    connect() {},
    disconnect() {
      log.disconnects += 1;
    },
  };

  const context = {
    resume() {
      log.resumes += 1;
      return Promise.resolve();
    },
    createMediaStreamSource() {
      if (throwAt === 'source') throw new Error('track ended');
      return source;
    },
    createAnalyser() {
      if (throwAt === 'analyser') throw new Error('no analyser');
      return analyser;
    },
    close() {
      log.closes += 1;
      if (closeThrows) throw new Error('already closed');
      return Promise.resolve();
    },
  };

  const frames = [];
  const deps = {
    createContext() {
      if (throwAt === 'context') throw new Error('context budget exhausted');
      log.contexts += 1;
      return context;
    },
    createStream: (track) => ({ track }),
    raf(cb) {
      frames.push(cb);
      return frames.length; // a non-zero handle
    },
    caf(handle) {
      log.cancelled = handle;
    },
  };

  // Run the animation loop by hand: each pump drains exactly one queued frame.
  const pump = (times = 1) => {
    for (let i = 0; i < times; i += 1) {
      const cb = frames.shift();
      if (cb) cb();
    }
  };

  return { deps, log, pump, pending: () => frames.length };
}

const TRACK = { id: 'fake-mic' };

// ── the happy path ─────────────────────────────────────────────────────────

test('reports a rising level while the track is live', () => {
  const levels = [];
  const { deps, pump } = fakeAudio({ amplitude: 0.5 }); // RMS 0.5 × gain 4 → clamps to 1
  startMicLevelMeter(TRACK, (l) => levels.push(l), deps);

  pump(3);
  assert.equal(levels.length, 3);
  // Attack of 0.5 from rest: 0.5 → 0.75 → 0.875, never overshooting 1.
  assert.ok(Math.abs(levels[0] - 0.5) < 1e-9, `first frame was ${levels[0]}`);
  assert.ok(levels[1] > levels[0] && levels[2] > levels[1], 'level must rise');
  assert.ok(levels[2] < 1, 'smoothing must not reach the target in three frames');
});

test('silence decays more slowly than speech rises', () => {
  const loud = [];
  const quiet = [];
  const a = fakeAudio({ amplitude: 0.5 });
  startMicLevelMeter(TRACK, (l) => loud.push(l), a.deps);
  a.pump(1);

  const b = fakeAudio({ amplitude: 0 });
  startMicLevelMeter(TRACK, (l) => quiet.push(l), b.deps);
  b.pump(1);

  // One frame of full-scale input moves the ring 0.5; one frame of silence
  // from rest moves it not at all. The asymmetry is the point.
  assert.equal(quiet[0], 0);
  assert.ok(loud[0] > quiet[0]);
});

test('a quiet room reads as zero, not as a permanent glow', () => {
  const levels = [];
  const { deps, pump } = fakeAudio({ amplitude: 0 });
  startMicLevelMeter(TRACK, (l) => levels.push(l), deps);
  pump(5);
  assert.deepEqual(new Set(levels), new Set([0]));
});

test('the level is clamped to 1 no matter how loud the input', () => {
  const levels = [];
  const { deps, pump } = fakeAudio({ amplitude: 1 });
  startMicLevelMeter(TRACK, (l) => levels.push(l), deps);
  pump(40);
  assert.ok(Math.max(...levels) <= 1, `saw ${Math.max(...levels)}`);
});

// ── teardown ───────────────────────────────────────────────────────────────

test('stop cancels the frame, disconnects, closes, and reports zero', () => {
  const levels = [];
  const { deps, log, pump } = fakeAudio({ amplitude: 0.5 });
  const stop = startMicLevelMeter(TRACK, (l) => levels.push(l), deps);
  pump(2);

  stop();
  assert.equal(log.disconnects, 1, 'source must be disconnected');
  assert.equal(log.closes, 1, 'context must be closed');
  assert.ok(log.cancelled != null, 'the pending frame must be cancelled');
  assert.equal(levels.at(-1), 0, 'the ring must be told to settle');
});

test('a frame that fires after stop does nothing', () => {
  const levels = [];
  const { deps, pump } = fakeAudio({ amplitude: 0.5 });
  const stop = startMicLevelMeter(TRACK, (l) => levels.push(l), deps);
  pump(1);
  stop();
  const afterStop = levels.length;
  pump(1); // a frame already in flight when cancellation landed
  assert.equal(levels.length, afterStop, 'a late frame must not report a level');
});

test('stop is idempotent — a double stop does not double-close', () => {
  const { deps, log } = fakeAudio({ amplitude: 0.5 });
  const stop = startMicLevelMeter(TRACK, () => {}, deps);
  stop();
  stop();
  stop();
  assert.equal(log.closes, 1);
  assert.equal(log.disconnects, 1);
});

// The `stopped` early-return in teardown is what this pins down. Nulling the
// context and source already makes a second stop harmless to the audio graph,
// so without this test the guard is invisible to the suite — verified by
// removing it and watching nothing go red.
//
// It is not decoration. A late stop that fires after a NEW meter has started
// for a replaced track would report 0 at a consumer now painting a live ring,
// freezing it until the next frame. One redundant report is one visible glitch.
test('a second stop stays silent instead of re-reporting zero', () => {
  const levels = [];
  const { deps, pump } = fakeAudio({ amplitude: 0.5 });
  const stop = startMicLevelMeter(TRACK, (l) => levels.push(l), deps);
  pump(1);
  stop();
  const afterFirstStop = levels.length;
  stop();
  stop();
  assert.equal(levels.length, afterFirstStop, 'teardown must report zero exactly once');
});

test('a throwing close does not escape the caller', () => {
  const { deps } = fakeAudio({ amplitude: 0.5, closeThrows: true });
  const stop = startMicLevelMeter(TRACK, () => {}, deps);
  assert.doesNotThrow(stop);
});

// ── the failure path: the one that leaks if nobody looks ────────────────────

test('a throw AFTER the context exists still closes the context', () => {
  const { deps, log } = fakeAudio({ throwAt: 'source' });
  const stop = startMicLevelMeter(TRACK, () => {}, deps);
  assert.equal(log.contexts, 1, 'the context was constructed');
  assert.equal(log.closes, 1, 'and must not be leaked when setup fails');
  assert.doesNotThrow(stop, 'the returned stop stays safe to call');
});

test('a throw after the SOURCE exists disconnects it as well as closing', () => {
  const { deps, log } = fakeAudio({ throwAt: 'analyser' });
  startMicLevelMeter(TRACK, () => {}, deps);
  assert.equal(log.disconnects, 1);
  assert.equal(log.closes, 1);
});

test('a throw before any context exists is survivable and closes nothing', () => {
  const levels = [];
  const { deps, log } = fakeAudio({ throwAt: 'context' });
  const stop = startMicLevelMeter(TRACK, (l) => levels.push(l), deps);
  assert.equal(log.contexts, 0);
  assert.equal(log.closes, 0);
  assert.equal(levels.at(-1), 0);
  assert.doesNotThrow(stop);
});

// The setup try/catch cannot see this one. tick runs from the browser's own
// animation-frame callback, so a throw there escapes to the browser, schedules
// no next frame, and would never reach teardown — the same leaked context,
// arriving by a route the setup guard cannot reach.
test('a throw INSIDE an animation frame tears the graph down', () => {
  const levels = [];
  const { deps, log, pump } = fakeAudio({ amplitude: 0.5, throwAt: 'frame' });
  startMicLevelMeter(TRACK, (l) => levels.push(l), deps);

  pump(1); // healthy frame
  assert.equal(log.closes, 0, 'a good frame must not tear anything down');

  assert.doesNotThrow(() => pump(1), 'the throw must not escape the frame');
  assert.equal(log.closes, 1, 'the context must be closed, not leaked');
  assert.equal(log.disconnects, 1);
  assert.equal(levels.at(-1), 0, 'and the ring told to settle');
});

test('a frame that died stops scheduling more frames', () => {
  const { deps, pump, pending } = fakeAudio({ amplitude: 0.5, throwAt: 'frame' });
  startMicLevelMeter(TRACK, () => {}, deps);
  pump(2); // one good frame, then the throw
  assert.equal(pending(), 0, 'no further frame may be queued after the graph died');
});

test('stopping from inside onLevel does not queue another frame', () => {
  // report() hands control to the consumer mid-frame, and a React effect
  // tearing down at that moment calls stop() from exactly there. The frame
  // scheduled afterward would outlive teardown with nothing left to cancel it.
  const { deps, pump, pending, log } = fakeAudio({ amplitude: 0.5 });
  let stop = () => {};
  stop = startMicLevelMeter(TRACK, () => stop(), deps);

  pump(1);
  assert.equal(pending(), 0, 'no frame may be queued after a stop from inside the callback');
  assert.equal(log.closes, 1);
});

test('setup failure never throws at the caller', () => {
  for (const throwAt of ['context', 'source', 'analyser']) {
    const { deps } = fakeAudio({ throwAt });
    assert.doesNotThrow(
      () => startMicLevelMeter(TRACK, () => {}, deps),
      `throwAt=${throwAt} escaped`,
    );
  }
});

// ── degenerate inputs ──────────────────────────────────────────────────────

test('no track means no audio graph at all', () => {
  const levels = [];
  const { deps, log } = fakeAudio();
  const stop = startMicLevelMeter(null, (l) => levels.push(l), deps);
  assert.equal(log.contexts, 0, 'must not build a context for a missing track');
  assert.deepEqual(levels, [0]);
  assert.doesNotThrow(stop);
});

test('a browser with no Web Audio degrades to a calm ring', () => {
  const levels = [];
  const stop = startMicLevelMeter(TRACK, (l) => levels.push(l), {
    createContext: () => null,
  });
  assert.deepEqual(levels, [0]);
  assert.doesNotThrow(stop);
});

test('a consumer that throws does not take the audio graph down', () => {
  const { deps, pump, log } = fakeAudio({ amplitude: 0.5 });
  const stop = startMicLevelMeter(
    TRACK,
    () => {
      throw new Error('render exploded');
    },
    deps,
  );
  assert.doesNotThrow(() => pump(3));
  stop();
  assert.equal(log.closes, 1, 'teardown still runs after a throwing consumer');
});

test('the context is resumed, because a suspended one only ever reports silence', () => {
  const { deps, log } = fakeAudio({ amplitude: 0.5 });
  startMicLevelMeter(TRACK, () => {}, deps);
  assert.equal(log.resumes, 1);
});
