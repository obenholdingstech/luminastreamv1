// Run: node --test src/lib/sessionHolder.test.js
//
// These are the tests that could not exist while this logic lived in
// Studio.jsx. Every case below is a lifecycle race — the page going away part
// way through a claim — and each one was previously a comment asserting the
// code was right rather than a check that it is.
//
// The stake in all of them: a slot nobody releases is held until its lease
// expires two hours later, and there is one slot.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionHolder, PHASE } from './sessionHolder.js';

const GRANT = {
  sessionId: 'sess-1',
  endToken: 'end-tok',
  room: 'luminastream-test',
  identity: 'speaker-abcd1234',
  token: 'a.b.c',
  url: 'wss://proj.livekit.cloud',
  adminToken: 'admin-1',
};

/**
 * A holder with recording collaborators and a create we can resolve by hand,
 * which is what makes "unmount DURING the request" expressible at all.
 */
function harness({ grant = GRANT, fail = null } = {}) {
  const calls = { ends: [], beacons: [], opens: [] };
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let gate = false;

  const holder = createSessionHolder({
    async open(args) {
      calls.opens.push(args);
      if (gate) await pending;
      if (fail) throw fail;
      return grant;
    },
    async end(adminToken, session) {
      calls.ends.push({ adminToken, session });
      return true;
    },
    beacon(adminToken, session) {
      calls.beacons.push({ adminToken, session });
    },
    onChange: (s) => calls.states?.push(s),
  });

  calls.states = [];
  return {
    holder,
    calls,
    /** Make the next start() hang until `finish()` is called. */
    hold: () => {
      gate = true;
    },
    finish: () => {
      gate = false;
      release();
    },
    released: () => calls.ends.length + calls.beacons.length,
  };
}

// ─── the ordinary path ─────────────────────────────────────────────────────

test('start claims a slot and publishes what the server allocated', async () => {
  const { holder, calls } = harness();
  await holder.start({ password: 'pw' });

  const state = holder.snapshot();
  assert.equal(state.phase, PHASE.held);
  assert.deepEqual(state.session, { sessionId: 'sess-1', endToken: 'end-tok' });
  assert.deepEqual(state.allocation, { room: 'luminastream-test', identity: 'speaker-abcd1234' });
  assert.equal(state.url, 'wss://proj.livekit.cloud');
  assert.equal(state.token, 'a.b.c');
  assert.equal(state.adminToken, 'admin-1');
  assert.deepEqual(calls.opens, [{ password: 'pw', adminToken: '' }]);
});

test('stop releases the slot and keeps the admin session', async () => {
  const { holder, calls } = harness();
  await holder.start({ password: 'pw' });
  await holder.stop();

  assert.deepEqual(calls.ends, [
    { adminToken: 'admin-1', session: { sessionId: 'sess-1', endToken: 'end-tok' } },
  ]);
  const state = holder.snapshot();
  assert.equal(state.phase, PHASE.idle);
  assert.equal(state.session, null);
  assert.equal(state.url, '');
  assert.equal(state.token, '');
  // Kept: only the SLOT was returned. Making someone re-enter the access key
  // to start a second session would be a tax on stopping.
  assert.equal(state.adminToken, 'admin-1');
});

test('stop with nothing held releases nothing', async () => {
  const { holder, released } = harness();
  await holder.stop();
  assert.equal(released(), 0);
});

test('a second start while one is in flight is ignored', async () => {
  const { holder, calls, hold, finish } = harness();
  hold();
  const first = holder.start({ password: 'pw' });
  await holder.start({ password: 'pw' });
  finish();
  await first;

  assert.equal(calls.opens.length, 1, 'a double click must not claim two slots');
});

test('start while already holding does not claim a second slot', async () => {
  const { holder, calls } = harness();
  await holder.start({ password: 'pw' });
  await holder.start({ password: 'pw' });
  assert.equal(calls.opens.length, 1);
});

// ─── THE RACES ─────────────────────────────────────────────────────────────

test('a slot that arrives after UNMOUNT is given back, not leaked', async () => {
  // Press Start, follow a link 200ms later. The create is already in flight and
  // will succeed; nothing is left to notice.
  const { holder, hold, finish, released, calls } = harness();
  hold();
  const starting = holder.start({ password: 'pw' });

  holder.dispose();
  finish();
  await starting;

  assert.equal(released(), 1, 'the slot must be surrendered by whoever receives it');
  // The ordinary request, not the beacon: an in-app navigation leaves the
  // document alive, so the more reliable channel is available.
  assert.deepEqual(calls.ends[0].session, { sessionId: 'sess-1', endToken: 'end-tok' });
  assert.equal(calls.beacons.length, 0);
  // What matters is that no usable credentials were published. The phase is
  // left as it was: publishing to a disposed holder would only push state at a
  // subscriber that has already gone away.
  assert.equal(holder.snapshot().token, '', 'nothing usable is published to a dead page');
  assert.equal(holder.snapshot().session, null);
});

test('a slot that arrives after PAGEHIDE is given back through the beacon', async () => {
  const { holder, hold, finish, calls } = harness();
  hold();
  const starting = holder.start({ password: 'pw' });

  holder.hide();
  finish();
  await starting;

  assert.equal(calls.beacons.length, 1, 'a hidden page cannot await, so it must beacon');
  assert.equal(calls.ends.length, 0);
});

test('dispose while HOLDING releases the slot', async () => {
  const { holder, released } = harness();
  await holder.start({ password: 'pw' });
  holder.dispose();
  assert.equal(released(), 1);
});

test('hide while HOLDING releases through the beacon but does not blank the UI', async () => {
  const { holder, calls } = harness();
  await holder.start({ password: 'pw' });
  holder.hide();

  assert.equal(calls.beacons.length, 1);
  // Deliberately still populated: a hidden page may be restored, and clearing
  // on the way out would flash an empty interface as the tab disappears.
  assert.equal(holder.snapshot().phase, PHASE.held);
});

test('BFCACHE RESTORE clears credentials for a slot we no longer hold', async () => {
  // The dangerous one. The slot was surrendered on the way out and the
  // registry may have handed that room to somebody else. Reconnecting with the
  // stale grant would drop this tab into a stranger's session.
  const { holder } = harness();
  await holder.start({ password: 'pw' });
  holder.hide();
  holder.restored();

  const state = holder.snapshot();
  assert.equal(state.phase, PHASE.idle);
  assert.equal(state.token, '', 'a stale grant must not remain usable');
  assert.equal(state.url, '');
  assert.equal(state.session, null);
  assert.equal(state.adminToken, 'admin-1', 'but the user is still unlocked');
});

test('a restore with nothing surrendered leaves a live session alone', async () => {
  // hide() with no slot held surrenders nothing, so a restore must not wipe a
  // session the user legitimately still has.
  const { holder } = harness();
  holder.hide();
  holder.restored();
  await holder.start({ password: 'pw' });
  holder.restored();

  assert.equal(holder.snapshot().phase, PHASE.held);
  assert.equal(holder.snapshot().token, 'a.b.c');
});

test('a start that resolves after hide-then-restore still does not leak', async () => {
  const { holder, hold, finish, released } = harness();
  hold();
  const starting = holder.start({ password: 'pw' });
  holder.hide();
  finish();
  await starting;
  holder.restored();

  assert.equal(released(), 1);
  assert.equal(holder.snapshot().phase, PHASE.idle, 'and the UI offers a fresh start');
});

// ─── failures ──────────────────────────────────────────────────────────────

test('a busy lens surfaces the message and keeps the admin session', async () => {
  const err = Object.assign(new Error('the lens is busy right now — try again in a moment'), {
    status: 503,
    code: 'at_capacity',
    adminToken: 'admin-kept',
  });
  const { holder } = harness({ fail: err });
  await holder.start({ password: 'pw' });

  const state = holder.snapshot();
  assert.equal(state.phase, PHASE.idle);
  assert.match(state.error, /busy/);
  assert.equal(state.adminToken, 'admin-kept', 'a full lens must not cost the access key');
});

test('a 401 drops the admin session rather than keeping what just failed', async () => {
  const err = Object.assign(new Error('admin session expired'), { status: 401 });
  const { holder } = harness({ fail: err });
  await holder.start({ password: 'pw' });
  assert.equal(holder.snapshot().adminToken, '');
});

test('a failure after UNMOUNT publishes nothing', async () => {
  const { holder, hold, finish, calls } = harness({ fail: new Error('network down') });
  hold();
  const starting = holder.start({ password: 'pw' });
  holder.dispose();
  finish();
  await starting;

  // No slot was allocated, so there is nothing to release — and nobody to
  // show an error to either.
  assert.equal(calls.ends.length + calls.beacons.length, 0);
  assert.equal(holder.snapshot().error, '');
});

test('a failure while HIDDEN still returns the phase to idle', async () => {
  // The Start button would otherwise be permanently inert. `restored()` only
  // resets state when a slot was surrendered, and a failed claim surrenders
  // nothing — so an early return leaves `starting` published forever, and the
  // guard at the top of start() then refuses every later attempt.
  //
  // This case previously had a test that asserted the BUG: it checked that
  // nothing was published after the page went away, which is exactly what
  // wedges the phase. Splitting unmount from hidden is the fix — an unmounted
  // holder is never read again, a hidden one can come back.
  const { holder, hold, finish } = harness({ fail: new Error('network down') });
  hold();
  const starting = holder.start({ password: 'pw' });
  holder.hide();
  finish();
  await starting;

  assert.equal(holder.snapshot().phase, PHASE.idle, 'a hidden failure must not wedge the phase');
  assert.equal(holder.snapshot().error, '', 'and there is nobody to show an error to');
});

test('a hidden failure leaves the lens startable again after a restore', async () => {
  // The consequence the phase reset exists for, end to end — and the failure
  // must land WHILE hidden, which is the whole point. An earlier version of
  // this test hid the page after the failure had already been handled, so it
  // never touched the wedge path and passed against the bug.
  let attempt = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const holder = createSessionHolder({
    async open() {
      attempt += 1;
      if (attempt === 1) {
        await gate;
        throw new Error('network down');
      }
      return GRANT;
    },
    async end() {},
    beacon() {},
  });

  const failing = holder.start({ password: 'pw' });
  holder.hide(); // hidden BEFORE the claim fails
  release();
  await failing;

  holder.restored();
  await holder.start({ password: 'pw' });

  assert.equal(holder.snapshot().phase, PHASE.held, 'the Start control must still work');
  assert.equal(attempt, 2, 'the second attempt must actually be made');
});

test('a rejecting release never escapes as an unhandled rejection', async () => {
  // hide() and dispose() cannot await, so a rejection there has nobody to
  // catch it — fatal in some Node and worker contexts, noise in browser error
  // reporting. Today's endSession never rejects, but this helper must not
  // depend on a collaborator's internal politeness when the collaborator is
  // injected.
  const rejections = [];
  const onUnhandled = (err) => rejections.push(err);
  process.on('unhandledRejection', onUnhandled);

  try {
    const holder = createSessionHolder({
      async open() {
        return GRANT;
      },
      async end() {
        throw new Error('end failed');
      },
      async beacon() {
        throw new Error('beacon failed');
      },
    });

    await holder.start({ password: 'pw' });
    holder.hide(); // fire-and-forget beacon that rejects
    holder.dispose(); // fire-and-forget end that rejects

    // Let any unhandled rejection surface before asserting.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(rejections, [], 'a failed release must not crash the page');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('stop still resolves when the release rejects', async () => {
  const holder = createSessionHolder({
    async open() {
      return GRANT;
    },
    async end() {
      throw new Error('end failed');
    },
    beacon() {},
  });

  await holder.start({ password: 'pw' });
  // stop() awaits the release, so a rejection here IS observable — and must
  // not leave the UI stuck showing a session the user already ended.
  await assert.rejects(() => holder.stop());
  assert.equal(holder.snapshot().phase, PHASE.idle, 'the state was cleared before the release');
});

test('a failed start can be retried', async () => {
  let attempt = 0;
  const holder = createSessionHolder({
    async open() {
      attempt += 1;
      if (attempt === 1) throw Object.assign(new Error('busy'), { status: 503 });
      return GRANT;
    },
    async end() {},
    beacon() {},
  });

  await holder.start({ password: 'pw' });
  assert.equal(holder.snapshot().phase, PHASE.idle);
  await holder.start({ password: 'pw' });
  assert.equal(holder.snapshot().phase, PHASE.held);
});

test('every state change is published so a view can mirror it', async () => {
  const { holder, calls } = harness();
  await holder.start({ password: 'pw' });
  await holder.stop();

  const phases = calls.states.map((s) => s.phase);
  assert.deepEqual(phases, [PHASE.starting, PHASE.held, PHASE.idle]);
});
