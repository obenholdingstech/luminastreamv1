// Which remote audio track is the agent's voice? A selection policy, not a
// subscription — extracted from Studio.jsx (the lifecycle-in-component
// doctrine, 5th occurrence) so the rule can be tested against fake rooms.
//
// The rule: the first LIVE audio track any remote participant publishes.
// Today the room holds exactly one agent; if that ever changes, this is the
// single place the choice gets smarter.

/**
 * @param {Map<any, any>|null|undefined} participants room.remoteParticipants
 * @returns {any} a live MediaStreamTrack, or null
 */
export function findLiveRemoteAudioTrack(participants) {
  for (const participant of participants?.values?.() ?? []) {
    for (const publication of participant.audioTrackPublications?.values?.() ?? []) {
      const track = publication.track?.mediaStreamTrack;
      if (track && track.readyState === 'live') return track;
    }
  }
  return null;
}
