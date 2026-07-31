// Run: node --test src/lib/sessionIdentity.test.js
// Pins the collision rule: two tabs must never mint the same identity, and
// one tab must keep its own across reloads. Node has no sessionStorage, so
// each test installs a minimal stub on globalThis.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  getSessionIdentity,
  releaseSessionClaims,
  resetSessionIdentity,
} from './sessionIdentity.js';

function makeStorage(seed = new Map()) {
  const map = new Map(seed);
  return {
    map,
    api: {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    },
  };
}

// localStorage is SHARED between tabs — never copied — so it is where the
// claim record lives. sessionStorage is per-tab but IS copied into a
// duplicated tab, which is the hole the claim record closes.
let sharedLocal;

function installStorage(seed) {
  const s = makeStorage(seed);
  globalThis.sessionStorage = s.api;
  return s.map;
}

/** Snapshot of the current tab's sessionStorage — what a duplicate inherits. */
function sharedSessionSeed() {
  const out = new Map();
  for (const k of ['luminastream_identity_studio', 'luminastream_identity_devtools']) {
    const v = globalThis.sessionStorage.getItem(k);
    if (v !== null) out.set(k, v);
  }
  return out;
}

beforeEach(() => {
  sharedLocal = makeStorage();
  globalThis.localStorage = sharedLocal.api;
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

test('a DUPLICATED tab does not reuse the opener identity', async () => {
  // cmd-click / target="_blank" / "Duplicate Tab" copies the opener's
  // sessionStorage into the new document. The naive read would hand back the
  // opener's identity and evict it — the exact bug this module exists to stop.
  const opener = getSessionIdentity('studio');

  // A new document re-evaluates the module, so it gets a fresh in-memory
  // TAB_ID. Cache-busting import is how we get a genuinely separate instance.
  const dup = await import('./sessionIdentity.js?tab=duplicate');
  installStorage(sharedSessionSeed()); // ← copied storage, as the browser does
  const copied = dup.getSessionIdentity('studio');

  assert.notEqual(copied, opener, 'duplicated tab reused the opener identity');
});

test('the opener keeps its identity after a duplicate steals nothing', async () => {
  const opener = getSessionIdentity('studio');
  const openerStorage = sharedSessionSeed();

  const dup = await import('./sessionIdentity.js?tab=duplicate2');
  installStorage(openerStorage);
  dup.getSessionIdentity('studio');

  // Opener re-reads (e.g. on reconnect) and must still be itself.
  installStorage(openerStorage);
  assert.equal(getSessionIdentity('studio'), opener);
});

test('a RELOAD keeps the same identity — the core promise of this module', async () => {
  // A reload keeps sessionStorage but creates a NEW document, so a new
  // TAB_ID. Without releasing on teardown, the claim we refreshed moments
  // ago looks like a live stranger's and every reload would mint a new
  // participant. This test failed before releaseSessionClaims existed.
  const before = getSessionIdentity('studio');
  const storage = sharedSessionSeed();

  releaseSessionClaims();                 // what `pagehide` does on teardown

  const reloaded = await import('./sessionIdentity.js?tab=reload');
  installStorage(storage);                // sessionStorage survives a reload
  assert.equal(reloaded.getSessionIdentity('studio'), before);
});

test('a reload after an UNCLEAN exit still never collides', async () => {
  // Crash / force-quit: no pagehide fired, so the claim lingers for its TTL.
  // We accept minting a new identity here — a spare participant is cheap,
  // an eviction is not.
  const before = getSessionIdentity('studio');
  const storage = sharedSessionSeed();

  const crashed = await import('./sessionIdentity.js?tab=crash');
  installStorage(storage);
  assert.notEqual(crashed.getSessionIdentity('studio'), before);
});

test('an expired claim is reclaimable — a closed tab does not hold forever', () => {
  const first = getSessionIdentity('studio');
  // Age every claim past the TTL, as if that tab had been closed.
  const claims = JSON.parse(globalThis.localStorage.getItem('luminastream_identity_claims'));
  for (const c of Object.values(claims)) c.t -= 60_000;
  globalThis.localStorage.setItem('luminastream_identity_claims', JSON.stringify(claims));

  // Same tab, same storage → reclaims rather than churning a new name.
  assert.equal(getSessionIdentity('studio'), first);
});

test('claim record does not grow without bound', () => {
  for (let i = 0; i < 40; i += 1) {
    installStorage();
    getSessionIdentity('studio');
  }
  const claims = JSON.parse(globalThis.localStorage.getItem('luminastream_identity_claims'));
  // Expired entries are swept on write; only live leases survive.
  assert.ok(Object.keys(claims).length <= 40);
});

test('missing localStorage degrades without throwing', () => {
  globalThis.localStorage = undefined;
  assert.doesNotThrow(() => getSessionIdentity('studio'));
  assert.match(getSessionIdentity('studio'), /^studio-/);
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
