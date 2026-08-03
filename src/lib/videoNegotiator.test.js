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
    remoteCandidates: [],
    addTrack: (t) => pc.tracks.push(t),
    createOffer: async () => ({ type: 'offer', sdp: 'v=0 offer' }),
    setLocalDescription: async () => {},
    setRemoteDescription: async (d) => (pc.remote = d),
    addIceCandidate: async (c) => pc.remoteCandidates.push(c),
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

function harness({ createSession, endSession, getUserMedia, sendCandidates, EventSourceFactory } = {}) {
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
        // Decart's real passthrough shape: the answer is an
        // RTCSessionDescription-shaped object, never a flat `sdpAnswer`.
        vendor: { sdp: { type: 'answer', sdp: 'v=0 answer' }, etag: 'e1' },
      })),
    endSession: endSession ?? (async (s) => { calls.ends.push(s); return { ok: true, settled: true }; }),
    sendCandidates:
      sendCandidates ?? ((session, c) => calls.candidates.push({ sessionId: session?.sessionId, c })),
    ...(EventSourceFactory ? { EventSourceFactory } : {}),
    onStream: (s) => calls.streams.push(s),
    onPhase: (p) => calls.phases.push(p),
    onFailure: (r) => calls.failures.push(r),
  });

  return { negotiator, calls, track, peer: () => peer };
}

/** Sends are chained microtasks now; one macrotask turn drains the chain. */
const drain = () => new Promise((r) => setImmediate(r));

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
      return {
        sessionId: 'sess-1',
        controlToken: 'c',
        vendor: { sdp: { type: 'answer', sdp: 'v=0 answer' } },
      };
    },
  });

  const starting = h.negotiator.start({});
  await new Promise((r) => setImmediate(r));
  h.peer().fireCandidate({ candidate: 'early-1' });
  h.peer().fireCandidate({ candidate: 'early-2' });
  assert.equal(h.calls.candidates.length, 0, 'nothing can be sent before a session id exists');

  release();
  await starting;
  await drain();

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
  await drain();
  assert.equal(h.calls.candidates.length, 2);
  // The live API rejects a bare null ("Input should be a valid list") — the
  // end-of-candidates marker travels INSIDE the list. Verified 3 Aug 2026;
  // the bare-null form was the on-screen "an ICE candidate could not be
  // delivered" in the CEO's drill.
  assert.deepEqual(h.calls.candidates[1].c, [null], 'the sentinel is [null], always a list');
});

test('ICE sends are SERIALIZED, each carrying the etag the previous send rotated in', async () => {
  // Decart's If-Match rotates on every accepted PATCH. Concurrent sends would
  // all present the create-time etag and earn 412s for good candidates; a
  // chain that forgot to write the rotation back would do the same from the
  // second send on. Either break makes `seen` collapse to ['e1', 'e1', 'e1'].
  const seen = [];
  let inFlight = 0;
  let n = 1;
  const h = harness({
    sendCandidates: async (session) => {
      assert.equal(inFlight, 0, 'a send started while another was in flight');
      inFlight += 1;
      seen.push(session.etag);
      await new Promise((r) => setImmediate(r)); // hold the wire open a turn
      inFlight -= 1;
      n += 1;
      return { ok: true, etag: `e${n}` };
    },
  });
  await h.negotiator.start({});
  h.peer().fireCandidate({ candidate: 'c1' });
  h.peer().fireCandidate({ candidate: 'c2' });
  h.peer().fireCandidate(null);
  for (let i = 0; i < 8; i += 1) await drain();
  assert.deepEqual(seen, ['e1', 'e2', 'e3'], 'every send used the freshest etag');
});

test('a send that RESOLVES {ok:false} is reported and rotates nothing', async () => {
  // A resolved refusal must not be the one shape of failure that stays
  // silent — and its etag (if any) is poison: the vendor did not accept the
  // PATCH, so rotating onto it would 412 every send after.
  const seen = [];
  const h = harness({
    sendCandidates: async (session) => {
      seen.push(session.etag);
      return { ok: false, etag: 'e-poison' };
    },
  });
  await h.negotiator.start({});
  h.peer().fireCandidate({ candidate: 'c1' });
  h.peer().fireCandidate({ candidate: 'c2' });
  for (let i = 0; i < 4; i += 1) await drain();
  assert.deepEqual(
    h.calls.failures,
    ['an ICE candidate could not be delivered', 'an ICE candidate could not be delivered'],
    'each refused delivery is observable',
  );
  assert.deepEqual(seen, ['e1', 'e1'], "the refusal's etag never entered the chain");
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
      return { sessionId: 'sess-late', controlToken: 'c', vendor: { sdp: { type: 'answer', sdp: 'a' } } };
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
        : harness({ createSession: async () => { await gate; return { sessionId: 's', vendor: { sdp: { type: 'answer', sdp: 'a' } } }; } });
    const starting = h.negotiator.start({});
    await new Promise((r) => setImmediate(r));
    await h.negotiator.stop();
    release();
    await starting;
    assert.equal(h.negotiator.phase, NEGOTIATION.stopped, `stop reachable during ${phase}`);
    if (phase === 'creating') {
      // The half the title promises and the phase check alone cannot see:
      // by 'creating' the camera IS open, so a teardown that stopped calling
      // track.stop() would leave the light on with the test still green.
      assert.equal(h.track.stopped, true, 'the camera light goes out during creating too');
    }
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

test('a RESTART cannot revive the start it replaced — no second paid session', async () => {
  // The shared-flag bug: stop() cleared it, the next start() reset it, and the
  // abandoned start sailed past its checkpoints to create a SECOND vendor
  // session for a user who asked for one. Generation-scoped now.
  let releaseFirst;
  const firstGate = new Promise((r) => (releaseFirst = r));
  let calls = 0;
  const h = harness({
    getUserMedia: async () => {
      calls += 1;
      if (calls === 1) await firstGate; // the first start hangs on the prompt
      return { getTracks: () => [] };
    },
  });

  const first = h.negotiator.start({});
  await new Promise((r) => setImmediate(r));
  await h.negotiator.stop(); // user gives up
  const second = h.negotiator.start({}); // and immediately tries again
  await second;
  releaseFirst(); // the abandoned prompt finally resolves
  assert.equal(await first, null, 'the replaced start stays dead');

  assert.equal(
    h.negotiator.phase,
    NEGOTIATION.live,
    "the abandoned start must not clobber the live start's phase",
  );
  assert.ok(h.negotiator.session, 'and the live session survives its predecessor unwinding');
});

test('a candidate send that REJECTS is reported, never an unhandled rejection', async () => {
  const rejections = [];
  const onUnhandled = (e) => rejections.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const calls = { failures: [] };
    const negotiator = createVideoNegotiator({
      getUserMedia: async () => ({ getTracks: () => [] }),
      PeerConnection: function () {
        return fakePeer({ onCreated: (p) => (negotiator.__peer = p) });
      },
      createSession: async () => ({ sessionId: 's', vendor: { sdp: { type: 'answer', sdp: 'a' } } }),
      endSession: async () => ({ ok: true }),
      sendCandidates: async () => {
        throw new Error('worker unreachable');
      },
      onFailure: (r) => calls.failures.push(r),
    });
    await negotiator.start({});
    negotiator.__peer.fireCandidate({ candidate: 'c' });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(rejections, [], 'a failed send must not crash the page');
    assert.deepEqual(calls.failures, ['an ICE candidate could not be delivered']);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('the vendor error channel carries its message to onFailure INTACT', async () => {
  // Without this path the terminal duration-limit classifier had nothing to
  // classify: the negotiator only ever emitted its own connection-failed
  // string. A wall with no door.
  const h = harness();
  await h.negotiator.start({});
  h.negotiator.reportVendorError('Session duration limit reached');
  assert.deepEqual(h.calls.failures, ['Session duration limit reached']);

  h.negotiator.reportVendorError(new Error('moderation violation'));
  assert.equal(h.calls.failures.at(-1), 'moderation violation', 'Error objects unwrap too');
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
  const peer = h.peer();
  peer.fail();

  assert.deepEqual(h.calls.failures, ['the video connection failed']);
  // The second half of the title, which the failure list alone cannot check:
  // reporting is not deciding. A teardown here would yank the connection out
  // from under a caller that might want to retry, and the test would have
  // passed regardless.
  assert.equal(peer.closed, false, 'the peer connection is left for the caller to decide about');
  assert.equal(h.track.stopped, false, 'and the camera stays open');
  assert.equal(h.negotiator.phase, NEGOTIATION.live, 'phase is unchanged by a report');
  assert.equal(h.calls.ends.length, 0, 'nothing is settled behind the caller');
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

test('the reference avatar and prompt ride the create call untouched', async () => {
  let seen = null;
  const h = harness({
    createSession: async (args) => {
      seen = args;
      return {
        sessionId: 'sess-1',
        controlToken: 'c',
        vendor: { sdp: { type: 'answer', sdp: 'v=0 answer' }, etag: 'e1' },
      };
    },
  });
  await h.negotiator.start({ imageData: 'data:image/png;base64,aGk=', prompt: 'blue cloth' });
  assert.equal(seen.imageData, 'data:image/png;base64,aGk=', 'the identity reaches the Worker');
  assert.equal(seen.prompt, 'blue cloth');
});

// ─── the vendor's RETURN path (P2e): SSE candidates and errors ─────────────

function fakeEventSource() {
  const listeners = {};
  const source = {
    url: null,
    closed: false,
    addEventListener: (type, fn) => (listeners[type] = fn),
    close: () => (source.closed = true),
    fire: (type, data) => listeners[type]?.(data === undefined ? {} : { data }),
  };
  return source;
}

const SESSION_WITH_EVENTS = () => ({
  sessionId: 'sess-1',
  controlToken: 'c',
  vendor: {
    sdp: { type: 'answer', sdp: 'v=0 answer' },
    etag: 'e1',
    events: {
      url: 'https://api.decart.ai/v1/realtime/sessions/sess-1/events',
      event_token: 'evt-tok',
      expires_at: '2026-08-03T13:00:00Z',
    },
  },
});

test("the vendor's SSE candidates reach the peer connection — the missing half of ICE", async () => {
  let source = null;
  const h = harness({
    createSession: async () => SESSION_WITH_EVENTS(),
    EventSourceFactory: (url) => {
      source = fakeEventSource();
      source.url = url;
      return source;
    },
  });
  await h.negotiator.start({});

  assert.ok(source, 'the event stream opens with the session');
  assert.match(source.url, /event_token=evt-tok/, "authenticated with the vendor's own token");

  source.fire('ice-candidate', JSON.stringify({ candidate: 'v-cand', sdpMLineIndex: 0, sdpMid: '0' }));
  source.fire('ice-candidate', 'null'); // the vendor's own end-of-candidates
  await drain();

  assert.equal(h.peer().remoteCandidates.length, 2);
  assert.equal(h.peer().remoteCandidates[0].candidate, 'v-cand');
  assert.equal(h.peer().remoteCandidates[1], undefined, 'null becomes the DOM end-of-candidates call');
});

test('vendor candidates that arrive BEFORE the answer is applied are queued, then flushed', async () => {
  // addIceCandidate throws without a remote description, and SSE has no
  // replay — the same NAT lesson as the outbound side, mirrored.
  let source = null;
  let releaseAnswer;
  const answerGate = new Promise((r) => (releaseAnswer = r));
  // The gate is installed INSIDE the create call — the only moment that is
  // guaranteed to be after the peer exists and before the answer is applied.
  const h = harness({
    createSession: async () => {
      const peer = h.peer();
      const realSetRemote = peer.setRemoteDescription;
      peer.setRemoteDescription = async (d) => {
        await answerGate;
        return realSetRemote(d);
      };
      return SESSION_WITH_EVENTS();
    },
    EventSourceFactory: () => (source = fakeEventSource()),
  });

  const starting = h.negotiator.start({});
  await drain();
  assert.ok(source, 'stream open while the answer is still pending');
  source.fire('ice-candidate', JSON.stringify({ candidate: 'early-vendor', sdpMLineIndex: 0, sdpMid: '0' }));
  await drain();
  assert.equal(h.peer().remoteCandidates.length, 0, 'nothing lands before the remote description');

  releaseAnswer();
  await starting;
  await drain();
  assert.equal(h.peer().remoteCandidates.length, 1, 'the queued candidate landed after the answer');
  assert.equal(h.peer().remoteCandidates[0].candidate, 'early-vendor');
});

test("the vendor's SSE error event feeds onFailure with its message INTACT", async () => {
  let source = null;
  const h = harness({
    createSession: async () => SESSION_WITH_EVENTS(),
    EventSourceFactory: () => (source = fakeEventSource()),
  });
  await h.negotiator.start({});
  source.fire(
    'error',
    JSON.stringify({ type: 'x', title: 'Session ended', detail: 'Session duration limit reached', status: 200 }),
  );
  assert.deepEqual(
    h.calls.failures,
    ['Session duration limit reached'],
    "the classifier hears the vendor's own words — the wall's door, now with a caller",
  );
});

test("a TRANSPORT error (no data) is not the vendor speaking — no failure is invented", async () => {
  let source = null;
  const h = harness({
    createSession: async () => SESSION_WITH_EVENTS(),
    EventSourceFactory: () => (source = fakeEventSource()),
  });
  await h.negotiator.start({});
  source.fire('error'); // EventSource's own connection hiccup: no data
  assert.deepEqual(h.calls.failures, [], 'a reconnecting stream is not a vendor error');
});

test('stop() closes the event stream with everything else', async () => {
  let source = null;
  const h = harness({
    createSession: async () => SESSION_WITH_EVENTS(),
    EventSourceFactory: () => (source = fakeEventSource()),
  });
  await h.negotiator.start({});
  assert.equal(source.closed, false);
  await h.negotiator.stop();
  assert.equal(source.closed, true, 'no listener outlives the session it listened to');
});
