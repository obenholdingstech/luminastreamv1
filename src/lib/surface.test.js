// Run: node --test src/lib/surface.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { surfaceForHost } from './surface.js';

test('the routing map: apex is public, account is auth, everything else works', () => {
  assert.equal(surfaceForHost('luminastream.live'), 'landing');
  assert.equal(surfaceForHost('www.luminastream.live'), 'landing');
  assert.equal(surfaceForHost('account.luminastream.live'), 'account');
  assert.equal(surfaceForHost('admin.luminastream.live'), 'admin');
  assert.equal(surfaceForHost('ADMIN.LUMINASTREAM.LIVE'), 'admin', 'admin is case-insensitive too');
  assert.equal(surfaceForHost('studio.luminastream.live'), 'studio');
  assert.equal(surfaceForHost('LUMINASTREAM.LIVE'), 'landing', 'hostnames are case-insensitive');
  // Previews and dev keep the working surface — probes live there.
  assert.equal(surfaceForHost('abc.luminastream-studio.pages.dev'), 'studio');
  assert.equal(surfaceForHost('localhost'), 'studio');
  assert.equal(surfaceForHost(undefined), 'studio', 'a missing hostname breaks nothing');
});
