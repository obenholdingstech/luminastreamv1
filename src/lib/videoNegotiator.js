// The WebRTC negotiation with Decart, as a pure module.
//
// This lived in a React hook for exactly one review round, which is one round
// too many: AGENTS.md is explicit — "anything with real logic belongs in
// src/lib/ rather than inside a component, because this is the part that can
// be tested without a browser" — and the audio session learned the same
// lesson at P1b (sessionHolder.js). Lifecycle logic in a component is
// lifecycle logic nobody can break on purpose.
//
// The bug that proved it: ICE gathering begins the moment the local
// description is set, but the handler was attached AFTER a network round
// trip, so every candidate generated in that window was dropped — and the DOM
// ICE API does not replay missed events. Behind NAT that is a connection that
// intermittently fails for no visible reason. A negotiator with a fake
// RTCPeerConnection catches it in a millisecond; a hook cannot be asked.
//
// Everything is injected — RTCPeerConnection, getUserMedia, the client calls,
// the clock — so a test can gather a candidate before the session exists,
// abort mid-negotiation, or make the vendor hang, and assert what happened to
// the session and the money.

export const NEGOTIATION = {
  idle: 'idle',
  media: 'media', // asking for the camera
  offering: 'offering', // createOffer / setLocalDescription
  creating: 'creating', // our Worker → vendor session
  answering: 'answering', // setRemoteDescription
  live: 'live',
  stopped: 'stopped',
};

/** Raised when stop() interrupts an in-flight start. Not an error condition. */
export class NegotiationAborted extends Error {
  constructor() {
    super('negotiation aborted');
    this.name = 'NegotiationAborted';
  }
}

/**
 * @param {{
 *   createSession: (args: any) => Promise<any>,
 *   endSession: (session: any) => Promise<any>,
 *   sendCandidates: (session: any, candidates: any) => any,
 *   getUserMedia: (constraints: any) => Promise<any>,
 *   PeerConnection: any,
 *   onStream?: (stream: any) => void,
 *   onPhase?: (phase: string) => void,
 *   onFailure?: (reason: string) => void,
 * }} deps
 */
export function createVideoNegotiator({
  createSession,
  endSession,
  sendCandidates,
  getUserMedia,
  PeerConnection,
  onStream,
  onPhase,
  onFailure,
}) {
  let phase = NEGOTIATION.idle;
  let pc = null;
  let localStream = null;
  let session = null;
  let aborted = false;
  // Candidates gathered before the session exists have nowhere to be sent —
  // the server routes them by session id. Queue, then flush. Dropping them
  // is the NAT bug.
  let pendingCandidates = [];

  const setPhase = (next) => {
    phase = next;
    onPhase?.(next);
  };

  /** Every await in start() is followed by this. Stop must always reach us. */
  const checkpoint = () => {
    if (aborted) throw new NegotiationAborted();
  };

  function teardown() {
    try {
      pc?.close();
    } catch {
      // A close that throws must not abort the rest of the teardown.
    }
    pc = null;
    for (const track of localStream?.getTracks?.() ?? []) {
      try {
        track.stop();
      } catch {
        /* already stopped */
      }
    }
    localStream = null;
    pendingCandidates = [];
    onStream?.(null);
  }

  return {
    get phase() {
      return phase;
    },
    get session() {
      return session;
    },

    async start(
      /** @type {{prompt?: string, requestedSeconds?: number, constraints?: any}} */
      { prompt, requestedSeconds, constraints } = {},
    ) {
      if (phase !== NEGOTIATION.idle && phase !== NEGOTIATION.stopped) return null;
      aborted = false;
      pendingCandidates = [];

      try {
        setPhase(NEGOTIATION.media);
        localStream = await getUserMedia(
          constraints ?? { video: { width: 1280, height: 720 }, audio: false },
        );
        checkpoint();

        pc = new PeerConnection();
        for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

        // ATTACHED IMMEDIATELY — before any await that could let gathering
        // start unheard. Candidates that arrive before the session exists are
        // queued, not dropped.
        pc.onicecandidate = (event) => {
          const payload = event?.candidate ? [event.candidate] : null;
          if (session) sendCandidates(session, payload);
          else pendingCandidates.push(payload);
        };
        pc.ontrack = (event) => onStream?.(event?.streams?.[0] ?? null);
        pc.onconnectionstatechange = () => {
          if (pc?.connectionState === 'failed') onFailure?.('the video connection failed');
        };

        setPhase(NEGOTIATION.offering);
        const offer = await pc.createOffer({ offerToReceiveVideo: true });
        checkpoint();
        await pc.setLocalDescription(offer);
        checkpoint();

        setPhase(NEGOTIATION.creating);
        const created = await createSession({
          sdpOffer: offer.sdp ?? '',
          requestedSeconds,
          prompt,
        });
        // Recorded BEFORE the abort check: a session that exists must be
        // releasable even if the user gave up while it was being created.
        session = { ...created, etag: created?.vendor?.etag };
        checkpoint();

        // Flush what gathered while the session was being born.
        for (const queued of pendingCandidates) sendCandidates(session, queued);
        pendingCandidates = [];

        const answer = created?.vendor?.sdpAnswer;
        if (!answer) throw new Error('the server returned no answer');
        setPhase(NEGOTIATION.answering);
        await pc.setRemoteDescription({ type: 'answer', sdp: answer });
        checkpoint();

        setPhase(NEGOTIATION.live);
        return session;
      } catch (err) {
        // Whatever went wrong — including the user pressing Stop — the slot
        // goes back and the camera light goes out.
        const held = session;
        session = null;
        teardown();
        setPhase(NEGOTIATION.stopped);
        if (held) await endSession(held);
        if (err instanceof NegotiationAborted) return null;
        throw err;
      }
    },

    /**
     * Interrupt an in-flight start, or end a live session. Reachable from
     * ANY phase — a start that cannot be cancelled is a slot the user cannot
     * give back, which is the Starlink lesson with a vendor bill attached.
     */
    async stop() {
      aborted = true;
      const held = session;
      session = null;
      teardown();
      setPhase(NEGOTIATION.stopped);
      if (!held) return { ok: true, settled: false };
      return endSession(held);
    },
  };
}
