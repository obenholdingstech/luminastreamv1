// The video leg of the lens: a thin React binding over videoNegotiator.js.
//
// Every lifecycle decision — offer/answer, ICE queueing, cancellation,
// teardown, releasing a session that arrived for a page nobody is looking at
// — lives in `src/lib/videoNegotiator.js`, where it can be tested without a
// browser (AGENTS.md). What remains here is publishing that state into React
// and owning the frame pipeline instance.
//
// The terminal-limit rule, measured by the probe on 3 Aug: at the constraint
// Decart stops generating, says "Session duration limit reached", and may then
// sit CONNECTED producing nothing. That zombie is the silent freeze the canon
// forbids, so the limit error is terminal WHEREVER it surfaces — during the
// negotiation or long after the session went live.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  createVideoSession,
  endVideoSession,
  isDurationLimitError,
  readVideoBudget,
  sendCandidates,
  setVideoImage,
  setVideoPrompt,
} from '@/lib/videoClient';
import { createAlignStage } from '@/lib/alignStage';
import { createFramePipeline } from '@/lib/framePipeline';
import { createSynthStage } from '@/lib/synthStage';
import { probeSynthCapability } from '@/lib/synthProbe';
import { createUpscaleStage } from '@/lib/upscaleStage';
import { createVideoNegotiator, NEGOTIATION } from '@/lib/videoNegotiator';

export const VIDEO_PHASE = {
  off: 'off',
  starting: 'starting',
  live: 'live',
  stopping: 'stopping',
  limited: 'limited', // the vendor's duration wall — terminal, with a reason
  error: 'error',
};

const PHASE_FROM_NEGOTIATION = {
  [NEGOTIATION.idle]: VIDEO_PHASE.off,
  [NEGOTIATION.media]: VIDEO_PHASE.starting,
  [NEGOTIATION.offering]: VIDEO_PHASE.starting,
  [NEGOTIATION.creating]: VIDEO_PHASE.starting,
  [NEGOTIATION.answering]: VIDEO_PHASE.starting,
  [NEGOTIATION.live]: VIDEO_PHASE.live,
  [NEGOTIATION.stopped]: VIDEO_PHASE.off,
};

export function useLensVideo(adminToken) {
  const [phase, setPhase] = useState(VIDEO_PHASE.off);
  const [error, setError] = useState('');
  const [budget, setBudget] = useState(null);
  const [stream, setStream] = useState(null);
  // The raw camera, for the connecting fade: visible while the vendor leg
  // negotiates, gone the moment teardown stops capturing. Reported by the
  // negotiator, never read from getUserMedia here — one owner per stream.
  const [localStream, setLocalStream] = useState(null);

  const mountedRef = useRef(true);
  // Terminal states must survive the negotiator's own phase reports: once the
  // duration wall is hit, "stopped" would erase the reason from the screen.
  const terminalRef = useRef(false);

  // useMemo, not a ref written during render — React may replay or discard
  // render work, and a mutation there can leak from UI that never commits.
  // P3 fills the align slot: an elastic buffer that stands video beside the
  // audio it belongs to. Audio is the master clock; the page feeds the sync
  // meter's measured mouth→ear delay into pipeline.stages.align.observeMouthToEar.
  // Both P3 slots are filled now: align (elastic delay, fed the measured
  // mouth→ear number) then upscale (Catmull-Rom + CAS to 1080p — Lucy stays
  // 720p, the fidelity is ours). Each is an honest passthrough where its
  // platform pieces are missing.
  const pipeline = useMemo(
    () =>
      createFramePipeline({
        align: createAlignStage(),
        synthesize: createSynthStage(),
        upscale: createUpscaleStage(),
      }),
    [],
  );

  // Tier changes (probe verdict arriving, governor demotion) must reach the
  // readout without a poll — the stage publishes, this state re-renders.
  const [synthTier, setSynthTier] = useState('off');
  useEffect(
    () => pipeline.stages.synthesize.subscribe?.(setSynthTier),
    [pipeline],
  );

  // The capability benchmark runs ONCE, at the first session start (CEO
  // directive: check the device, then choose the tier). Fired from start()
  // rather than mount so an idle tab never spins a GPU probe; the loop reads
  // its mode live, so a verdict landing after the stream is up simply
  // switches synthesis on.
  const probeStateRef = useRef('idle');
  const runSynthProbe = useCallback(() => {
    if (probeStateRef.current !== 'idle') return;
    probeStateRef.current = 'running';
    probeSynthCapability()
      .then((res) => {
        if (mountedRef.current) {
          pipeline.stages.synthesize.adopt(res);
        } else {
          // The verdict arrived for a page nobody is looking at — the GPU
          // state it built must not outlive the tab (sessionHolder lesson).
          for (const r of Object.values(res.renderers ?? {})) r?.dispose?.();
        }
        probeStateRef.current = 'done';
      })
      .catch(() => {
        probeStateRef.current = 'done'; // no grant is a valid verdict
      });
  }, [pipeline]);

  const negotiator = useMemo(
    () =>
      createVideoNegotiator({
        PeerConnection: globalThis.RTCPeerConnection,
        getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
        createSession: (args) => createVideoSession(adminToken, args),
        endSession: (session) => endVideoSession(adminToken, session),
        sendCandidates: (session, candidates) => sendCandidates(adminToken, session, candidates),
        // Every remote frame enters through the pipeline — receive → align →
        // upscale → present — even while the middle stages are inert.
        onStream: (raw) => {
          if (mountedRef.current) setStream(pipeline.run(raw).stream);
        },
        onLocalStream: (raw) => {
          if (mountedRef.current) setLocalStream(raw);
        },
        onPhase: (next) => {
          if (mountedRef.current && !terminalRef.current) {
            setPhase(PHASE_FROM_NEGOTIATION[next] ?? VIDEO_PHASE.off);
          }
        },
        onFailure: (reason) => {
          if (!mountedRef.current) return;
          // A failure AFTER live is where the duration wall shows up in the
          // wild — the start() catch cannot see it, and treating it as a
          // generic error would invite a retry into a zombie.
          if (isDurationLimitError(reason)) {
            terminalRef.current = true;
            setError('the session reached its time limit');
            setPhase(VIDEO_PHASE.limited);
          } else {
            setError(reason);
            setPhase(VIDEO_PHASE.error);
          }
        },
      }),
    [adminToken, pipeline],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshBudget = useCallback(() => {
    readVideoBudget(adminToken).then((b) => {
      if (mountedRef.current && b) setBudget(b);
    });
  }, [adminToken]);

  const start = useCallback(
    async (/** @type {{prompt?: string, requestedSeconds?: number}} */ options = {}) => {
      terminalRef.current = false;
      setError('');
      runSynthProbe();
      try {
        const session = await negotiator.start(options);
        if (!mountedRef.current) {
          // Arrived for a page nobody is looking at — the sessionHolder
          // lesson, and here it costs vendor money per second.
          if (session) await negotiator.stop();
          return;
        }
        if (session) refreshBudget();
      } catch (err) {
        if (!mountedRef.current) return;
        if (isDurationLimitError(err)) {
          terminalRef.current = true;
          setError('the session reached its time limit');
          setPhase(VIDEO_PHASE.limited);
        } else {
          setError(err?.message || 'could not start video');
          setPhase(VIDEO_PHASE.error);
        }
      }
    },
    [negotiator, refreshBudget, runSynthProbe],
  );

  const stop = useCallback(async () => {
    terminalRef.current = false;
    if (mountedRef.current) setPhase(VIDEO_PHASE.stopping);
    const result = await negotiator.stop();
    if (!mountedRef.current) return;
    // `deferred` means the vendor delete failed and the server kept the
    // reservation for its executioner. Saying "stopped" would be the one lie
    // this whole topology exists to avoid.
    setError(result?.deferred ? 'closing — the server is still ending the session' : '');
    setPhase(VIDEO_PHASE.off);
    refreshBudget();
  }, [negotiator, refreshBudget]);

  const updatePrompt = useCallback(
    (prompt) => setVideoPrompt(adminToken, negotiator.session, prompt),
    [adminToken, negotiator],
  );

  // Mid-session identity swap: the new reference is animated without
  // reconnecting, so it costs no negotiation and no new reservation.
  const updateImage = useCallback(
    (imageData, prompt) => setVideoImage(adminToken, negotiator.session, imageData, prompt),
    [adminToken, negotiator],
  );

  // Leaving the page releases the vendor session — the executioner alarm is a
  // backstop, not an operation.
  useEffect(() => {
    const release = () => {
      if (negotiator.session) endVideoSession(adminToken, negotiator.session);
    };
    globalThis.addEventListener?.('pagehide', release);
    return () => {
      globalThis.removeEventListener?.('pagehide', release);
      release();
      negotiator.stop();
    };
  }, [adminToken, negotiator, pipeline]);

  // Stage teardown is UNMOUNT-ONLY, deliberately separate from the effect
  // above: that one re-runs whenever adminToken changes (negotiator is
  // memoized on it), and releasing the stages there would freeze the
  // presented video mid-session — the generator-backed stream stays on
  // screen while its feeding loop is dead (CodeRabbit, PR 68). `pipeline`
  // is a stable useMemo([]), so this cleanup fires exactly once, when the
  // page actually leaves. The align stage holds decoded frames and the
  // upscale stage holds a GL context — both must not outlive the page.
  useEffect(
    () => () => {
      pipeline.stages.align.release?.();
      pipeline.stages.synthesize.release?.();
      pipeline.stages.upscale.release?.();
    },
    [pipeline],
  );

  return {
    phase,
    error,
    budget,
    stream,
    localStream,
    pipeline,
    synthTier,
    start,
    stop,
    updatePrompt,
    updateImage,
  };
}
