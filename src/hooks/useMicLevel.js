import { useEffect, useRef } from 'react';

// Live microphone amplitude, for the lens ring.
//
// Deliberately does NOT return React state. A level that updates 60 times a
// second through useState would re-render the whole page 60 times a second —
// on a laptop running a real-time voice pipeline, that is CPU stolen from the
// thing the user actually cares about. Instead the hook calls `onLevel` from
// inside its animation frame and the caller writes straight to a CSS custom
// property, so the ring animates entirely off React's critical path.
//
// The level is deliberately rough: an RMS of the time-domain samples, smoothed
// with an asymmetric filter (fast attack, slow release) so a spoken syllable
// reads as a swell rather than a flicker. This is a visual affordance, not a
// meter — the authoritative loudness numbers come from the agent.

const ATTACK = 0.5; // how fast the ring rises toward a louder frame
const RELEASE = 0.12; // how slowly it falls back — a decay tail, not a cliff
// Speech RMS sits well below full scale. Without this, normal talking would
// move the ring by a few percent and read as broken.
const GAIN = 4;

/**
 * @param {MediaStreamTrack|null|undefined} track live microphone track
 * @param {(level: number) => void} onLevel called each frame with 0..1
 */
export function useMicLevel(track, onLevel) {
  // Latest callback without restarting the audio graph when the caller
  // re-creates its closure — tearing down and rebuilding an AudioContext on
  // every render would be both expensive and audibly glitchy.
  const onLevelRef = useRef(onLevel);
  onLevelRef.current = onLevel;

  useEffect(() => {
    if (!track) {
      onLevelRef.current?.(0);
      return undefined;
    }

    // webkitAudioContext is the Safari-era prefix; it has no lib.dom entry,
    // so the lookup goes through an untyped view of window rather than an
    // @ts-ignore that would also mask a real mistake on the next line.
    const win = /** @type {any} */ (window);
    const AudioContextCtor = win.AudioContext || win.webkitAudioContext;
    if (!AudioContextCtor) return undefined; // no Web Audio — ring stays calm

    let context;
    let source;
    let frame = 0;
    let smoothed = 0;
    let stopped = false;

    try {
      context = new AudioContextCtor();
      // An AudioContext constructed outside a gesture handler starts
      // `suspended`, and a suspended context feeds the analyser nothing but
      // silence — the ring would sit dead still with no error anywhere. This
      // effect runs after the click that started the session, not inside it,
      // so the resume is required rather than defensive. Already-running
      // contexts resolve immediately.
      context.resume?.().catch(() => {});
      // A dedicated MediaStream wrapping the same track: we only ever read
      // from it. Nothing is connected to context.destination, so this graph
      // cannot route the microphone back out of the speakers.
      source = context.createMediaStreamSource(new MediaStream([track]));
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);

      const samples = new Float32Array(analyser.fftSize);

      const tick = () => {
        if (stopped) return;
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const s of samples) sum += s * s;
        const rms = Math.sqrt(sum / samples.length);
        const target = Math.min(1, rms * GAIN);
        // Asymmetric smoothing: rise quickly, fall slowly.
        const coefficient = target > smoothed ? ATTACK : RELEASE;
        smoothed += (target - smoothed) * coefficient;
        onLevelRef.current?.(smoothed);
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    } catch {
      // Autoplay policy, a track that ended mid-setup, an exhausted audio
      // context budget — none of these are worth failing a voice session over.
      return undefined;
    }

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      // Disconnect before close: an AudioContext that is closed while a source
      // node is still attached can leave the underlying track referenced.
      try {
        source?.disconnect();
      } catch {
        // already torn down
      }
      context?.close?.().catch(() => {});
      onLevelRef.current?.(0);
    };
  }, [track]);
}
