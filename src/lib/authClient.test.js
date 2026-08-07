// Run: node --test src/lib/authClient.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { authMessage, createAuthClient } from './authClient.js';

function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { status: 200, body: { ok: true } };
    if (r.reject) throw new Error('network down');
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    };
  };
  return { impl, calls };
}

test('every call carries credentials — the cookie is the session, the browser must attach it', async () => {
  const { impl, calls } = fakeFetch([
    { status: 200, body: { ok: true, user: { id: 'u1' } } },
    { status: 200, body: { ok: true } },
  ]);
  const client = createAuthClient({ apiBase: 'https://api.example', fetchImpl: impl });
  await client.me();
  await client.saveProfile({ voiceId: 'v1' });
  for (const c of calls) assert.equal(c.init.credentials, 'include');
  assert.equal(calls[0].url, 'https://api.example/api/auth/me');
  assert.equal(calls[1].init.method, 'PUT');
});

test('server error tokens map to one human sentence; unknown tokens still say something', async () => {
  const { impl } = fakeFetch([
    { status: 401, body: { ok: false, error: 'invalid_credentials' } },
  ]);
  const client = createAuthClient({ apiBase: '', fetchImpl: impl });
  const res = await client.signIn({ email: 'a@b.co', password: 'x'.repeat(12) });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_credentials');
  assert.equal(res.message, 'Wrong email or password.');
  assert.equal(authMessage('never_heard_of_it'), 'Something went wrong — try again.');
  assert.equal(authMessage('unauthenticated'), null, 'silent token — the UI shows the form, not an error');
});

test('signUp forwards the turnstile token; resend reports only server-confirmed success', async () => {
  const { impl, calls } = fakeFetch([
    { status: 200, body: { ok: true, user: { id: 'u1' } } },
    { status: 503, body: { ok: false, error: 'email_send_failed' } },
  ]);
  const client = createAuthClient({ apiBase: '', fetchImpl: impl });
  await client.signUp({ email: 'a@b.co', password: 'x'.repeat(12), turnstileToken: 'ts-token' });
  assert.equal(JSON.parse(calls[0].init.body).turnstileToken, 'ts-token');
  const resend = await client.resendVerification();
  assert.equal(resend.ok, false, 'a 503 is NOT "sent — check your inbox"');
  assert.equal(resend.error, 'email_send_failed');
});

test('a network failure resolves to a result, never a throw', async () => {
  const { impl } = fakeFetch([{ reject: true }]);
  const client = createAuthClient({ apiBase: '', fetchImpl: impl });
  const res = await client.signUp({ email: 'a@b.co', password: 'x'.repeat(12) });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'network');
  assert.match(res.message, /connection/);
});

test('a 200 with a non-ok body is still a failure — the envelope is the truth', async () => {
  const { impl } = fakeFetch([{ status: 200, body: { ok: false, error: 'email_in_use' } }]);
  const client = createAuthClient({ apiBase: '', fetchImpl: impl });
  const res = await client.signUp({ email: 'a@b.co', password: 'x'.repeat(12) });
  assert.equal(res.ok, false);
  assert.match(res.message, /already has an account/);
});
