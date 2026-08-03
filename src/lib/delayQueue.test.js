// Run: node --test src/lib/delayQueue.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDelayQueue } from './delayQueue.js';

function harness({ target = 500, maxFrames = 4 } = {}) {
  let clock = 0;
  const q = createDelayQueue({ targetMs: () => target, now: () => clock, maxFrames });
  const frame = (id) => {
    const f = { id, closed: 0, close: () => (f.closed += 1) };
    return f;
  };
  return { q, frame, tick: (ms) => (clock += ms), setTarget: (t) => (target = t) };
}

test('frames become ready only after aging the full target', () => {
  const h = harness({ target: 500 });
  const a = h.frame('a');
  h.q.push(a);
  h.tick(499);
  assert.deepEqual(h.q.takeReady(), [], 'a frame younger than the target stays held');
  h.tick(1);
  assert.deepEqual(h.q.takeReady(), [a], 'and is released the moment it has aged');
});

test('release preserves arrival order and takes ALL due frames', () => {
  const h = harness({ target: 100, maxFrames: 10 });
  const frames = ['a', 'b', 'c'].map(h.frame);
  for (const f of frames) {
    h.q.push(f);
    h.tick(30);
  }
  h.tick(200);
  assert.deepEqual(h.q.takeReady().map((f) => f.id), ['a', 'b', 'c']);
});

test('the queue is BOUNDED: overflow drops the OLDEST and closes it exactly once', () => {
  const h = harness({ target: 10_000, maxFrames: 3 }); // nothing ever ready
  const frames = ['a', 'b', 'c', 'd', 'e'].map(h.frame);
  for (const f of frames) h.q.push(f);
  assert.equal(h.q.stats().held, 3);
  assert.equal(h.q.stats().dropped, 2);
  assert.equal(frames[0].closed, 1, 'a closed once');
  assert.equal(frames[1].closed, 1, 'b closed once');
  assert.equal(frames[2].closed, 0, 'survivors untouched');
  // A latency spike must cost the OLDEST picture, not the newest — dropping
  // new frames would freeze the image at the moment the spike began.
  h.tick(20_000);
  assert.deepEqual(h.q.takeReady().map((f) => f.id), ['c', 'd', 'e']);
});

test('a SHRINKING target releases the backlog — elastic in both directions', () => {
  const h = harness({ target: 1_000, maxFrames: 10 });
  h.q.push(h.frame('a'));
  h.tick(400);
  assert.deepEqual(h.q.takeReady(), [], 'held under the high target');
  h.setTarget(200); // the audio caught up; the policy slewed down
  assert.equal(h.q.takeReady().length, 1, 'the same frame is now overdue and releases');
});

test('clear() closes everything still held — a stopped session leaks nothing', () => {
  const h = harness({ target: 10_000 });
  const a = h.frame('a');
  const b = h.frame('b');
  h.q.push(a);
  h.q.push(b);
  h.q.clear();
  assert.equal(a.closed, 1);
  assert.equal(b.closed, 1);
  assert.equal(h.q.stats().held, 0);
});

test('frames handed out are NOT closed by the queue — ownership transfers on take', () => {
  const h = harness({ target: 0 });
  const a = h.frame('a');
  h.q.push(a);
  h.tick(1);
  const [taken] = h.q.takeReady();
  h.q.clear();
  assert.equal(taken.closed, 0, 'the caller owns what it took');
});
