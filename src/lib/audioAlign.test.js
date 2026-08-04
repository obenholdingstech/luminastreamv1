// Run: node --test src/lib/audioAlign.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { audioHoldSample, createAudioDelayGraph } from './audioAlign.js';

// ─── the sample math ───────────────────────────────────────────────────────

test('audio holds only when it LEADS: (videoPath − mouth→ear), floored at zero', () => {
  assert.equal(audioHoldSample(350, 700), 350, 'direct mode: audio waits for its frames');
  assert.equal(audioHoldSample(1500, 700), 0, 'converted mode: audio is the laggard — no hold');
  assert.equal(audioHoldSample(700, 700), 0, 'exactly met — nothing to do');
  assert.equal(audioHoldSample(NaN, 700), null);
  assert.equal(audioHoldSample(350, undefined), null);
});

// ─── the delay graph's engagement contract ─────────────────────────────────

function fakeContext({ state = 'running' } = {}) {
  const ctx = {
    state,
    currentTime: 1,
    onstatechange: null,
    destination: { name: 'speakers' },
    closed: 0,
    resumed: 0,
    delayNodes: [],
    sources: [],
    createMediaStreamSource(stream) {
      const s = { stream, connected: null, disconnected: 0 };
      s.connect = (to) => (s.connected = to);
      s.disconnect = () => (s.disconnected += 1);
      ctx.sources.push(s);
      return s;
    },
    createDelay(max) {
      const d = {
        max,
        connected: null,
        delayTime: {
          value: 0,
          targets: [],
          setTargetAtTime(v, t, tc) {
            this.targets.push({ v, t, tc });
          },
        },
      };
      d.connect = (to) => (d.connected = to);
      ctx.delayNodes.push(d);
      return d;
    },
    resume() {
      ctx.resumed += 1;
      return Promise.resolve();
    },
    close() {
      ctx.closed += 1;
      return Promise.resolve();
    },
    /** test helper: the platform changes the context's state */
    become(next) {
      ctx.state = next;
      ctx.onstatechange?.();
    },
  };
  return ctx;
}

const FakeStream = function (tracks) {
  this.tracks = tracks;
};

function graphWith(ctx) {
  const events = [];
  const graph = createAudioDelayGraph({
    track: { kind: 'audio' },
    createContext: () => ctx,
    StreamCtor: FakeStream,
    onEngaged: () => events.push('engaged'),
    onDisengaged: () => events.push('disengaged'),
  });
  return { graph, events };
}

test('a running context engages immediately — and the wiring is source→delay→speakers', () => {
  const ctx = fakeContext();
  const { events } = graphWith(ctx);
  assert.deepEqual(events, ['engaged']);
  assert.equal(ctx.sources[0].connected, ctx.delayNodes[0], 'source feeds the delay line');
  assert.equal(ctx.delayNodes[0].connected, ctx.destination, 'the delay line feeds the speakers');
});

test('a suspended context does NOT mute the voice on optimism — engage waits for running', () => {
  const ctx = fakeContext({ state: 'suspended' });
  const { events } = graphWith(ctx);
  assert.deepEqual(events, [], 'no engagement before the context is verifiably running');
  assert.ok(ctx.resumed >= 1, 'a resume was attempted');
  ctx.become('running');
  assert.deepEqual(events, ['engaged'], 'the state change is what engages');
});

test('suspension mid-flight GIVES THE VOICE BACK; recovery re-engages', () => {
  const ctx = fakeContext();
  const { events } = graphWith(ctx);
  ctx.become('suspended');
  assert.deepEqual(events, ['engaged', 'disengaged']);
  ctx.become('running');
  assert.deepEqual(events, ['engaged', 'disengaged', 'engaged']);
});

test('construction failure leaves the world exactly as found and throws', () => {
  const ctx = fakeContext();
  ctx.createDelay = () => {
    throw new Error('no delay for you');
  };
  const events = [];
  assert.throws(() =>
    createAudioDelayGraph({
      track: {},
      createContext: () => ctx,
      StreamCtor: FakeStream,
      onEngaged: () => events.push('engaged'),
      onDisengaged: () => events.push('disengaged'),
    }),
  );
  assert.deepEqual(events, [], 'the voice was never touched');
  assert.equal(ctx.sources[0].disconnected, 1, 'the half-built source was disconnected');
  assert.equal(ctx.closed, 1, 'the context was closed');
});

test('setTarget glides in seconds, clamped to the line; junk is refused', () => {
  const ctx = fakeContext();
  const { graph } = graphWith(ctx);
  graph.setTarget(350);
  graph.setTarget(99_999);
  graph.setTarget(NaN);
  graph.setTarget(-200);
  const targets = ctx.delayNodes[0].delayTime.targets;
  assert.deepEqual(
    targets.map((t) => t.v),
    [0.35, 2, 0],
    '350ms → 0.35s; the impossible clamps to the line; junk never arrives',
  );
});

test('dispose disengages exactly once, disconnects, closes — and is idempotent', () => {
  const ctx = fakeContext();
  const { graph, events } = graphWith(ctx);
  graph.dispose();
  graph.dispose();
  assert.deepEqual(events, ['engaged', 'disengaged']);
  assert.equal(ctx.sources[0].disconnected, 1);
  assert.equal(ctx.closed, 1);
  graph.setTarget(500);
  assert.deepEqual(ctx.delayNodes[0].delayTime.targets, [], 'a disposed graph moves nothing');
});

// ─── the visible-hold state machine ────────────────────────────────────────

import { createHoldReporter } from './audioAlign.js';

test('the UI may claim a hold ONLY while engaged — target cached across the gap', () => {
  const r = createHoldReporter();
  assert.equal(r.observe(400), 0, 'a target on a disengaged line is not a claim');
  assert.equal(r.engage(), 400, 'engagement surfaces the cached truth');
  assert.equal(r.observe(350), 350, 'engaged targets show immediately');
  assert.equal(r.disengage(), 0, 'the element has the voice — claim nothing');
  assert.equal(r.observe(500), 0, 'still disengaged, still nothing');
  assert.equal(r.engage(), 500, 'recovery resumes the newest truth, not the stale one');
});

test('the reporter refuses junk and floors at zero', () => {
  const r = createHoldReporter();
  r.engage();
  assert.equal(r.observe(NaN), 0, 'junk does not move the cache');
  assert.equal(r.observe(-50), 0, 'negative holds do not exist');
  assert.equal(r.observe(200), 200);
});
