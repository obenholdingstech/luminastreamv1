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
  // GENERATION-SCOPED, not a shared flag. A stopped start whose getUserMedia
  // is still pending must never resume — and a restart used to clear the
  // shared flag, letting the abandoned start sail past its checkpoints and
  // create a SECOND paid session for a user who asked for one.
  let generation = 0;
  // Candidates gathered before the session exists have nowhere to be sent —
  // the server routes them by session id. Queue, then flush. Dropping them
  // is the NAT bug.
  let pendingCandidates = [];

  const setPhase = (next) => {
    phase = next;
    onPhase?.(next);
  };

  /**
   * Every await in start() is followed by this. Stop must always reach us —
   * and the check is against the generation the start was born in, so a
   * later start cannot revive an earlier one.
   */
  const checkpoint = (mine) => {
    if (mine !== generation) throw new NegotiationAborted();
  };

  /**
   * A candidate send that fails must be OBSERVABLE, never an unhandled
   * rejection. The collaborator is injected, so this cannot rely on today's
   * videoClient catching its own errors — the surrender() lesson from the
   * ledger, applied to the wire. One lost candidate is not a teardown (WebRTC
   * retries by design), but silence about it is exactly the invisible failure
   * this module exists to eliminate.
   */
  function trySendCandidates(target, payload) {
    try {
      Promise.resolve(sendCandidates(target, payload)).catch(() =>
        onFailure?.('an ICE candidate could not be delivered'),
      );
    } catch {
      onFailure?.('an ICE candidate could not be delivered');
    }
  }

  /** Close one start's own resources, without touching the shared slots. */
  function closeLocal(peer, stream) {
    try {
      peer?.close();
    } catch {
      // A close that throws must not abort the rest of the cleanup.
    }
    for (const track of stream?.getTracks?.() ?? []) {
      try {
        track.stop();
      } catch {
        /* already stopped */
      }
    }
  }

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
      const mine = ++generation;
      pendingCandidates = [];

      // A superseded start must touch ONLY its own resources. Held locally
      // and published to the shared slots after each checkpoint, so an
      // abandoned start's cleanup can never close the peer connection or stop
      // the camera of the start that replaced it — a bug this module's own
      // restart test caught, and one that would have presented as "video dies
      // a second after I restart it".
      let myStream = null;
      let myPc = null;
      let mySession = null;

      try {
        setPhase(NEGOTIATION.media);
        myStream = await getUserMedia(
          constraints ?? { video: { width: 1280, height: 720 }, audio: false },
        );
        checkpoint(mine);
        localStream = myStream;

        myPc = new PeerConnection();
        pc = myPc;
        for (const track of myStream.getTracks()) myPc.addTrack(track, myStream);

        // ATTACHED IMMEDIATELY — before any await that could let gathering
        // start unheard. Candidates that arrive before the session exists are
        // queued, not dropped.
        myPc.onicecandidate = (event) => {
          const payload = event?.candidate ? [event.candidate] : null;
          if (session) trySendCandidates(session, payload);
          else pendingCandidates.push(payload);
        };
        myPc.ontrack = (event) => {
          if (mine === generation) onStream?.(event?.streams?.[0] ?? null);
        };
        myPc.onconnectionstatechange = () => {
          if (mine === generation && myPc?.connectionState === 'failed') {
            onFailure?.('the video connection failed');
          }
        };

        setPhase(NEGOTIATION.offering);
        const offer = await myPc.createOffer({ offerToReceiveVideo: true });
        checkpoint(mine);
        await myPc.setLocalDescription(offer);
        checkpoint(mine);

        setPhase(NEGOTIATION.creating);
        const created = await createSession({
          sdpOffer: offer.sdp ?? '',
          requestedSeconds,
          prompt,
        });
        // Recorded BEFORE the abort check: a session that exists must be
        // releasable even if the user gave up while it was being created.
        mySession = { ...created, etag: created?.vendor?.etag };
        checkpoint(mine);
        session = mySession;

        // Flush what gathered while the session was being born.
        for (const queued of pendingCandidates) trySendCandidates(session, queued);
        pendingCandidates = [];

        const answer = created?.vendor?.sdpAnswer;
        if (!answer) throw new Error('the server returned no answer');
        setPhase(NEGOTIATION.answering);
        await myPc.setRemoteDescription({ type: 'answer', sdp: answer });
        checkpoint(mine);

        setPhase(NEGOTIATION.live);
        return mySession;
      } catch (err) {
        const superseded = mine !== generation;
        if (superseded) {
          // Someone else owns the shared slots now. Release ONLY what this
          // start made — its own session (real money), its own peer, its own
          // camera — and report nothing: the phase belongs to the live start.
          closeLocal(myPc, myStream);
          if (mySession) await endSession(mySession);
          return null;
        }
        // Still current: the ordinary path — the slot goes back and the
        // camera light goes out.
        const held = session ?? mySession;
        session = null;
        teardown();
        setPhase(NEGOTIATION.stopped);
        if (held) await endSession(held);
        if (err instanceof NegotiationAborted) return null;
        throw err;
      }
    },

    /**
     * The vendor's own error channel.
     *
     * `onFailure` previously only ever received native RTCPeerConnection
     * failures, so the terminal duration-limit classifier in the hook had
     * NOTHING that could feed it the vendor's message — a wall with no door.
     * Decart reports "Session duration limit reached" over its SSE event
     * stream (the `eventToken` P2c already passes through to the browser);
     * that consumer calls this, and the message reaches the classifier
     * intact. Wired and tested now so the consumer is a caller, not a
     * refactor.
     */
    reportVendorError(message) {
      onFailure?.(typeof message === 'string' ? message : (message?.message ?? 'vendor error'));
    },

    /**
     * Interrupt an in-flight start, or end a live session. Reachable from
     * ANY phase — a start that cannot be cancelled is a slot the user cannot
     * give back, which is the Starlink lesson with a vendor bill attached.
     */
    async stop() {
      // Bumping the generation invalidates any start in flight — including
      // one blocked on an unanswered camera prompt.
      generation += 1;
      const held = session;
      session = null;
      teardown();
      setPhase(NEGOTIATION.stopped);
      if (!held) return { ok: true, settled: false };
      return endSession(held);
    },
  };
}
