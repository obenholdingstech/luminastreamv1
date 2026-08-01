// Product vocabulary for the lens, derived from agent truth.
//
// The console at /livekit-test speaks the agent's own protocol words —
// "passthrough", "convert", raw ConnectionState tokens. That is correct for an
// instrument. It is wrong for the product: a person selecting LuminaStream as
// their microphone does not care what the agent calls its modes.
//
// This module is the single translation layer between the two, kept pure so
// the mapping is testable without a browser, a room, or an agent. Every
// function here takes agent-reported state and returns something renderable;
// none of them decide anything the agent has not already confirmed.

// livekit-client's ConnectionState values, as literals.
//
// Deliberately NOT imported from livekit-client: this module is pure and is
// unit-tested under plain node, while the SDK is a browser package. The
// coupling is real, so it is pinned by a test that imports the actual enum and
// fails if the SDK ever renames a state — see lensState.test.js.
export const CONNECTION = {
  disconnected: 'disconnected',
  connecting: 'connecting',
  connected: 'connected',
  reconnecting: 'reconnecting',
  signalReconnecting: 'signalReconnecting',
};

/**
 * The two lens modes, in the order they are offered.
 *
 * `agentMode` is the wire value the convert agent understands
 * (convert_agent.py MODES). `id` is what the product calls it. Nothing outside
 * this module should hardcode either side of that pair.
 */
export const LENS_MODES = [
  {
    id: 'direct',
    agentMode: 'passthrough',
    label: 'Direct',
    blurb: 'Your own voice, carried through untouched.',
  },
  {
    id: 'converted',
    agentMode: 'convert',
    label: 'Converted',
    blurb: 'Your words, spoken in your voice.',
  },
];

/** Lens mode id → the agent's wire mode. `null` for anything unknown. */
export function agentModeFor(lensModeId) {
  return LENS_MODES.find((m) => m.id === lensModeId)?.agentMode ?? null;
}

/**
 * The agent's confirmed wire mode → the lens mode entry.
 *
 * `null` — not a default — when the agent has said nothing yet or reports a
 * mode this build does not know. The UI must render "waiting" in that case,
 * never a guess: showing "Direct" for an unconfirmed agent is exactly the
 * applied-vs-requested lie the console was built to avoid.
 */
export function lensModeFor(agentMode) {
  return LENS_MODES.find((m) => m.agentMode === agentMode) ?? null;
}

/**
 * One status for the whole lens, resolved in severity order.
 *
 * Order is the point. A connected room whose agent is busy serving someone
 * else is NOT "live" — the mic is reaching the room and nothing is coming
 * back, which is the single most confusing state the current one-agent
 * topology can produce. Anything that means "your audio is not being
 * transformed" outranks anything that means "connected".
 *
 * @param {object} [s]
 * @param {string} [s.connectionState] livekit-client ConnectionState value
 * @param {string|null} [s.agentMode] agent-confirmed mode, null until it speaks
 * @param {object|null} [s.agentBusy] the agent's agent_busy payload, if it named us
 * @param {boolean} [s.audioBlocked]  browser autoplay policy is holding audio
 * @param {string|null} [s.error]     connection error text
 * @returns {{id: string, label: string, detail: string, tone: 'idle'|'working'|'live'|'warn'|'error'}}
 */
export function deriveLensStatus({
  connectionState,
  agentMode = null,
  agentBusy = null,
  audioBlocked = false,
  error = null,
} = {}) {
  if (connectionState === CONNECTION.disconnected) {
    return error
      ? { id: 'error', label: 'Lens off', detail: error, tone: 'error' }
      : { id: 'off', label: 'Lens off', detail: 'Nothing is being captured.', tone: 'idle' };
  }

  if (connectionState === CONNECTION.connecting) {
    return {
      id: 'connecting',
      label: 'Opening the lens',
      detail: 'Joining the room and publishing your microphone.',
      tone: 'working',
    };
  }

  if (
    connectionState === CONNECTION.reconnecting ||
    connectionState === CONNECTION.signalReconnecting
  ) {
    return {
      id: 'reconnecting',
      label: 'Reconnecting',
      detail: 'The connection dropped. Holding your session open.',
      tone: 'warn',
    };
  }

  // Connected from here down.
  if (agentBusy) {
    return {
      id: 'busy',
      label: 'Agent busy',
      detail: `Already serving ${agentBusy.processing ?? 'another speaker'}. Your voice is not being transformed.`,
      tone: 'warn',
    };
  }

  if (audioBlocked) {
    return {
      id: 'blocked',
      label: 'Audio blocked',
      detail: 'Your browser is holding playback until you interact with the page.',
      tone: 'warn',
    };
  }

  const lens = lensModeFor(agentMode);
  if (!lens) {
    return {
      id: 'waiting',
      label: 'Waiting for the agent',
      detail: 'Connected. No agent has claimed this room yet.',
      tone: 'working',
    };
  }

  return {
    id: `live-${lens.id}`,
    label: `Live — ${lens.label}`,
    detail: lens.blurb,
    tone: 'live',
  };
}

/**
 * Median end-to-end latency over the last few utterances, in whole ms.
 *
 * Median, not last-sample, and not mean: TTS tail latency is a long-tailed
 * distribution (p50 648 ms against a p95 near 1900 ms on the VPS drill), so a
 * single slow utterance would make a product readout flap alarmingly while the
 * session is in fact fine. The mean has the same problem in slower motion.
 *
 * Dropped utterances carry no timing and are excluded rather than counted as
 * zero. Returns null when there is nothing to measure — never 0, which would
 * render as an impossibly good number.
 *
 * The field name is the agent's, not ours: tts_engine.py publishes
 * `tail_latency_ms` on its `tts_utterance` notice.
 *
 * @param {Array<{tail_latency_ms?: number, dropped?: boolean}>} utterances newest first
 * @param {number} [sampleSize]
 * @returns {number|null}
 */
export function medianTailMs(utterances, sampleSize = 5) {
  if (!Array.isArray(utterances) || sampleSize <= 0) return null;
  const samples = [];
  for (const u of utterances) {
    if (samples.length >= sampleSize) break;
    if (!u || u.dropped) continue;
    const tail = u.tail_latency_ms;
    if (typeof tail === 'number' && Number.isFinite(tail)) samples.push(tail);
  }
  if (samples.length === 0) return null;
  samples.sort((a, b) => a - b);
  const mid = samples.length >> 1;
  const median =
    samples.length % 2 === 1 ? samples[mid] : (samples[mid - 1] + samples[mid]) / 2;
  return Math.round(median);
}
