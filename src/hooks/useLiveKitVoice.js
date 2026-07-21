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

  const roomRef = useRef(null);
  // trackSid → { track, identity } for every remote audio track we attached
  const remoteAudioRef = useRef(new Map());
  // Previous cumulative counters — bitrate and loss % are per-interval deltas
  const prevSampleRef = useRef(null);

  // Latest url/token without re-creating connect() — same pattern as sessionIdRef in useVoiceStream
  const urlRef = useRef(url);
  urlRef.current = url;
  const tokenRef = useRef(token);
  tokenRef.current = token;

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

      // Publish the mic — rejects if permission is denied, which lands in catch below
      await newRoom.localParticipant.setMicrophoneEnabled(true);
      if (roomRef.current !== newRoom) {
        await newRoom.disconnect().catch(() => {});
        return;
      }

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
  }, [resetSessionState, detachAllRemoteAudio]);

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
    connect,
    disconnect,
    enableAudio,
  };
}
