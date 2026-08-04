// The unified lens (CEO mandate, 3 Aug 2026): ONE button starts the combined
// audio+video reality. This module holds the one decision that has rules —
// when the video leg auto-starts alongside a fresh audio session — because
// the failure modes are lifecycle races: double-starting video for one
// session (double the vendor bill), restarting it after the user explicitly
// stopped it, or reviving it on a reconnect that isn't a new session.
//
// The rule: video auto-starts EXACTLY ONCE per audio session, when the
// session is connected and an admin token exists — and never while video is
// already doing anything. A video failure never blocks the voice: the lens
// degrades to audio with a visible reason (videoClient's prose).

export function createAutoStartLatch() {
  let firedFor = null; // the session identity video was started for

  return {
    /**
     * Should the video leg start NOW? Latches on yes.
     * @param {{ sessionId: string|null|undefined, connected: boolean, adminToken: string|null|undefined, videoPhase: string }} state
     */
    shouldStart({ sessionId, connected, adminToken, videoPhase }) {
      if (!sessionId || !connected || !adminToken) return false;
      if (firedFor === sessionId) return false; // once per session, ever
      if (videoPhase !== 'off') return false; // starting/live/stopping/error — leave it be
      firedFor = sessionId;
      return true;
    },

    // There is deliberately NO reset(). Session identities are unique
    // (server-allocated per claim), so a new session re-arms the latch by
    // being new — and a manual reset is exactly the hazard: called during a
    // stop, it re-armed the latch for a session identity still visible
    // mid-teardown, one render away from a second paid vendor session.
  };
}

// The pre-start voice choice (CEO directive, 3 Aug evening): the user picks
// a voice BEFORE the lens starts, and the choice keys in the moment the
// agent is there to hear it. Same shape of problem as the video auto-start
// — apply exactly once per session, never fight the agent's confirmed state,
// never re-fire on a re-render — so it gets the same latch treatment.
export function createVoicePreference() {
  let appliedFor = null;

  return {
    /**
     * Should the chosen voice be requested NOW? Latches on yes.
     * @param {{ sessionId: string|null|undefined, connected: boolean, chosen: string|null|undefined, confirmedVoice: string|null|undefined }} state
     */
    shouldApply({ sessionId, connected, chosen, confirmedVoice }) {
      if (!sessionId || !connected || !chosen) return false;
      if (appliedFor === sessionId) return false; // once per session
      // The agent has not spoken yet — wait for its broadcast, or the
      // request would race the agent's own startup voice resolution.
      if (!confirmedVoice) return false;
      if (chosen === confirmedVoice) {
        appliedFor = sessionId; // already true; nothing to send, ever
        return false;
      }
      appliedFor = sessionId;
      return true;
    },

    // No reset(), for the same reason as the auto-start latch above.
  };
}

// The crossfade's one decision (4 Aug 2026): which backdrop layer shows.
// The hazard is ORDERING — `ontrack` (stream exists) and NEGOTIATION.live
// (cinematic) arrive in either order, and neither means a frame has actually
// been DECODED. Keying visibility on stream assignment mounts the
// transformed layer at full opacity with nothing to fade from, or fades the
// camera preview into a black rectangle. So the preview holds the stage
// until the transformed element reports a decoded frame (`transformedReady`,
// fed by loadeddata), whatever order everything else arrived in.
export function crossfadeState({ streamPresent, transformedReady, cinematic }) {
  const handoff = Boolean(streamPresent && transformedReady);
  return {
    // The camera preview yields only to actual pixels — never to a promise.
    preview: handoff ? 'hidden' : 'visible',
    // hidden → ambient (behind the ring, pre-cinematic) → full (the stage).
    transformed: !handoff ? 'hidden' : cinematic ? 'full' : 'ambient',
  };
}

// The reaper's question (4 Aug 2026): is this video leg an orphan? The video
// leg only ever exists inside a held audio session, so once the session's
// credentials are gone, any leg still holding a camera or a vendor
// reservation is spending money for nobody. Discovered as a live incident: a
// stale Stop handler left the real negotiator running — camera indicator on,
// vendor billing in the background — on a page that said "Lens off".
//
// 'stopping' and 'off' are not orphan states: one is already on its way out,
// the other holds nothing. Every other phase — including 'error' and
// 'limited', where the negotiator still holds the camera it failed with —
// answers to the reaper.
export function isOrphanVideoLeg({ hasCredentials, videoPhase }) {
  if (hasCredentials) return false;
  return videoPhase !== 'off' && videoPhase !== 'stopping';
}
