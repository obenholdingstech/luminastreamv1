// Run: node --test src/lib/adminGate.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { adminGate } from './adminGate.js';
import { SURFACE_URLS } from './surface.js';

test('checking renders nothing and goes nowhere — no flash, no premature redirect', () => {
  assert.deepEqual(adminGate({ status: 'checking' }), { verdict: 'pending' });
  assert.deepEqual(
    adminGate({ status: 'checking', user: { role: 'admin' } }),
    { verdict: 'pending' },
    'a stale user object during the probe grants nothing',
  );
});

test('only a signed-in admin is allowed', () => {
  assert.deepEqual(adminGate({ status: 'signedIn', user: { role: 'admin' } }), {
    verdict: 'allow',
  });
});

test('everyone else is walked back to the public web', () => {
  const redirect = { verdict: 'redirect', to: SURFACE_URLS.landing };
  assert.deepEqual(adminGate({ status: 'signedOut' }), redirect, 'signed out');
  assert.deepEqual(
    adminGate({ status: 'signedIn', user: { role: 'user' } }),
    redirect,
    'an ordinary signed-in user',
  );
  assert.deepEqual(
    adminGate({ status: 'signedIn', user: null }),
    redirect,
    'signed in with no user object — fail closed',
  );
  assert.deepEqual(adminGate({ status: 'signedIn' }), redirect, 'no user field at all');
  assert.deepEqual(adminGate(undefined), redirect, 'no auth at all — fail closed');
});
