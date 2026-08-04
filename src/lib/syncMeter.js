// The mouth→ear meter: the A/V sync number measured where it is TRUE.
//
// Why this exists (4 Aug 2026, CEO scores sync 5/10 "inconsistent"): the
// video-delay controller was fed the agent's `tail_latency_ms` — measured at
// the agent, from the END of the user's speech to the first synthesized
// sample ENQUEUED. Three terms are missing from that number, and together
// they are most of the truth:
//
//   1. the utterance's own duration — the voice re-speaks the FIRST word
//      `speech_s` after the lips said it, before tail even starts;
//   2. playback-queue drain — "enqueued" is not "played"; backlog waits
//      behind the previous utterance and is invisible to tail;
//   3. network + the browser's jitter buffer and audio stack.
//
// Short utterances hide all three (they land "together"); long ones expose
// them (video leads by seconds). That is exactly the observed inconsistency.
//
// This module measures the whole path with no proxies and no clock sync:
// both timestamps come from the SAME browser clock. The local mic hears the
// mouth (onset at t_mouth); the remote track sounds the converted voice
// (onset at t_ear); delay = t_ear − t_mouth. Everything between — STT, queue,
// synthesis, backlog, network, jitter buffer — is inside the measurement by
// construction.
//
// Pairing is FIFO with expiry: utterances come back in order, a pending
// mouth onset that has waited past `maxDelayMs` was dropped (the agent
// drops utterances by design), and a remote onset with no plausible pending
// partner (agent greetings, echo) measures nothing rather than lying.
//
// PR A: this is a METER only — nothing here moves the video. The controller
// starts listening to it in the next step, once the numbers are on screen.

export const SYNC_METER_DEFAULTS = {
  minDelayMs: 200, // the pipeline's floor — anything faster is echo, not the returned voice
  maxDelayMs: 10_000, // beyond this the utterance was dropped, not delayed
  maxPending: 6, // mouth onsets awaiting a voice; older ones age out first
  window: 5, // measurements kept for the median
};

export function createSyncMeter(overrides = {}) {
  const cfg = { ...SYNC_METER_DEFAULTS, ...overrides };
  /** @type {number[]} */
  const pending = []; // mouth-onset times awaiting their voice, oldest first
  /** @type {number[]} */
  const measures = [];
  let total = 0;

  const median = () => {
    if (measures.length === 0) return null;
    const sorted = [...measures].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  return {
    /** The mouth started moving (local mic onset). */
    localOnset(tMs) {
      if (!Number.isFinite(tMs)) return;
      pending.push(tMs);
      if (pending.length > cfg.maxPending) pending.shift();
    },

    /**
     * The converted voice started sounding (remote onset). Returns the new
     * measurement in ms, or null when nothing plausible was pending.
     */
    remoteOnset(tMs) {
      if (!Number.isFinite(tMs)) return null;
      // Pendings that could never pair again are dropped utterances.
      while (pending.length > 0 && tMs - pending[0] > cfg.maxDelayMs) pending.shift();
      if (pending.length === 0) return null;
      const delay = tMs - pending[0];
      // Too fast to be the pipeline's answer: speaker echo or room noise.
      // The pending onset stays — its real voice may still be coming.
      if (delay < cfg.minDelayMs) return null;
      pending.shift();
      measures.push(delay);
      if (measures.length > cfg.window) measures.shift();
      total += 1;
      return delay;
    },

    /** The stable answer: median mouth→ear delay, ms. Null until measured. */
    medianMs: () => median(),
    /** The newest single measurement, ms. Null until measured. */
    lastMs: () => (measures.length > 0 ? measures[measures.length - 1] : null),
    /** How many utterances have ever been measured this session. */
    count: () => total,

    reset() {
      pending.length = 0;
      measures.length = 0;
      total = 0;
    },
  };
}
