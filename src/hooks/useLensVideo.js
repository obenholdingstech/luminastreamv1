// The video half of the lens: a peer connection to Decart, brokered by our
// Worker.
//
// Media is peer-to-peer with the vendor (ROADMAP §P2's committed topology), so
// lip-sync pays no proxy tax; every control message goes through the Worker,
// which holds the key. This hook owns the RTCPeerConnection lifecycle and
// nothing else — the decisions about WHEN a session may exist live in the
// Worker and the ledger, and the frame path lives in framePipeline.js.
//
// The terminal-limit rule, measured by the probe on 3 Aug: at the constraint
// Decart stops generating, says "Session duration limit reached", and the SDK
// (and a bare RTCPeerConnection alike) may then sit CONNECTED while producing
// nothing. That zombie is the silent freeze the canon forbids, so the limit
// error is terminal here: we stop, we say why, and we do not let a
// reconnection pretend the session survived.

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  createVideoSession,
  endVideoSession,
  isDurationLimitError,
  readVideoBudget,
  sendCandidates,
  setVideoPrompt,
} from '@/lib/videoClient';
import { createFramePipeline } from '@/lib/framePipeline';

export const VIDEO_PHASE = {
  off: 'off',
  starting: 'starting',
  live: 'live',
  stopping: 'stopping',
  limited: 'limited', // the vendor's duration wall — terminal, with a reason
  error: 'error',
};

export function useLensVideo(adminToken) {
  const [phase, setPhase] = useState(VIDEO_PHASE.off);
  const [error, setError] = useState('');
  const [budget, setBudget] = useState(null);
  const [stream, setStream] = useState(null);

  const pcRef = useRef(null);
  const sessionRef = useRef(null);
  const localRef = useRef(null);
  const mountedRef = useRef(true);
  // One pipeline instance for the component's life: P3 swaps a stage in
  // without this hook or the surface changing shape.
  const pipelineRef = useRef(null);
  if (!pipelineRef.current) pipelineRef.current = createFramePipeline();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const teardown = useCallback(() => {
    try {
      pcRef.current?.close();
    } catch {
      // A close that throws must not stop the rest of the teardown.
    }
    pcRef.current = null;
    localRef.current?.getTracks?.().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* already stopped */
      }
    });
    localRef.current = null;
    setStream(null);
  }, []);

  /** Give the slot back. Best-effort like every release in this codebase. */
  const stop = useCallback(async () => {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (mountedRef.current) setPhase(VIDEO_PHASE.stopping);
    teardown();
    if (!session) {
      if (mountedRef.current) setPhase(VIDEO_PHASE.off);
      return;
    }
    const result = await endVideoSession(adminToken, session);
    if (!mountedRef.current) return;
    // `deferred` means the vendor delete failed and the server kept the
    // reservation for its executioner. Saying "stopped" would be the one lie
    // this whole topology is built to avoid.
    if (result.deferred) {
      setError('closing — the server is still ending the session with the vendor');
    }
    setPhase(VIDEO_PHASE.off);
    readVideoBudget(adminToken).then((b) => mountedRef.current && b && setBudget(b));
  }, [adminToken, teardown]);

  const start = useCallback(
    async (/** @type {{prompt?: string, requestedSeconds?: number}} */ { prompt, requestedSeconds } = {}) => {
      if (phase === VIDEO_PHASE.starting || phase === VIDEO_PHASE.live) return;
      setPhase(VIDEO_PHASE.starting);
      setError('');

      let pc = null;
      try {
        const local = await navigator.mediaDevices.getUserMedia({
          video: { width: 1280, height: 720 },
          audio: false, // audio is the agent's job; this is the video leg only
        });
        localRef.current = local;

        pc = new RTCPeerConnection();
        pcRef.current = pc;
        for (const track of local.getTracks()) pc.addTrack(track, local);

        pc.ontrack = (event) => {
          if (!mountedRef.current) return;
          // Every remote frame enters through the pipeline — receive → align
          // → upscale → present — even while the middle stages are inert.
          // Bypassing it "just for now" is how FHD becomes a retrofit.
          const frames = pipelineRef.current.run(event.streams[0] ?? null);
          setStream(frames.stream);
        };
        pc.onconnectionstatechange = () => {
          if (!mountedRef.current) return;
          if (pc.connectionState === 'failed') {
            setError('the video connection failed');
            setPhase(VIDEO_PHASE.error);
            teardown();
          }
        };

        const offer = await pc.createOffer({ offerToReceiveVideo: true });
        await pc.setLocalDescription(offer);

        const session = await createVideoSession(adminToken, {
          sdpOffer: offer.sdp ?? '',
          requestedSeconds,
          prompt,
        });
        // Record BEFORE any await that could interleave with an unmount —
        // the sessionHolder lesson: a slot that arrives for a page nobody is
        // looking at still has to be given back.
        sessionRef.current = { ...session, etag: session.vendor?.etag };

        if (!mountedRef.current) {
          await endVideoSession(adminToken, sessionRef.current);
          sessionRef.current = null;
          teardown();
          return;
        }

        const answer = session.vendor?.sdpAnswer;
        if (!answer) throw new Error('the server returned no answer');
        await pc.setRemoteDescription({ type: 'answer', sdp: answer });

        pc.onicecandidate = (event) => {
          // null candidate = end-of-candidates, which the vendor expects.
          sendCandidates(adminToken, sessionRef.current, event.candidate ? [event.candidate] : null);
        };

        if (mountedRef.current) {
          setPhase(VIDEO_PHASE.live);
          readVideoBudget(adminToken).then((b) => mountedRef.current && b && setBudget(b));
        }
      } catch (err) {
        if (!mountedRef.current) {
          if (sessionRef.current) await endVideoSession(adminToken, sessionRef.current);
          sessionRef.current = null;
          teardown();
          return;
        }
        // The vendor's duration wall is TERMINAL — never a retry, never a
        // reconnect into a session that generates nothing.
        if (isDurationLimitError(err)) {
          setError('the session reached its time limit');
          setPhase(VIDEO_PHASE.limited);
        } else {
          setError(err?.message || 'could not start video');
          setPhase(VIDEO_PHASE.error);
        }
        teardown();
        if (sessionRef.current) {
          await endVideoSession(adminToken, sessionRef.current);
          sessionRef.current = null;
        }
      }
    },
    [adminToken, phase, teardown],
  );

  const updatePrompt = useCallback(
    (prompt) => setVideoPrompt(adminToken, sessionRef.current, prompt),
    [adminToken],
  );

  // Leaving the page releases the vendor session, same discipline as the
  // audio slot: the executioner alarm is a backstop, not an operation.
  useEffect(() => {
    const release = () => {
      if (sessionRef.current) endVideoSession(adminToken, sessionRef.current);
    };
    globalThis.addEventListener?.('pagehide', release);
    return () => {
      globalThis.removeEventListener?.('pagehide', release);
      release();
      teardown();
    };
  }, [adminToken, teardown]);

  return {
    phase,
    error,
    budget,
    stream,
    pipeline: pipelineRef.current,
    start,
    stop,
    updatePrompt,
  };
}
