import { useCallback, useEffect, useRef, useState } from 'react';
import { ConnectionQuality, ConnectionState, Room, RoomEvent, Track } from 'livekit-client';

// LiveKit WebRTC voice hook — Stage 1 transport re-platform (WebRTC vs raw WebSocket).
// Connects to a LiveKit room, publishes the microphone, and samples WebRTC sender
// stats every second so transport quality is measured, not guessed.
//
// Lives alongside useVoiceStream (the WebSocket pipeline) for A/B comparison;
// neither replaces the other until Stage 1's exit criterion is met.

const STATS_INTERVAL_MS = 1000;

const EMPTY_STATS = { rttMs: null, jitterMs: null, packetLossPct: null, bitrateKbps: null };

// Browser mic processing — all ON is the browser default and what every
// session before Phase 2 used. Keys match livekit-client's AudioCaptureOptions
// (verified in dist/src/room/track/options.d.ts, 2.20.1).
const DEFAULT_CAPTURE_CONSTRAINTS = {
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
};

export function useLiveKitVoice(url, token) {
  const [connectionState, setConnectionState] = useState(ConnectionState.Disconnected);
  const [connectionQuality, setConnectionQuality] = useState(ConnectionQuality.Unknown);
  const [room, setRoom] = useState(null);
  const [stats, setStats] = useState(EMPTY_STATS);
  const [error, setError] = useState(null);
  // Remote audio playback (the echo agent's returned track): [{ sid, identity }]
  const [remoteAudio, setRemoteAudio] = useState([]);
  // True when the browser's autoplay policy blocked playback — fix via enableAudio()
  const [audioBlocked, setAudioBlocked] = useState(false);
  // Convert agent's CONFIRMED mode ('passthrough' | 'convert') — the agent is
  // the source of truth; null until the first agent_mode message arrives
  const [agentMode, setAgentMode] = useState(null);
  const [agentModeReason, setAgentModeReason] = useState(null);
  // Mic capture constraints (Phase 2 experiment) — survive across sessions;
  // applied at publish time and re-applied live via restartTrack
  const [captureConstraints, setCaptureConstraints] = useState(DEFAULT_CAPTURE_CONSTRAINTS);
  // What the browser ACTUALLY applied (MediaStreamTrack.getSettings() after
  // publish/restart) — browsers may silently ignore requested constraints, so
  // the UI readout must render this, never the requested state. null = no live mic.
  const [appliedConstraints, setAppliedConstraints] = useState(null);

  const roomRef = useRef(null);
  // Latest constraints for connect()/toggle without re-creating callbacks
  const captureConstraintsRef = useRef(DEFAULT_CAPTURE_CONSTRAINTS);
  // trackSid → { track, identity } for every remote audio track we attached
  const remoteAudioRef = useRef(new Map());
  // Previous cumulative counters — bitrate and loss % are per-interval deltas
  const prevSampleRef = useRef(null);

  // Latest url/token without re-creating connect() — same pattern as sessionIdRef in useVoiceStream
  const urlRef = useRef(url);
  urlRef.current = url;
  const tokenRef = useRef(token);
  tokenRef.current = token;

  // Read the settings the browser actually granted off the live mic track.
  // getSettings() is synchronous; a key can come back undefined when the
  // browser doesn't report it (surfaced as "unknown" in the UI, not a mismatch)
  const readAppliedConstraints = useCallback((micTrack) => {
    const settings = micTrack?.mediaStreamTrack?.getSettings?.();
    if (!settings) {
      setAppliedConstraints(null);
      return;
    }
    setAppliedConstraints({
      noiseSuppression: settings.noiseSuppression,
      echoCancellation: settings.echoCancellation,
      autoGainControl: settings.autoGainControl,
    });
  }, []);

  // Refs/DOM only — safe from unmount cleanup where setState must be avoided.
  // track.detach() detaches ALL elements for the track and returns them.
  const detachAllRemoteAudio = useCallback(() => {
    remoteAudioRef.current.forEach(({ track }) => {
      track.detach().forEach((el) => el.remove());
    });
    remoteAudioRef.current.clear();
  }, []);

  // Shared UI reset for a session ending — used by the Disconnected handler
  // (unexpected drops) and by disconnect() (user-initiated, where the handler
  // is deliberately skipped because the ref was already released)
  const resetSessionState = useCallback(() => {
    detachAllRemoteAudio();
    setRemoteAudio([]);
    setAudioBlocked(false);
    setAgentMode(null);
    setAgentModeReason(null);
    setAppliedConstraints(null);
    setRoom(null);
    setConnectionQuality(ConnectionQuality.Unknown);
    setStats(EMPTY_STATS);
    prevSampleRef.current = null;
  }, [detachAllRemoteAudio]);

  const connect = useCallback(async () => {
    if (roomRef.current) return; // one active room at a time
    setError(null);
    setStats(EMPTY_STATS);
    prevSampleRef.current = null;

    const newRoom = new Room();
    roomRef.current = newRoom;

    // roomRef.current === newRoom is the "still the active session" check.
    // disconnect() and unmount release the ref first, so a superseded room's
    // late events and in-flight awaits must never mutate the current UI state.
    newRoom.on(RoomEvent.ConnectionStateChanged, (state) => {
      if (roomRef.current === newRoom) setConnectionState(state);
    });
    newRoom.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
      if (roomRef.current === newRoom && participant.isLocal) setConnectionQuality(quality);
    });
    newRoom.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (roomRef.current !== newRoom || track.kind !== Track.Kind.Audio) return;
      // attach() creates an <audio> element and attempts autoplay; a blocked
      // attempt surfaces via AudioPlaybackStatusChanged below
      const element = track.attach();
      document.body.appendChild(element);
      remoteAudioRef.current.set(publication.trackSid, { track, identity: participant.identity });
      setRemoteAudio(
        Array.from(remoteAudioRef.current, ([sid, entry]) => ({ sid, identity: entry.identity })),
      );
    });
    newRoom.on(RoomEvent.TrackUnsubscribed, (track, publication) => {
      if (roomRef.current !== newRoom) return;
      const entry = remoteAudioRef.current.get(publication.trackSid);
      if (!entry) return;
      entry.track.detach().forEach((el) => el.remove());
      remoteAudioRef.current.delete(publication.trackSid);
      setRemoteAudio(
        Array.from(remoteAudioRef.current, ([sid, e]) => ({ sid, identity: e.identity })),
      );
    });
    newRoom.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      if (roomRef.current === newRoom) setAudioBlocked(!newRoom.canPlaybackAudio);
    });
    newRoom.on(RoomEvent.DataReceived, (payload) => {
      if (roomRef.current !== newRoom) return;
      // The convert agent publishes {"type":"agent_mode","mode":...,"reason"?}
      // as JSON — its confirmations drive the UI, not the toggle button
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        if (msg?.type === 'agent_mode' && typeof msg.mode === 'string') {
          setAgentMode(msg.mode);
          setAgentModeReason(msg.reason ?? null);
        }
      } catch (_e) {
        // non-JSON data from some other publisher — not ours
      }
    });
    newRoom.on(RoomEvent.Disconnected, () => {
      // Unexpected end (network drop, server close) while still the active room.
      // Also sets connectionState directly — don't rely on event ordering between
      // Disconnected and ConnectionStateChanged once the ref is released.
      if (roomRef.current !== newRoom) return;
      roomRef.current = null;
      setConnectionState(ConnectionState.Disconnected);
      resetSessionState();
    });

    try {
      await newRoom.connect(urlRef.current, tokenRef.current);
      if (roomRef.current !== newRoom) {
        // disconnect()/unmount won the race mid-connect — this room is orphaned
        await newRoom.disconnect().catch(() => {});
        return;
      }

      // Publish the mic — rejects if permission is denied, which lands in catch
      // below. The second argument is AudioCaptureOptions
      // (setMicrophoneEnabled(enabled, options?, publishOptions?) — verified in
      // dist/src/room/participant/LocalParticipant.d.ts:100, 2.20.1).
      await newRoom.localParticipant.setMicrophoneEnabled(
        true,
        { ...captureConstraintsRef.current },
      );
      if (roomRef.current !== newRoom) {
        await newRoom.disconnect().catch(() => {});
        return;
      }

      // Applied truth: what did the browser actually grant?
      readAppliedConstraints(
        newRoom.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack,
      );
      setRoom(newRoom);
    } catch (err) {
      // Only surface the failure if this attempt is still the active one — a
      // cancelled attempt (user disconnected mid-connect) is not an error
      if (roomRef.current === newRoom) {
        roomRef.current = null;
        setError(err?.message || 'Failed to connect to LiveKit.');
        setConnectionState(ConnectionState.Disconnected);
      }
      // A remote track can attach between connect() resolving and the mic
      // publish failing — the guarded TrackUnsubscribed handler won't clean it
      // up once the ref is released, so detach explicitly
      detachAllRemoteAudio();
      await newRoom.disconnect().catch(() => {});
    }
  }, [resetSessionState, detachAllRemoteAudio, readAppliedConstraints]);

  const disconnect = useCallback(async () => {
    const activeRoom = roomRef.current;
    if (!activeRoom) return;
    // Release the ref first — this is the cancellation signal that in-flight
    // connect() awaits and the room's own event handlers check against
    roomRef.current = null;
    await activeRoom.disconnect(); // stops the mic track
    setConnectionState(ConnectionState.Disconnected);
    resetSessionState();
  }, [resetSessionState]);

  // Ask the convert agent to switch modes. Fire-and-forget: the UI only
  // changes when the agent confirms via agent_mode (it is the source of truth)
  const requestAgentMode = useCallback(async (mode) => {
    const activeRoom = roomRef.current;
    if (!activeRoom) return;
    try {
      await activeRoom.localParticipant.publishData(
        new TextEncoder().encode(JSON.stringify({ type: 'set_mode', mode })),
        { reliable: true },
      );
    } catch (_e) {
      // transient publish failure — the user can click again
    }
  }, []);

  // Toggle one mic processing constraint. Disconnected: state only (used at the
  // next publish). Connected: re-acquires the mic in place via
  // LocalAudioTrack.restartTrack — the SDK stops the old MediaStreamTrack, runs
  // getUserMedia with the new constraints, and swaps it into the existing
  // sender (setMediaStreamTrack → replaceTrack), so the publication and track
  // SID survive and NO reconnect is needed (verified live in headless Chrome:
  // settings flip, same trackSid, room stays connected).
  //
  // The explicit deviceId matters: when the options carry none, 2.20.1's
  // constraintsForOptions substitutes deviceId {ideal:'default'}
  // (dist/livekit-client.esm.mjs) — a toggle could silently jump back to the
  // system-default mic. Pinning the current device keeps toggles device-neutral.
  const setCaptureConstraint = useCallback(async (name, enabled) => {
    const next = { ...captureConstraintsRef.current, [name]: enabled };
    captureConstraintsRef.current = next;
    setCaptureConstraints(next);

    const activeRoom = roomRef.current;
    const micTrack = activeRoom?.localParticipant
      ?.getTrackPublication(Track.Source.Microphone)?.audioTrack;
    if (!micTrack) return;
    try {
      const deviceId =
        micTrack.getSourceTrackSettings?.().deviceId ?? (await micTrack.getDeviceId(false));
      if (roomRef.current !== activeRoom) return; // session ended mid-await
      await micTrack.restartTrack(
        deviceId ? { ...next, deviceId: { exact: deviceId } } : { ...next },
      );
    } catch (err) {
      if (roomRef.current === activeRoom) {
        setError(err?.message || 'Failed to re-acquire the microphone with new constraints.');
      }
    } finally {
      // Applied truth after every attempt — even a failed restart leaves a
      // track whose real settings the readout must reflect
      if (roomRef.current === activeRoom) readAppliedConstraints(micTrack);
    }
  }, [readAppliedConstraints]);

  // Browsers may block autoplay until a user gesture — LiveKit surfaces that
  // via AudioPlaybackStatusChanged; calling startAudio() from a click fixes it
  const enableAudio = useCallback(async () => {
    const activeRoom = roomRef.current;
    if (!activeRoom) return;
    try {
      await activeRoom.startAudio();
      setAudioBlocked(!activeRoom.canPlaybackAudio);
    } catch (_e) {
      // still blocked — the indicator stays on and the user can retry
    }
  }, []);

  // Sample WebRTC stats every second while connected.
  // RTT / jitter / packetsLost come from remote-inbound-rtp — the SFU's RTCP receiver
  // reports about OUR outbound audio — so they appear a few seconds after connecting.
  //
  // Deliberately NOT using LocalAudioTrack.getSenderStats(): in livekit-client 2.20.1
  // its audio implementation reads packetsLost/roundTripTime/jitter off the outbound-rtp
  // entry, where those fields don't exist per the WebRTC spec (they live on
  // remote-inbound-rtp), so it returns them as undefined — verified against
  // dist/livekit-client.esm.mjs and confirmed live in headless Chrome.
  useEffect(() => {
    if (connectionState !== ConnectionState.Connected) return undefined;

    const timer = setInterval(async () => {
      const activeRoom = roomRef.current;
      const micTrack = activeRoom?.localParticipant?.getTrackPublication(Track.Source.Microphone)?.audioTrack;
      const sender = micTrack?.sender;
      if (!sender) return;

      let report;
      try {
        report = await sender.getStats();
      } catch (_e) {
        return; // transient — sender mid-renegotiation
      }

      // Sender-scoped report → these entries are our mic track only
      /** @type {any} */
      let outbound = null;
      /** @type {any} */
      let remoteInbound = null;
      report.forEach((entry) => {
        if (entry.type === 'outbound-rtp') outbound = entry;
        if (entry.type === 'remote-inbound-rtp') remoteInbound = entry;
      });
      if (!outbound) return;

      const sample = {
        timestamp: outbound.timestamp,
        bytesSent: outbound.bytesSent || 0,
        packetsSent: outbound.packetsSent || 0,
        packetsLost: remoteInbound?.packetsLost || 0,
      };
      const prev = prevSampleRef.current;
      prevSampleRef.current = sample;

      let bitrateKbps = null;
      let packetLossPct = null;
      if (prev && sample.timestamp > prev.timestamp) {
        const seconds = (sample.timestamp - prev.timestamp) / 1000;
        bitrateKbps = Math.max(0, Math.round(((sample.bytesSent - prev.bytesSent) * 8) / seconds / 1000));
        const sentDelta = sample.packetsSent - prev.packetsSent;
        const lostDelta = Math.max(0, sample.packetsLost - prev.packetsLost);
        if (sentDelta > 0) {
          packetLossPct = Math.min(100, Math.round((lostDelta / sentDelta) * 1000) / 10);
        }
      }

      setStats({
        rttMs: remoteInbound?.roundTripTime != null ? Math.round(remoteInbound.roundTripTime * 1000) : null,
        jitterMs: remoteInbound?.jitter != null ? Math.round(remoteInbound.jitter * 10000) / 10 : null,
        packetLossPct,
        bitrateKbps,
      });
    }, STATS_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [connectionState]);

  // Leave the room if the component unmounts mid-session. Releases the ref first
  // so guarded handlers skip setState on the unmounted component; audio elements
  // are detached ref-only (no setState) so nothing lingers in the DOM.
  useEffect(() => {
    return () => {
      detachAllRemoteAudio();
      const activeRoom = roomRef.current;
      roomRef.current = null;
      if (activeRoom) activeRoom.disconnect().catch(() => {});
    };
  }, [detachAllRemoteAudio]);

  return {
    connectionState,
    connectionQuality,
    room,
    stats,
    error,
    remoteAudio,
    audioBlocked,
    agentMode,
    agentModeReason,
    captureConstraints,
    appliedConstraints,
    connect,
    disconnect,
    enableAudio,
    requestAgentMode,
    setCaptureConstraint,
  };
}
