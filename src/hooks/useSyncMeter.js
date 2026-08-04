// The mouth→ear sync meter, bound to React (ROADMAP §P3, the instrument).
//
// Two level meters — the local mic (the mouth) and the remote track (the
// ear) — feed two onset gates, whose events feed the pairing meter. All the
// logic lives in src/lib (audioOnset, syncMeter, micLevelMeter) where it is
// tested; this hook only owns lifecycles and publishes readings.
//
// The remote gate opens lower than the local one: the converted voice
// arrives at playback level, already gained and compressed, while the local
// mic competes with room tone. Both use the SAME clock (performance.now), so
// the difference is a real duration — no clock sync, no agent cooperation.
//
// KNOWN EXCLUSION (bounded, accepted): the ear-side tap is the decoded
// remote track, not the speaker cone — the <audio> element's output-stage
// buffering (typically tens of ms) is outside the measurement. The mouth-
// side tap symmetrically starts at the analyser, not the lips, and the two
// residuals partially cancel. Both are an order of magnitude under the
// 120ms lip-sync deadband the controller tolerates, and any constant
// remainder is absorbed by the video-path calibration constant when the
// controller retargets (P3, next PR). Full render-path timing would buy
// precision the deadband cannot spend.

import { useEffect, useState } from 'react';

import { createOnsetGate } from '@/lib/audioOnset';
import { createSyncMeter } from '@/lib/syncMeter';
import { startMicLevelMeter } from '@/lib/micLevelMeter';

export function useSyncMeter(localTrack, remoteTrack) {
  const [reading, setReading] = useState(null); // {lastMs, medianMs, count} | null

  useEffect(() => {
    if (!localTrack || !remoteTrack) {
      setReading(null);
      return undefined;
    }

    const meter = createSyncMeter();
    const mouth = createOnsetGate();
    const ear = createOnsetGate({ openLevel: 0.08, closeLevel: 0.04 });
    const now = () => globalThis.performance?.now?.() ?? Date.now();

    const stopLocal = startMicLevelMeter(localTrack, (level) => {
      const event = mouth.feed(level, now());
      if (event?.type === 'onset') meter.localOnset(event.t);
    });
    const stopRemote = startMicLevelMeter(remoteTrack, (level) => {
      const event = ear.feed(level, now());
      if (event?.type === 'onset' && meter.remoteOnset(event.t) !== null) {
        // State moves only when a MEASUREMENT lands — onsets alone are noise
        // to React, and utterances arrive seconds apart.
        setReading({ lastMs: meter.lastMs(), medianMs: meter.medianMs(), count: meter.count() });
      }
    });

    return () => {
      stopLocal();
      stopRemote();
      setReading(null);
    };
  }, [localTrack, remoteTrack]);

  return reading;
}
