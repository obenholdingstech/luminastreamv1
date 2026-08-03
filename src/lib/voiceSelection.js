// Voice selection, as a pure state machine.
//
// This lived inside Studio.jsx for exactly one review round — the third time
// this project has put lifecycle logic in a component (sessionHolder at P1b,
// videoNegotiator at P2d), and the same tell every time: no test file beside
// it. The behaviors below are precisely the ones that were wrong in the
// component version, which is the argument for the extraction.
//
// The rules (the mode toggle's honesty rules, applied to voices):
//   - the CONFIRMED voice is whatever the agent's broadcast last said; a
//     request is never shown as if it had been applied;
//   - a rejection belongs to the request that produced it — a stale
//     `rejected` field from an earlier exchange must never resolve a new
//     request (only broadcasts that ARRIVE while a request is pending are
//     consulted);
//   - re-selecting the confirmed voice is a no-op, and clears any pending
//     request (the user changed their mind back);
//   - a publish that fails or cannot be sent resolves the request
//     immediately with a visible reason — a pending state that nothing can
//     ever resolve is the stuck slot, again;
//   - disconnect resets everything: there is no agent to confirm anything.

/**
 * @param {{ publish: (params: {voice: string}) => Promise<boolean>|boolean }} deps
 *   `publish` sends the knob request and reports whether the SEND succeeded
 *   (not whether the agent accepted — that answer arrives by broadcast).
 */
export function createVoiceSelector({ publish }) {
  let requested = null; // voice id awaiting the agent's answer
  let rejection = null; // { voiceId, reason } for the last resolved request

  return {
    /** @returns {{ requested: string|null, rejection: {voiceId:string, reason:string}|null }} */
    snapshot() {
      return { requested, rejection };
    },

    /**
     * Ask the agent to switch. `confirmedVoice` is the broadcast's current
     * truth at the moment of the request.
     */
    async request(voiceId, confirmedVoice) {
      rejection = null;
      if (!voiceId || voiceId === confirmedVoice) {
        // Choosing what is already true asks for nothing — and cancels a
        // pending request, because the user just chose the status quo.
        requested = null;
        return;
      }
      requested = voiceId;
      let sent = false;
      try {
        sent = await publish({ voice: voiceId });
      } catch {
        sent = false; // a throwing transport is a failed send, not a crash
      }
      if (!sent) {
        requested = null;
        rejection = { voiceId, reason: 'the request could not be sent — try again' };
      }
    },

    /**
     * A NEW agent_config broadcast arrived. Only called for broadcasts that
     * arrive after (or during) a pending request — which is what ties a
     * rejection to the request that produced it: a stale rejected field in
     * an older snapshot is never consulted, because nothing was pending when
     * it arrived.
     */
    onBroadcast(snapshot) {
      if (!requested) return;
      const confirmed = snapshot?.config?.voice;
      if (confirmed === requested) {
        requested = null;
        rejection = null;
        return;
      }
      const reason = snapshot?.rejected?.voice;
      if (reason) {
        rejection = { voiceId: requested, reason: String(reason) };
        requested = null;
      }
      // Neither confirmed nor rejected: a periodic broadcast passing through
      // mid-flight. The request stays pending until the answering broadcast.
    },

    /** Disconnect: no agent, no pending question, no stale reasons. */
    reset() {
      requested = null;
      rejection = null;
    },
  };
}
