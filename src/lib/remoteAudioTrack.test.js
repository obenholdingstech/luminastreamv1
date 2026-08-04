// Run: node --test src/lib/remoteAudioTrack.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { findLiveRemoteAudioTrack } from './remoteAudioTrack.js';

const participant = (...tracks) => ({
  audioTrackPublications: new Map(
    tracks.map((t, i) => [`pub-${i}`, { track: t ? { mediaStreamTrack: t } : null }]),
  ),
});
const room = (...ps) => new Map(ps.map((p, i) => [`p-${i}`, p]));

test('picks the first LIVE track across participants', () => {
  const live = { readyState: 'live', id: 'agent-voice' };
  const found = findLiveRemoteAudioTrack(
    room(participant(null), participant({ readyState: 'ended' }, live)),
  );
  assert.equal(found, live);
});

test('an ended track is not a voice — null when nothing lives', () => {
  assert.equal(findLiveRemoteAudioTrack(room(participant({ readyState: 'ended' }))), null);
});

test('empty rooms, missing maps, and null input all answer null, never throw', () => {
  assert.equal(findLiveRemoteAudioTrack(room()), null);
  assert.equal(findLiveRemoteAudioTrack(room({})), null);
  assert.equal(findLiveRemoteAudioTrack(null), null);
  assert.equal(findLiveRemoteAudioTrack(undefined), null);
});

test('an unsubscribed publication (no track object) is skipped, not crashed on', () => {
  const live = { readyState: 'live' };
  assert.equal(findLiveRemoteAudioTrack(room(participant(null, live))), live);
});
