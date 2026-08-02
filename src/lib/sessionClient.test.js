// Run: node --test src/lib/sessionClient.test.js
//
// The session client, driven against a stubbed fetch. What is worth testing
// here is not "does it POST" but the two things that decide whether a person
// has a working product: does a refusal say something true and actionable, and
// does the slot actually get given back.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSession,
  endSession,
  releaseOnUnload,
  openSession,
} from './sessionClient.js';

const BASE = 'https://api.example';
const original = globalThis.fetch;

function stub(handler) {
  globalThis.fetch = handler;
}
test.afterEach(() => {
  globalThis.fetch = original;
});

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const GRANT = {
  ok: true,
  sessionId: 'sess-1',
  endToken: 'end-tok',
  room: 'luminastream-test',
  identity: 'speaker-abcd1234',
  token: 'a.b.c',
  url: 'wss://proj.livekit.cloud',
  expiresAt: 1_800_000_000,
};

// ─── create ────────────────────────────────────────────────────────────────

test('createSession sends the admin token and returns the server-chosen room', async () => {
  stub(async (url, opts) => {
    assert.equal(url, `${BASE}/api/session/create`);
    assert.equal(opts.method, 'POST');
    assert.equal(opts.headers['X-Admin-Token'], 'sess.tok');
    return jsonResponse(200, GRANT);
  });

  const session = await createSession('sess.tok', BASE);
  // The room and identity come from the SERVER. The lens no longer picks
  // either, which is the whole point of the session layer.
  assert.equal(session.room, 'luminastream-test');
  assert.equal(session.identity, 'speaker-abcd1234');
  assert.equal(session.sessionId, 'sess-1');
  assert.equal(session.endToken, 'end-tok');
  assert.equal(session.token, 'a.b.c');
  assert.equal(session.url, 'wss://proj.livekit.cloud');
});

test('a busy lens is reported as busy, and says retrying is worthwhile', async () => {
  stub(async () => jsonResponse(503, { ok: false, error: 'at_capacity', live: 1, capacity: 1 }));
  await assert.rejects(() => createSession('t', BASE), (err) => {
    assert.match(err.message, /busy/);
    assert.match(err.message, /try again/);
    assert.equal(err.code, 'at_capacity');
    assert.equal(err.status, 503);
    return true;
  });
});

test('a deployment with no agents does NOT tell the user to try again', async () => {
  // Both are 503. Telling someone to retry a permanent condition costs them an
  // afternoon, so the two must not collapse into one message.
  stub(async () => jsonResponse(503, { ok: false, error: 'sessions_disabled' }));
  await assert.rejects(() => createSession('t', BASE), (err) => {
    assert.equal(err.code, 'sessions_disabled');
    assert.doesNotMatch(err.message, /try again|retry/i);
    return true;
  });
});

test('every named refusal gets a SENTENCE, not the raw error code', async () => {
  // "Distinct" is not enough, and asserting only that was a real gap here:
  // dropping a branch still produced a distinct message — the bare code
  // `sessions_disabled` — which passes a difference check and shows a person a
  // machine token. Found by mutating the branch away and watching nothing go
  // red. Each message must be prose, and prose that does not just echo the code.
  const seen = new Map();
  for (const code of ['at_capacity', 'sessions_disabled', 'session_registry_unavailable']) {
    stub(async () => jsonResponse(503, { ok: false, error: code }));
    await createSession('t', BASE).catch((err) => seen.set(code, err.message));
  }

  assert.equal(seen.size, 3);
  for (const [code, message] of seen) {
    assert.ok(!message.includes(code), `${code} leaked its raw code into the message`);
    assert.ok(message.includes(' '), `${code} produced a token, not a sentence`);
    assert.match(message, /[a-z]{3,} [a-z]{2,}/i, `${code} does not read as English`);
  }
  assert.equal(new Set(seen.values()).size, 3, 'three causes, three messages');
});

test('createSession surfaces 401 with .status so the caller can re-verify', async () => {
  stub(async () => jsonResponse(401, { ok: false, error: 'unauthorized' }));
  await assert.rejects(() => createSession('stale', BASE), (err) => {
    assert.equal(err.status, 401);
    return true;
  });
});

test('a registry outage is named as one, not as a mystery', async () => {
  stub(async () => jsonResponse(503, { ok: false, error: 'session_registry_unavailable' }));
  await assert.rejects(() => createSession('t', BASE), /session service is unavailable/);
});

test('createSession without a base throws (VITE_API_BASE unset)', async () => {
  await assert.rejects(() => createSession('t', ''), /not configured/);
});

test('a 200 without a token is a refusal, not a session', async () => {
  // An SPA shell answering 200 with HTML, or a partial body, must not be
  // mistaken for a grant — the lens would then try to join with `undefined`.
  stub(async () => jsonResponse(200, { ok: true }));
  await assert.rejects(() => createSession('t', BASE));
});

// ─── release ───────────────────────────────────────────────────────────────

test('endSession posts the session id and the end token', async () => {
  let seen = null;
  stub(async (url, opts) => {
    seen = { url, body: JSON.parse(opts.body), header: opts.headers['X-Admin-Token'] };
    return jsonResponse(200, { ok: true, ended: true });
  });

  assert.equal(
    await endSession('sess.tok', { sessionId: 'sess-1', endToken: 'end-tok' }, BASE),
    true,
  );
  assert.equal(seen.url, `${BASE}/api/session/end`);
  assert.deepEqual(seen.body, { sessionId: 'sess-1', endToken: 'end-tok' });
  assert.equal(seen.header, 'sess.tok');
});

test('endSession NEVER throws — a failed release must not become an error message', async () => {
  // It runs on a Stop click and again on unload. The lease reaps the slot
  // anyway, so the only thing an exception could achieve is alarming someone
  // about something they already finished doing.
  stub(async () => {
    throw new Error('network down');
  });
  assert.equal(await endSession('t', { sessionId: 's', endToken: 'e' }, BASE), false);

  stub(async () => jsonResponse(403, { ok: false, error: 'end_refused' }));
  assert.equal(await endSession('t', { sessionId: 's', endToken: 'e' }, BASE), false);
});

test('endSession does not fire a request when there is nothing to release', async () => {
  let called = 0;
  stub(async () => {
    called += 1;
    return jsonResponse(200, { ok: true });
  });
  assert.equal(await endSession('t', { sessionId: '', endToken: '' }, BASE), false);
  assert.equal(await endSession('t', undefined, BASE), false);
  assert.equal(called, 0, 'a release with no session must not reach the network');
});

test('releaseOnUnload uses keepalive so the request outlives the page', async () => {
  let opts = null;
  stub(async (_url, o) => {
    opts = o;
    return jsonResponse(200, { ok: true, ended: true });
  });

  await releaseOnUnload('t', { sessionId: 's', endToken: 'e' }, BASE);
  assert.equal(opts.keepalive, true, 'without keepalive the unload cancels the release');
  // sendBeacon cannot set headers, which is exactly why this is a fetch.
  assert.equal(opts.headers['X-Admin-Token'], 't');
  assert.equal(opts.signal, undefined, 'no deadline on an unload request');
});

// ─── the full flow ─────────────────────────────────────────────────────────

test('openSession verifies with the password when there is no admin session', async () => {
  const calls = [];
  stub(async (url) => {
    calls.push(url);
    if (url.endsWith('/api/admin/verify')) return jsonResponse(200, { ok: true, token: 'fresh' });
    return jsonResponse(200, GRANT);
  });

  const session = await openSession({ password: 'pw' }, BASE);
  assert.deepEqual(calls, [`${BASE}/api/admin/verify`, `${BASE}/api/session/create`]);
  assert.equal(session.adminToken, 'fresh');
  assert.equal(session.room, 'luminastream-test');
});

test('openSession reuses an existing admin session without re-verifying', async () => {
  const calls = [];
  stub(async (url) => {
    calls.push(url);
    return jsonResponse(200, GRANT);
  });

  await openSession({ adminToken: 'still-good' }, BASE);
  assert.deepEqual(calls, [`${BASE}/api/session/create`], 'no password round trip when not needed');
});

test('openSession re-verifies ONCE on a 401 and retries', async () => {
  const calls = [];
  let created = 0;
  stub(async (url) => {
    calls.push(url);
    if (url.endsWith('/api/admin/verify')) return jsonResponse(200, { ok: true, token: 'fresh' });
    created += 1;
    if (created === 1) return jsonResponse(401, { ok: false, error: 'unauthorized' });
    return jsonResponse(200, GRANT);
  });

  const session = await openSession({ password: 'pw', adminToken: 'expired' }, BASE);
  assert.equal(session.adminToken, 'fresh');
  assert.deepEqual(calls, [
    `${BASE}/api/session/create`,
    `${BASE}/api/admin/verify`,
    `${BASE}/api/session/create`,
  ]);
});

test('openSession does NOT retry a busy lens', async () => {
  // Retrying at_capacity on the user's behalf hammers a full registry and
  // still fails. The 401 retry exists because the credential is stale; a full
  // registry is not stale, it is full.
  let creates = 0;
  stub(async (url) => {
    if (url.endsWith('/api/admin/verify')) return jsonResponse(200, { ok: true, token: 'fresh' });
    creates += 1;
    return jsonResponse(503, { ok: false, error: 'at_capacity' });
  });

  await assert.rejects(() => openSession({ password: 'pw', adminToken: 'good' }, BASE), /busy/);
  assert.equal(creates, 1, 'exactly one attempt');
});

test('openSession gives up after one re-verify rather than looping', async () => {
  let creates = 0;
  stub(async (url) => {
    if (url.endsWith('/api/admin/verify')) return jsonResponse(200, { ok: true, token: 'fresh' });
    creates += 1;
    return jsonResponse(401, { ok: false, error: 'unauthorized' });
  });

  await assert.rejects(() => openSession({ password: 'pw', adminToken: 'expired' }, BASE));
  assert.equal(creates, 2, 'one attempt, one retry, then stop');
});

test('a busy lens does not cost the user their access key', async () => {
  // The password was already exchanged successfully. Making someone retype it
  // because the lens happened to be full is a punishment for someone else's
  // timing — and on a one-agent system, that is the common case.
  stub(async (url) => {
    if (url.endsWith('/api/admin/verify')) return jsonResponse(200, { ok: true, token: 'fresh' });
    return jsonResponse(503, { ok: false, error: 'at_capacity' });
  });

  await assert.rejects(() => openSession({ password: 'pw' }, BASE), (err) => {
    assert.equal(err.code, 'at_capacity');
    assert.equal(err.adminToken, 'fresh', 'the verified session must survive the refusal');
    return true;
  });
});

test('an auth failure does NOT hand back a session token', async () => {
  // The opposite case: a 401 means the token is the thing that is wrong, so
  // returning it would have the caller keep exactly what just failed.
  stub(async (url) => {
    if (url.endsWith('/api/admin/verify')) return jsonResponse(200, { ok: true, token: 'fresh' });
    return jsonResponse(401, { ok: false, error: 'unauthorized' });
  });

  await assert.rejects(() => openSession({ adminToken: 'expired' }, BASE), (err) => {
    assert.equal(err.status, 401);
    assert.equal(err.adminToken, undefined);
    return true;
  });
});
