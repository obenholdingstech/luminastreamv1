// Live microphone amplitude, as a plain lifecycle with no React in it.
//
// This is the logic half of the lens ring. It lives here rather than inside
// the hook so it can be tested without a browser, a renderer, or a real
// microphone: every browser dependency it touches (AudioContext, MediaStream,
// requestAnimationFrame) is injectable. src/hooks/useMicLevel.js is a five-line
// binding on top of it.
//
// The level is deliberately rough: an RMS of the time-domain samples, smoothed
// with an asymmetric filter — fast attack, slow release — so a spoken syllable
// reads as a swell rather than a flicker. This is a visual affordance, not a
// meter; the authoritative loudness numbers come from the agent.
//
// Nothing here is ever allowed to throw at the caller. A voice session must not
// fail because a decoration could not start.

const ATTACK = 0.5; // how fast the ring rises toward a louder frame
const RELEASE = 0.12; // how slowly it falls back — a decay tail, not a cliff
// Speech RMS sits well below full scale. Without this, normal talking would
// move the ring by a few percent and read as broken.
const GAIN = 4;

const FFT_SIZE = 512;

const noop = () => {};

/**
 * @typedef {object} MeterDeps
 * @property {() => any} [createContext]  builds an AudioContext
 * @property {(track: any) => any} [createStream] wraps a track in a MediaStream
 * @property {(cb: () => void) => any} [raf]
 * @property {(handle: any) => void} [caf]
 */

/** Browser defaults, resolved lazily so importing this module needs no DOM. */
function browserDeps() {
  // webkitAudioContext is the Safari-era prefix and has no lib.dom entry, so
  // the lookup goes through an untyped view of globalThis rather than an
  // @ts-ignore that would also mask a real mistake alongside it.
  const g = /** @type {any} */ (globalThis);
  return {
    createContext: () => {
      const Ctor = g.AudioContext || g.webkitAudioContext;
      return Ctor ? new Ctor() : null;
    },
    createStream: (/** @type {any} */ track) => new g.MediaStream([track]),
    raf: (/** @type {() => void} */ cb) => g.requestAnimationFrame(cb),
    caf: (/** @type {any} */ handle) => g.cancelAnimationFrame(handle),
  };
}

/**
 * Start reporting microphone amplitude, and hand back the way to stop.
 *
 * Always returns a callable, and the callable is always safe to call more than
 * once — including when startup failed and there is nothing to tear down. The
 * caller (a React effect) can therefore return it unconditionally rather than
 * branching on whether setup worked.
 *
 * @param {any} track  a live MediaStreamTrack, or null
 * @param {(level: number) => void} onLevel called each frame with 0..1
 * @param {MeterDeps} [deps]
 * @returns {() => void} stop
 */
export function startMicLevelMeter(track, onLevel, deps = {}) {
  const { createContext, createStream, raf, caf } = { ...browserDeps(), ...deps };

  const report = (/** @type {number} */ level) => {
    try {
      onLevel?.(level);
    } catch {
      // A broken consumer must not take the audio graph down with it.
    }
  };

  if (!track) {
    report(0);
    return noop;
  }

  let context = null;
  let source = null;
  let frame = null;
  let smoothed = 0;
  let stopped = false;

  // ONE teardown, shared by the failure path and the stop path. They were
  // duplicated once, and the duplicate is exactly where a leak hides: the
  // failure path is the one nobody exercises by hand.
  const teardown = () => {
    if (stopped) return; // idempotent — a double stop must not double-close
    stopped = true;
    if (frame != null) {
      try {
        caf(frame);
      } catch {
        // handle already invalid
      }
      frame = null;
    }
    // Disconnect before close: closing a context while a source node is still
    // attached can leave the underlying track referenced.
    try {
      source?.disconnect();
    } catch {
      // never connected, or already torn down
    }
    source = null;
    try {
      context?.close?.()?.catch?.(noop);
    } catch {
      // close() on an already-closed context
    }
    context = null;
    report(0);
  };

  try {
    context = createContext();
    if (!context) {
      // No Web Audio in this browser. The ring simply stays calm; everything
      // else about the session works.
      report(0);
      return noop;
    }
    // A context constructed outside a gesture handler starts `suspended`, and
    // a suspended context feeds the analyser nothing but silence — the ring
    // would sit dead still with no error anywhere. The effect that calls this
    // runs after the click that starts a session, not inside it, so the resume
    // is required rather than defensive.
    context.resume?.()?.catch?.(noop);

    // A dedicated MediaStream wrapping the same track: we only ever read from
    // it. Nothing connects to context.destination, so this graph cannot route
    // the microphone back out of the speakers.
    source = context.createMediaStreamSource(createStream(track));
    const analyser = context.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    source.connect(analyser);

    const samples = new Float32Array(analyser.fftSize);

    const tick = () => {
      if (stopped) return;
      // The catch below is not belt-and-braces. tick runs from the browser's
      // animation-frame callback, NOT from anything the setup try/catch can
      // see — so a throw here (the context or the track invalidated mid-frame)
      // escapes to the browser, schedules no next frame, and never reaches
      // teardown. That is the same leaked AudioContext the failure path
      // already guards, arriving by a route the failure path cannot reach.
      try {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const s of samples) sum += s * s;
        const rms = Math.sqrt(sum / samples.length);
        const target = Math.min(1, rms * GAIN);
        const coefficient = target > smoothed ? ATTACK : RELEASE;
        smoothed += (target - smoothed) * coefficient;
        report(smoothed);
        // report() hands control to the consumer, which is allowed to call
        // stop() — a React effect tearing down mid-frame does exactly that.
        // Without this re-check the line below would overwrite the null that
        // teardown just wrote and queue a frame nobody will ever cancel.
        if (stopped) return;
        frame = raf(tick);
      } catch {
        // The graph died under us. Release it rather than leaking it.
        teardown();
      }
    };
    frame = raf(tick);
  } catch {
    // Autoplay policy, a track that ended mid-setup, an exhausted audio-context
    // budget. None of these are worth failing a voice session over — but the
    // context is constructed BEFORE the calls that can throw, and browsers cap
    // concurrent contexts per page. Leaking one here, on a failure that repeats
    // across every mic restart, kills the ring for the rest of the page's life.
    teardown();
    return noop;
  }

  return teardown;
}
