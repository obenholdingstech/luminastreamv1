// Run: node --test src/lib/sessionIdentity.test.js
// Pins the collision rule: two tabs must never mint the same identity, and
// one tab must keep its own across reloads. Node has no sessionStorage, so
// each test installs a minimal stub on globalThis.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { getSessionIdentity, resetSessionIdentity } from './sessionIdentity.js';

function installStorage() {
  const map = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
  return map;
}

beforeEach(() => {
  installStorage();
});

test('same tab is stable across calls — a reload reclaims its own slot', () => {
  const first = getSessionIdentity('studio');
  const second = getSessionIdentity('studio');
  assert.equal(first, second);
});

test('a second tab gets a different identity — this is the whole bug', () => {
  const tabA = getSessionIdentity('studio');
  installStorage(); // a fresh tab starts with empty sessionStorage
  const tabB = getSessionIdentity('studio');
  assert.notEqual(tabA, tabB);
});

test('never returns the old hardcoded literal', () => {
  // The regression under test: mintIdentity used to be useState('test-user'),
  // so every participant collided and LiveKit evicted the incumbent.
  assert.notEqual(getSessionIdentity('studio'), 'test-user');
});

test('prefix is preserved and namespaced separately', () => {
  const studio = getSessionIdentity('studio');
  const devtools = getSessionIdentity('devtools');
  assert.match(studio, /^studio-/);
  assert.match(devtools, /^devtools-/);
  // Different surfaces in the same tab must not share a slot, or opening the
  // console next to the studio would evict the studio.
  assert.notEqual(studio, devtools);
});

test('identity is URL-safe and short enough for the 512-char Worker cap', () => {
  const id = getSessionIdentity('studio');
  assert.match(id, /^[a-z0-9-]+$/);
  assert.ok(id.length < 64, `unexpectedly long: ${id.length}`);
});

test('reset mints a fresh identity', () => {
  const before = getSessionIdentity('studio');
  resetSessionIdentity('studio');
  assert.notEqual(getSessionIdentity('studio'), before);
});

test('survives sessionStorage being unavailable, and still never collides', () => {
  // Safari private mode / embedded webviews throw on access.
  globalThis.sessionStorage = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); },
  };
  const a = getSessionIdentity('studio');
  const b = getSessionIdentity('studio');
  assert.match(a, /^studio-/);
  // Not stable without storage — acceptable and documented. What must hold is
  // that it degrades to "new participant", never to "everyone is test-user".
  assert.notEqual(a, b);
  assert.doesNotThrow(() => resetSessionIdentity('studio'));
});

test('collision resistance across many mints', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) {
    installStorage();
    seen.add(getSessionIdentity('studio'));
  }
  assert.equal(seen.size, 500);
});
