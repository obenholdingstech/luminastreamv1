// Run: node --test src/lib/tuningRequests.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { beginRequest, clearRequest, hasPending, resolveRequests } from './tuningRequests.js';

test('begin and clear are immutable ops on the pending map', () => {
  const p1 = beginRequest({}, 'stability', 0.2);
  assert.deepEqual(p1, { stability: 0.2 });
  const p2 = beginRequest(p1, 'style', 0.6);
  assert.deepEqual(p1, { stability: 0.2 }, 'no mutation');
  assert.deepEqual(clearRequest(p2, 'stability'), { style: 0.6 });
});

test('single-flight: a second same-knob request cannot stack — name-match IS the correlation', () => {
  // The protocol has no request id, so the ONLY sound correlation is
  // one-in-flight-per-knob: without this refusal, a stale answer to the
  // first request (adjusted/rejected/failed publish) would clear a NEWER
  // request it never referred to.
  const p1 = beginRequest({}, 'stability', 0.2);
  const p2 = beginRequest(p1, 'stability', 0.9);
  assert.equal(p2, p1, 'the map is returned unchanged — the newer ask is refused');
  assert.equal(p2.stability, 0.2, 'the in-flight request is preserved, never overwritten');
  assert.equal(hasPending(p1, 'stability'), true);
  assert.equal(hasPending(p1, 'style'), false);
  assert.equal(hasPending(null, 'style'), false);
  // the stale-answer scenario, under the invariant: the one answer that
  // arrives can only refer to the one request that exists
  assert.deepEqual(resolveRequests(p2, { config: {}, rejected: { stability: 'nope' } }), {});
});

test('a broadcast resolves a pending ONLY by answering it', () => {
  const pending = { stability: 0.2, style: 0.6 };
  // applied truth equals the request → resolved; the other stays
  const afterApply = resolveRequests(pending, { config: { stability: 0.2 } });
  assert.deepEqual(afterApply, { style: 0.6 });
  // an unrelated re-broadcast (knob absent) swallows nothing
  const untouched = resolveRequests(pending, { config: { tts_model: 'x' } });
  assert.deepEqual(untouched, pending);
  // a DIFFERENT applied value is not an answer — the request is still in flight
  const stillFlying = resolveRequests(pending, { config: { stability: 0.5 } });
  assert.deepEqual(stillFlying, pending);
});

test('adjusted and rejected are answers too — the agent spoke, truth resumes', () => {
  const pending = { stability: 0.2 };
  assert.deepEqual(
    resolveRequests(pending, { config: {}, adjusted: { stability: { requested: 0.2, applied: 0.3 } } }),
    {},
  );
  assert.deepEqual(resolveRequests(pending, { config: {}, rejected: { stability: 'nope' } }), {});
  assert.deepEqual(resolveRequests(pending, null), pending, 'no broadcast, no resolution');
});
