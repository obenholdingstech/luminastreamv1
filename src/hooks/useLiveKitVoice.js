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

  const roomRef = useRef(null);
  // Previous cumulative counters — bitrate and loss % are per-interval deltas
  const prevSampleRef = useRef(null);

  // Latest url/token without re-creating connect() — same pattern as sessionIdRef in useVoiceStream
  const urlRef = useRef(url);
  urlRef.current = url;
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const connect = useCallback(async () => {
    if (roomRef.current) return; // one active room at a time
    setError(null);
    setStats(EMPTY_STATS);
    prevSampleRef.current = null;

    const newRoom = new Room();
    roomRef.current = newRoom;

    newRoom.on(RoomEvent.ConnectionStateChanged, (state) => setConnectionState(state));
    newRoom.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
      if (participant.isLocal) setConnectionQuality(quality);
    });
    newRoom.on(RoomEvent.Disconnected, () => {
      roomRef.current = null;
      setRoom(null);
      setConnectionQuality(ConnectionQuality.Unknown);
      setStats(EMPTY_STATS);
      prevSampleRef.current = null;
    });

    try {
      await newRoom.connect(urlRef.current, tokenRef.current);
      // Publish the mic — rejects if permission is denied, which lands in catch below
      await newRoom.localParticipant.setMicrophoneEnabled(true);
      setRoom(newRoom);
    } catch (err) {
      setError(err?.message || 'Failed to connect to LiveKit.');
      roomRef.current = null;
      await newRoom.disconnect().catch(() => {});
      setConnectionState(ConnectionState.Disconnected);
    }
  }, []);

  const disconnect = useCallback(async () => {
    const activeRoom = roomRef.current;
    roomRef.current = null;
    if (activeRoom) {
      await activeRoom.disconnect(); // stops the mic track and fires Disconnected → state cleanup
    }
  }, []);

  // Sample WebRTC stats every second while connected.
  // RTT / jitter / packetsLost come from remote-inbound-rtp — the SFU's RTCP receiver
  // reports about OUR outbound audio — so they appear a few seconds after connecting.
  useEffect(() => {
    if (connectionState !== ConnectionState.Connected) return undefined;

    const timer = setInterval(async () => {
      const activeRoom = roomRef.current;
      const micTrack = activeRoom?.localParticipant?.getTrackPublication(Track.Source.Microphone)?.track;
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

  // Leave the room if the component unmounts mid-session
  useEffect(() => {
    return () => {
      if (roomRef.current) {
        roomRef.current.disconnect().catch(() => {});
        roomRef.current = null;
      }
    };
  }, []);

  return {
    connectionState,
    connectionQuality,
    room,
    stats,
    error,
    connect,
    disconnect,
  };
}
