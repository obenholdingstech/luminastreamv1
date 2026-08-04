// Direct-mode A/V alignment: THE LAGGARD IS THE MASTER CLOCK.
//
// The original doctrine — "audio never waits" — was written for converted
// mode, where the re-synthesized voice is always the slow leg and delaying
// video toward it is always sufficient. The CEO's Direct-mode drill (4 Aug
// 2026 evening) exposed the case the doctrine never met: passthrough audio
// returns in ~300–400ms while the video leg costs ~700ms, so AUDIO leads and
// no amount of video-holding can ever close a gap that is on the other side.
// The generalization: whichever stream leads takes the hold. In converted
// mode that is video (nothing changes); in Direct mode it is audio, and the
// hold is (videoPath − mouth→ear), applied through a WebAudio delay line.
//
// The safety rule is absolute, because this module touches the one thing the
// product cannot lose — the voice: the delayed path ENGAGES only after the
// audio context is verifiably running, the un-delayed element is muted only
// through the onEngaged callback, and every failure mode (construction,
// suspension, disposal) disengages back to normal element playback. Degraded
// sync is a bad score; silence is a dead product.
//
// This module is the pure-ish half: the sample math and the graph lifecycle
// with every browser dependency injected. The React binding (useAudioAlign)
// owns nothing but state.

// Tuned tighter than the video elastic: an audio delay change is AUDIBLE
// (the delay line glides via setTargetAtTime, but a large swing still
// smears), so the deadband tolerates a little more drift and the slew moves
// in smaller steps. The ceiling is the plausible video path, not the 4s
// conversation backlog — backlog belongs to the video hold's world.
export const AUDIO_ALIGN_DEFAULTS = {
  window: 5,
  deadbandMs: 100,
  slewMs: 150,
  maxDelayMs: 1500,
};

/**
 * One utterance's audio-hold sample: how long the AUDIO must wait for its
 * frames. Zero when audio is not the leader; null junk stays null.
 * @param {number} measuredMs mouth→ear, from the sync meter
 * @param {number} videoPathMs the calibrated video-leg estimate
 */
export function audioHoldSample(measuredMs, videoPathMs) {
  if (!Number.isFinite(measuredMs) || !Number.isFinite(videoPathMs)) return null;
  return Math.max(0, videoPathMs - measuredMs);
}

/**
 * The visible-hold state machine: what the UI may CLAIM about the audio
 * hold. The claim follows ENGAGEMENT, not the controller's target — while
 * the delay line is disengaged the element plays undelayed, and reporting
 * "audio held 0.4s" over an unheld voice would be the exact dishonesty this
 * page exists to avoid. The target is cached across disengagement so a
 * recovering line resumes claiming the truth it still applies.
 */
export function createHoldReporter() {
  let engaged = false;
  let targetMs = 0;
  const visible = () => (engaged ? targetMs : 0);
  return {
    /** A new controller target. Returns what the UI may show NOW. */
    observe(ms) {
      if (Number.isFinite(ms)) targetMs = Math.max(0, ms);
      return visible();
    },
    engage() {
      engaged = true;
      return visible();
    },
    disengage() {
      engaged = false;
      return 0;
    },
  };
}

/**
 * The delay line: remote track → source → DelayNode → destination.
 *
 * @param {{
 *   track: any,
 *   createContext: () => any,
 *   StreamCtor?: any,
 *   onEngaged?: () => void,
 *   onDisengaged?: () => void,
 *   maxDelaySec?: number,
 * }} deps
 * @returns {{ setTarget: (ms: number) => void, dispose: () => void }}
 */
export function createAudioDelayGraph({
  track,
  createContext,
  StreamCtor = globalThis.MediaStream,
  onEngaged,
  onDisengaged,
  maxDelaySec = 2,
}) {
  let context = null;
  let source = null;
  let delayNode = null;
  let engaged = false;
  let disposed = false;

  const engage = () => {
    if (disposed || engaged) return;
    engaged = true;
    try {
      onEngaged?.();
    } catch {
      // a broken consumer must not take the graph down
    }
  };
  const disengage = () => {
    if (!engaged) return;
    engaged = false;
    try {
      onDisengaged?.();
    } catch {
      // ditto — and disengage MUST complete regardless
    }
  };

  try {
    context = createContext();
    source = context.createMediaStreamSource(new StreamCtor([track]));
    delayNode = context.createDelay(maxDelaySec);
    source.connect(delayNode);
    delayNode.connect(context.destination);
  } catch (err) {
    // Construction failed: leave the world exactly as found — the element
    // path was never muted, so the voice never stopped.
    try {
      source?.disconnect?.();
    } catch {
      /* never connected */
    }
    try {
      context?.close?.();
    } catch {
      /* never opened */
    }
    throw err;
  }

  // Engagement follows the CONTEXT's word, not our optimism: mute the
  // un-delayed path only while the delayed one is verifiably running, and
  // give the voice back the instant it is not.
  const follow = () => {
    if (context.state === 'running') engage();
    else disengage();
  };
  context.onstatechange = follow;
  follow();
  if (context.state !== 'running') {
    try {
      context.resume?.()?.catch?.(() => {});
    } catch {
      // resume is best-effort; onstatechange reports the outcome
    }
  }

  return {
    /** Glide the delay toward ms. Clamped to the line's own capacity. */
    setTarget(ms) {
      if (disposed || !Number.isFinite(ms)) return;
      const sec = Math.max(0, Math.min(maxDelaySec, ms / 1000));
      try {
        // A ~50ms time-constant approach: fast enough to track, slow enough
        // not to smear syllables.
        delayNode.delayTime.setTargetAtTime(sec, context.currentTime ?? 0, 0.05);
      } catch {
        try {
          delayNode.delayTime.value = sec;
        } catch {
          /* a dead param on a dying context — dispose will follow */
        }
      }
    },

    /** Tear down and GIVE THE VOICE BACK. Safe to call twice. */
    dispose() {
      if (disposed) return;
      disposed = true;
      disengage();
      try {
        context.onstatechange = null;
      } catch {
        /* already gone */
      }
      try {
        source?.disconnect?.();
      } catch {
        /* already disconnected */
      }
      try {
        context?.close?.()?.catch?.(() => {});
      } catch {
        /* already closed */
      }
    },
  };
}
