// Direct-mode audio alignment, bound to React. All decisions live in
// src/lib/audioAlign.js (the hold math, the engagement contract, the
// visible-hold reporter) and src/lib/elasticDelay.js (the smoothing
// policy); this hook owns lifecycles and one number of state.
//
// Muting is scoped to THE aligned track via setTrackVolume — the delay line
// carries exactly one track, and a blanket mute would silence any other
// publisher whose audio is not being delayed at all. What the UI may claim
// (`holdMs`) follows ENGAGEMENT through the tested reporter: a target on a
// disengaged line is never shown as a hold, and a recovering line resumes
// claiming the truth it still applies.

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  AUDIO_ALIGN_DEFAULTS,
  audioHoldSample,
  createAudioDelayGraph,
  createHoldReporter,
} from '@/lib/audioAlign';
import { createElasticDelay } from '@/lib/elasticDelay';

export function useAudioAlign({ track, enabled, setTrackVolume }) {
  const [holdMs, setHoldMs] = useState(0);
  const graphRef = useRef(null);
  const policyRef = useRef(null);
  const reporterRef = useRef(null);

  useEffect(() => {
    if (!enabled || !track) return undefined;
    const Ctx = globalThis.AudioContext ?? /** @type {any} */ (globalThis).webkitAudioContext;
    if (typeof Ctx !== 'function') return undefined;

    const reporter = createHoldReporter();
    let graph = null;
    try {
      graph = createAudioDelayGraph({
        track,
        createContext: () => new Ctx(),
        onEngaged: () => {
          setTrackVolume(track, 0);
          setHoldMs(reporter.engage());
        },
        onDisengaged: () => {
          setTrackVolume(track, 1);
          setHoldMs(reporter.disengage());
        },
      });
    } catch {
      return undefined; // no delay line — the element path was never touched
    }
    graphRef.current = graph;
    reporterRef.current = reporter;
    // A fresh policy per engagement: the last session's medians must not
    // steer this one's voice.
    policyRef.current = createElasticDelay(AUDIO_ALIGN_DEFAULTS);

    return () => {
      graphRef.current = null;
      policyRef.current = null;
      reporterRef.current = null;
      graph.dispose();
      setHoldMs(0);
    };
  }, [track, enabled, setTrackVolume]);

  /** One measured utterance. The policy smooths; the graph glides; the
      reporter decides what the UI may say. Stable identity — effects that
      feed measurements depend on THIS, never on a per-render wrapper. */
  const observe = useCallback((measuredMs, videoPathMs) => {
    const sample = audioHoldSample(measuredMs, videoPathMs);
    if (sample === null || !policyRef.current || !graphRef.current) return;
    policyRef.current.observe(sample);
    const target = policyRef.current.targetMs();
    graphRef.current.setTarget(target);
    setHoldMs(reporterRef.current?.observe(target) ?? 0);
  }, []);

  return { holdMs, observe };
}
