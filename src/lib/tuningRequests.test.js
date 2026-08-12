// Run: node --test src/lib/tuningRequests.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { beginRequest, clearRequest, resolveRequests } from './tuningRequests.js';

test('begin and clear are immutable ops on the pending map', () => {
  const p1 = beginRequest({}, 'stability', 0.2);
  assert.deepEqual(p1, { stability: 0.2 });
  const p2 = beginRequest(p1, 'style', 0.6);
  assert.deepEqual(p1, { stability: 0.2 }, 'no mutation');
  assert.deepEqual(clearRequest(p2, 'stability'), { style: 0.6 });
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
