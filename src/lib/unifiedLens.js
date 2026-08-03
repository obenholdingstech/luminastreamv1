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

    /** A new audio session means a fresh latch; no session means none. */
    reset() {
      firedFor = null;
    },
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

    reset() {
      appliedFor = null;
    },
  };
}
