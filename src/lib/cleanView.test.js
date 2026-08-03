// Run: node --test src/lib/cleanView.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldToggleCleanView } from './cleanView.js';

const key = (overrides = {}) => ({ key: 'h', repeat: false, target: { tagName: 'BODY' }, ...overrides });

test('H toggles, either case', () => {
  assert.equal(shouldToggleCleanView(key()), true);
  assert.equal(shouldToggleCleanView(key({ key: 'H' })), true);
});

test('typing an h into a field is TYPING, never a toggle', () => {
  // The live-prompt field exists on the same page — "change cloth" contains
  // an h, and each one blanking the screen would make the prompt unusable.
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    assert.equal(shouldToggleCleanView(key({ target: { tagName } })), false, tagName);
  }
  assert.equal(
    shouldToggleCleanView(key({ target: { tagName: 'DIV', isContentEditable: true } })),
    false,
    'contentEditable is a text field too',
  );
});

test('chords belong to the OS, a held key must not strobe, other keys do nothing', () => {
  assert.equal(shouldToggleCleanView(key({ metaKey: true })), false, 'Cmd+H hides the window');
  assert.equal(shouldToggleCleanView(key({ ctrlKey: true })), false);
  assert.equal(shouldToggleCleanView(key({ altKey: true })), false);
  assert.equal(shouldToggleCleanView(key({ repeat: true })), false, 'auto-repeat is one press');
  assert.equal(shouldToggleCleanView(key({ key: 'j' })), false);
  assert.equal(shouldToggleCleanView(null), false);
});
