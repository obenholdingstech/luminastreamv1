// Direct-mode audio alignment, bound to React. All decisions live in
// src/lib/audioAlign.js (the hold math, the engagement contract) and
// src/lib/elasticDelay.js (the smoothing policy); this hook owns lifecycles
// and one number of state.
//
// Engagement muting goes through the voice hook's setRemoteVolume — the
// graph's onEngaged/onDisengaged are the only callers, so the voice is
// muted exactly while the delay line verifiably carries it, and given back
// on suspension, failure, disable, or unmount. A graph that cannot be BUILT
// simply never engages: sync stays degraded, the voice stays alive.

import { useCallback, useEffect, useRef, useState } from 'react';

import { AUDIO_ALIGN_DEFAULTS, audioHoldSample, createAudioDelayGraph } from '@/lib/audioAlign';
import { createElasticDelay } from '@/lib/elasticDelay';

export function useAudioAlign({ track, enabled, setRemoteVolume }) {
  const [holdMs, setHoldMs] = useState(0);
  const graphRef = useRef(null);
  const policyRef = useRef(null);

  useEffect(() => {
    if (!enabled || !track) return undefined;
    const Ctx = globalThis.AudioContext ?? /** @type {any} */ (globalThis).webkitAudioContext;
    if (typeof Ctx !== 'function') return undefined;

    let graph = null;
    try {
      graph = createAudioDelayGraph({
        track,
        createContext: () => new Ctx(),
        onEngaged: () => setRemoteVolume(0),
        onDisengaged: () => setRemoteVolume(1),
      });
    } catch {
      return undefined; // no delay line — the element path was never touched
    }
    graphRef.current = graph;
    // A fresh policy per engagement: the last session's medians must not
    // steer this one's voice.
    policyRef.current = createElasticDelay(AUDIO_ALIGN_DEFAULTS);

    return () => {
      graphRef.current = null;
      policyRef.current = null;
      graph.dispose();
      setHoldMs(0);
    };
  }, [track, enabled, setRemoteVolume]);

  /** One measured utterance. The policy smooths; the graph glides. */
  const observe = useCallback((measuredMs, videoPathMs) => {
    const sample = audioHoldSample(measuredMs, videoPathMs);
    if (sample === null || !policyRef.current || !graphRef.current) return;
    policyRef.current.observe(sample);
    const target = policyRef.current.targetMs();
    graphRef.current.setTarget(target);
    setHoldMs(target);
  }, []);

  return { holdMs, observe };
}
