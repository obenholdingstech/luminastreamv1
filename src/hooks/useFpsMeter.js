// The fps instrument's browser half: requestVideoFrameCallback on the
// presented <video> element feeds the pure meter (src/lib/fpsMeter.js);
// a 1Hz publisher turns readings into React state. Two rates on purpose —
// frames arrive ~25 times a second and rendering the page at that rate to
// display a number would make the instrument the load it measures.
//
// requestVideoFrameCallback is Chrome-family (the drill canon is Chrome
// already); where it is missing the answer stays null and the readout shows
// nothing — no number is invented from a guess.

import { useEffect, useRef, useState } from 'react';

import { createFpsMeter } from '@/lib/fpsMeter';

export function useFpsMeter(videoElRef, stream) {
  const [fps, setFps] = useState(null);
  const meterRef = useRef(null);

  useEffect(() => {
    const el = videoElRef.current;
    if (!stream || !el || typeof el.requestVideoFrameCallback !== 'function') {
      setFps(null);
      return undefined;
    }
    const meter = createFpsMeter();
    meterRef.current = meter;
    let alive = true;
    let handle = null;

    const onFrame = (now) => {
      if (!alive) return;
      meter.frame(now);
      handle = el.requestVideoFrameCallback(onFrame);
    };
    handle = el.requestVideoFrameCallback(onFrame);

    const publisher = setInterval(() => {
      // The reader's clock, so a stalled stream decays to null within one
      // window instead of repeating its last healthy number forever.
      if (alive) setFps(meter.read(globalThis.performance?.now?.() ?? Date.now()));
    }, 1000);

    return () => {
      alive = false;
      clearInterval(publisher);
      try {
        el.cancelVideoFrameCallback?.(handle);
      } catch {
        /* element already gone */
      }
      meterRef.current = null;
      setFps(null);
    };
  }, [videoElRef, stream]);

  return fps;
}
