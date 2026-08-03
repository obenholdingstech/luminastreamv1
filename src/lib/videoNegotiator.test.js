// Run: node --test src/lib/videoNegotiator.test.js
//
// The tests that could not exist while this lived in a hook. Every case is a
// lifecycle race or a vendor failure — and the stake is a paid video session
// that must always be releasable and never silently unbilled.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoNegotiator, NEGOTIATION } from './videoNegotiator.js';

/** A fake RTCPeerConnection that lets a test fire ICE whenever it likes. */
function fakePeer({ onCreated } = {}) {
  const pc = {
    connectionState: 'new',
    tracks: [],
    onicecandidate: null,
    ontrack: null,
    onconnectionstatechange: null,
    closed: false,
    addTrack: (t) => pc.tracks.push(t),
    createOffer: async () => ({ type: 'offer', sdp: 'v=0 offer' }),
    setLocalDescription: async () => {},
    setRemoteDescription: async (d) => (pc.remote = d),
    close: () => (pc.closed = true),
    /** Test helpers */
    fireCandidate: (c) => pc.onicecandidate?.({ candidate: c }),
    fireTrack: (stream) => pc.ontrack?.({ streams: [stream] }),
    fail: () => {
      pc.connectionState = 'failed';
      pc.onconnectionstatechange?.();
    },
  };
  onCreated?.(pc);
  return pc;
}

function harness({ createSession, endSession, getUserMedia } = {}) {
  const calls = { candidates: [], ends: [], streams: [], phases: [], failures: [] };
  let peer = null;
  const track = { stop() { track.stopped = true; }, stopped: false };
  const local = { getTracks: () => [track] };

  const negotiator = createVideoNegotiator({
    getUserMedia: getUserMedia ?? (async () => local),
    PeerConnection: function () {
      return fakePeer({ onCreated: (p) => (peer = p) });
    },
    createSession:
      createSession ??
      (async () => ({
        sessionId: 'sess-1',
        controlToken: 'ctrl',
        vendor: { sdpAnswer: 'v=0 answer', etag: 'e1' },
      })),
    endSession: endSession ?? (async (s) => { calls.ends.push(s); return { ok: true, settled: true }; }),
    sendCandidates: (session, c) => calls.candidates.push({ sessionId: session?.sessionId, c }),
    onStream: (s) => calls.streams.push(s),
    onPhase: (p) => calls.phases.push(p),
    onFailure: (r) => calls.failures.push(r),
  });

  return { negotiator, calls, track, peer: () => peer };
}

// ─── the bug that proved the extraction ────────────────────────────────────

test('ICE candidates gathered BEFORE the session exists are queued, not dropped', async () => {
  // Gathering starts at setLocalDescription; the session id arrives a network
  // round trip later. Every candidate in that window used to vanish — and the
  // DOM ICE API does not replay them. Behind NAT that is an intermittent
  // failure with no visible cause.
  let release;
  const gate = new Promise((r) => (release = r));
  const h = harness({
    createSession: async () => {
      await gate;
      return { sessionId: 'sess-1', controlToken: 'c', vendor: { sdpAnswer: 'v=0 answer' } };
    },
  });

  const starting = h.negotiator.start({});
  await new Promise((r) => setImmediate(r));
  h.peer().fireCandidate({ candidate: 'early-1' });
  h.peer().fireCandidate({ candidate: 'early-2' });
  assert.equal(h.calls.candidates.length, 0, 'nothing can be sent before a session id exists');

  release();
  await starting;

  assert.equal(h.calls.candidates.length, 2, 'both early candidates were flushed');
  assert.deepEqual(
    h.calls.candidates.map((x) => x.c[0].candidate),
    ['early-1', 'early-2'],
    'in the order they were gathered',
  );
  assert.ok(h.calls.candidates.every((x) => x.sessionId === 'sess-1'));
});

test('candidates gathered AFTER the session exists go straight out', async () => {
  const h = harness();
  await h.negotiator.start({});
  h.peer().fireCandidate({ candidate: 'late-1' });
  h.peer().fireCandidate(null); // end-of-candidates
  assert.equal(h.calls.candidates.length, 2);
  assert.equal(h.calls.candidates[1].c, null, 'the null sentinel the vendor expects');
});

// ─── cancellation: the Starlink lesson, with a vendor bill ─────────────────

test('stop() during the CAMERA PROMPT aborts the start and claims no session', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const h = harness({ getUserMedia: async () => { await gate; return { getTracks: () => [] }; } });

  const starting = h.negotiator.start({});
  await h.negotiator.stop(); // the user gave up on the permission dialog
  release();
  assert.equal(await starting, null, 'an aborted start resolves null, never throws at the user');
  assert.equal(h.calls.ends.length, 0, 'no session was ever created, so none to end');
});

test('stop() DURING session creation still gives the slot back', async () => {
  // The expensive race: the vendor session is born for a user who has left.
  let release;
  const gate = new Promise((r) => (release = r));
  const h = harness({
    createSession: async () => {
      await gate;
      return { sessionId: 'sess-late', controlToken: 'c', vendor: { sdpAnswer: 'a' } };
    },
  });

  const starting = h.negotiator.start({});
  await new Promise((r) => setImmediate(r));
  await h.negotiator.stop();
  release();
  await starting;

  assert.equal(h.calls.ends.length, 1, 'the session that arrived for nobody was released');
  assert.equal(h.calls.ends[0].sessionId, 'sess-late');
});

test('stop() is reachable from every phase and always stops the camera', async () => {
  for (const phase of ['media', 'creating']) {
    let release;
    const gate = new Promise((r) => (release = r));
    const h =
      phase === 'media'
        ? harness({ getUserMedia: async () => { await gate; return { getTracks: () => [] }; } })
        : harness({ createSession: async () => { await gate; return { sessionId: 's', vendor: { sdpAnswer: 'a' } }; } });
    const starting = h.negotiator.start({});
    await new Promise((r) => setImmediate(r));
    await h.negotiator.stop();
    release();
    await starting;
    assert.equal(h.negotiator.phase, NEGOTIATION.stopped, `stop reachable during ${phase}`);
  }
});

test('stop() on a live session ends it and releases the camera', async () => {
  const h = harness();
  await h.negotiator.start({});
  const peer = h.peer();
  await h.negotiator.stop();

  assert.equal(h.calls.ends.length, 1);
  assert.equal(peer.closed, true, 'the peer connection is closed');
  assert.equal(h.track.stopped, true, 'the camera light goes out');
  assert.equal(h.calls.streams.at(-1), null, 'and the surface is cleared');
});

// ─── failures ──────────────────────────────────────────────────────────────

test('a vendor answer that never arrives releases the session it created', async () => {
  const h = harness({
    createSession: async () => ({ sessionId: 'sess-x', controlToken: 'c', vendor: {} }),
  });
  await assert.rejects(() => h.negotiator.start({}), /no answer/);
  assert.equal(h.calls.ends.length, 1, 'the paid session must not survive our own failure');
  assert.equal(h.calls.ends[0].sessionId, 'sess-x');
});

test('a create failure leaves nothing to release and stops the camera', async () => {
  const h = harness({ createSession: async () => { throw new Error('budget spent'); } });
  await assert.rejects(() => h.negotiator.start({}), /budget spent/);
  assert.equal(h.calls.ends.length, 0);
  assert.equal(h.track.stopped, true);
});

test('a failed peer connection reports once, without tearing down behind the caller', async () => {
  const h = harness();
  await h.negotiator.start({});
  h.peer().fail();
  assert.deepEqual(h.calls.failures, ['the video connection failed']);
});

test('a second start while one is live claims no second session', async () => {
  const h = harness();
  await h.negotiator.start({});
  const again = await h.negotiator.start({});
  assert.equal(again, null);
});

test('the remote stream reaches the surface', async () => {
  const h = harness();
  await h.negotiator.start({});
  const stream = { id: 'remote' };
  h.peer().fireTrack(stream);
  assert.equal(h.calls.streams.at(-1), stream);
});

test('phases advance through the negotiation in order', async () => {
  const h = harness();
  await h.negotiator.start({});
  assert.deepEqual(h.calls.phases, [
    NEGOTIATION.media,
    NEGOTIATION.offering,
    NEGOTIATION.creating,
    NEGOTIATION.answering,
    NEGOTIATION.live,
  ]);
});
