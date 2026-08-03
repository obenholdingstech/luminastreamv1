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
