import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeApiBase, API_BASE } from './apiBase.js';

test('unset env (undefined) yields empty base — same-origin legacy behavior', () => {
  assert.equal(normalizeApiBase(undefined), '');
});

test('non-string garbage yields empty base', () => {
  for (const garbage of [null, 42, {}, [], true]) {
    assert.equal(normalizeApiBase(garbage), '');
  }
});

test('trailing slashes stripped so consumers can join with /api', () => {
  assert.equal(normalizeApiBase('https://api.example.com/'), 'https://api.example.com');
  assert.equal(normalizeApiBase('https://api.example.com///'), 'https://api.example.com');
});

test('clean URL passes through untouched', () => {
  assert.equal(normalizeApiBase('https://api.example.com'), 'https://api.example.com');
});

test('surrounding whitespace trimmed (dashboard copy-paste)', () => {
  assert.equal(normalizeApiBase('  https://api.example.com/ '), 'https://api.example.com');
});

test('outside Vite (node) the module-level API_BASE defaults to empty', () => {
  assert.equal(API_BASE, '');
});
