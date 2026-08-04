// A speech-onset gate: noisy level samples in, clean onset/offset events out.
//
// This is half of the A/V sync METER (ROADMAP §P3, "instrument before
// tuning"). The meter needs two timestamps per utterance — when the mouth
// started moving (local mic) and when the converted voice started sounding
// (remote track) — and both come from the same primitive: a level gate with
// hysteresis, a hangover, and a minimum-duration guard, so a chair creak or
// a single hot sample never counts as speech.
//
// Pure and clock-free: the caller feeds (level, nowMs) at whatever cadence
// its analyser runs. Nothing here reads a clock or touches the DOM, which is
// what makes the pairing logic downstream testable to the millisecond.
//
// The reported onset time is when the level FIRST crossed the open
// threshold — not when the minimum-duration guard finally believed it — so
// a confirmed onset carries the true start of the sound, not the
// bureaucracy's timestamp.

export const ONSET_DEFAULTS = {
  openLevel: 0.12, // crossing this starts a candidate segment
  closeLevel: 0.05, // hysteresis: the segment is voiced while above this
  hangoverMs: 400, // this much continuous quiet ends the segment
  minOpenMs: 120, // candidates shorter than this were clicks, not speech
};

export function createOnsetGate(overrides = {}) {
  const cfg = { ...ONSET_DEFAULTS, ...overrides };
  let open = false; // inside a candidate segment
  let announced = false; // the onset has been reported
  let openedAt = 0; // when the level first crossed openLevel
  let lastVoiceAt = 0; // last sample above closeLevel

  return {
    /**
     * One level sample. Returns at most one event:
     * `{type:'onset', t}` — speech confirmed (t = when it actually began);
     * `{type:'offset', t}` — a confirmed segment ended (t = last voiced ms);
     * `null` — nothing changed.
     * @param {number} level 0..1
     * @param {number} nowMs caller's clock, ms
     */
    feed(level, nowMs) {
      if (!Number.isFinite(level) || !Number.isFinite(nowMs)) return null;

      if (!open) {
        if (level >= cfg.openLevel) {
          open = true;
          announced = false;
          openedAt = nowMs;
          lastVoiceAt = nowMs;
        }
        return null;
      }

      if (level >= cfg.closeLevel) lastVoiceAt = nowMs;

      // Confirmation before closure: a segment that has lasted minOpenMs is
      // speech, and its onset is the ORIGINAL crossing time.
      if (!announced && nowMs - openedAt >= cfg.minOpenMs && level >= cfg.closeLevel) {
        announced = true;
        return { type: 'onset', t: openedAt };
      }

      if (nowMs - lastVoiceAt >= cfg.hangoverMs) {
        open = false;
        // An unconfirmed candidate dies silently — it was never speech.
        return announced ? { type: 'offset', t: lastVoiceAt } : null;
      }

      return null;
    },

    /** A new session, a new room tone — forget everything. */
    reset() {
      open = false;
      announced = false;
    },
  };
}
