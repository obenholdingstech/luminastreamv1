import { useEffect, useRef } from 'react';

import { startMicLevelMeter } from '@/lib/micLevelMeter';

// React binding for the microphone level meter. All of the logic — the audio
// graph, the smoothing, and the teardown that must survive a failed setup —
// lives in src/lib/micLevelMeter.js, where it is tested without a browser.
//
// Deliberately does NOT return React state. A level that updates 60 times a
// second through useState would re-render the whole page 60 times a second —
// on a laptop already running a real-time voice pipeline, that is CPU stolen
// from the thing the user actually cares about. Instead `onLevel` is called
// from inside the animation frame and the caller writes straight to a CSS
// custom property, so the ring animates entirely off React's critical path.

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

  useEffect(
    // startMicLevelMeter always returns a callable, including when setup
    // failed, so there is nothing to branch on here.
    () => startMicLevelMeter(track, (level) => onLevelRef.current?.(level)),
    [track],
  );
}
