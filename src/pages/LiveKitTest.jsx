import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ConnectionQuality, ConnectionState } from 'livekit-client';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Clock,
  Gauge,
  Mic,
  Signal,
  SignalHigh,
  SignalLow,
  SignalMedium,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useLiveKitVoice } from '@/hooks/useLiveKitVoice';

// DEV-ONLY page — Stage 1 WebRTC transport validation.
// Paste a token from `node scripts/generate-livekit-token.js` and compare live
// transport stats against the WebSocket pipeline. Production tokens will be
// issued by a server-side endpoint; this page never sees the API secret.

const URL_STORAGE_KEY = 'livekit-test-url';

const STATUS = {
  [ConnectionState.Disconnected]: { label: 'Disconnected', color: '#64748B', pulse: false },
  [ConnectionState.Connecting]: { label: 'Connecting…', color: '#F59E0B', pulse: true },
  [ConnectionState.Connected]: { label: 'Connected', color: '#10B981', pulse: true },
  [ConnectionState.Reconnecting]: { label: 'Reconnecting…', color: '#F59E0B', pulse: true },
  [ConnectionState.SignalReconnecting]: { label: 'Reconnecting…', color: '#F59E0B', pulse: true },
};

const QUALITY = {
  [ConnectionQuality.Excellent]: { label: 'Excellent', color: '#10B981', Icon: SignalHigh },
  [ConnectionQuality.Good]: { label: 'Good', color: '#6366F1', Icon: SignalMedium },
  [ConnectionQuality.Poor]: { label: 'Poor', color: '#F59E0B', Icon: SignalLow },
  [ConnectionQuality.Lost]: { label: 'Lost', color: '#EF4444', Icon: WifiOff },
  [ConnectionQuality.Unknown]: { label: '—', color: '#64748B', Icon: Signal },
};

// Same thresholds idea as VoiceMetricsPanel: green ≤ good, amber ≤ ok, red beyond
function thresholdColor(value, good, ok) {
  if (value == null) return '#64748B';
  if (value <= good) return '#10B981';
  if (value <= ok) return '#F59E0B';
  return '#EF4444';
}

function StatTile({ label, value, unit, icon: IconCmp, color }) {
  return (
    <div className="bg-[#13131F] border border-[#1A1A2E] rounded-md p-3">
      <div className="flex items-center gap-1.5 mb-1.5">
        <IconCmp size={11} style={{ color }} />
        <span className="text-[9px] tracking-widest uppercase text-[#64748B]">{label}</span>
      </div>
      <p className="text-lg font-light text-white">
        {value ?? '—'}
        <span className="text-[10px] text-[#64748B] ml-1">{unit}</span>
      </p>
    </div>
  );
}

export default function LiveKitTest() {
  const [url, setUrl] = useState(() => localStorage.getItem(URL_STORAGE_KEY) || '');
  const [token, setToken] = useState('');

  const {
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
  } = useLiveKitVoice(url.trim(), token.trim());

  const status = STATUS[connectionState] || STATUS[ConnectionState.Disconnected];
  const quality = QUALITY[connectionQuality] || QUALITY[ConnectionQuality.Unknown];
  const isDisconnected = connectionState === ConnectionState.Disconnected;
  const canConnect = isDisconnected && url.trim() && token.trim();
  const micLive = room?.localParticipant?.isMicrophoneEnabled;

  const handleConnect = () => {
    localStorage.setItem(URL_STORAGE_KEY, url.trim());
    connect();
  };

  return (
    <div className="min-h-screen bg-[#080810] text-white">
      <div className="max-w-2xl mx-auto px-6 py-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <Link to="/" className="text-[#64748B] hover:text-white transition-colors">
              <ArrowLeft size={18} />
            </Link>
            <h1 className="text-lg font-light tracking-wide">LiveKit WebRTC Test</h1>
            <span className="text-[9px] tracking-widest uppercase text-[#F59E0B] border border-[#F59E0B]/30 rounded px-1.5 py-0.5">
              Dev Only
            </span>
          </div>
          <span className="flex items-center gap-2 text-xs text-[#94A3B8]">
            <span
              className={`w-2 h-2 rounded-full ${status.pulse ? 'animate-pulse' : ''}`}
              style={{ backgroundColor: status.color }}
            />
            {status.label}
            {micLive && (
              <span className="flex items-center gap-1 text-[#10B981]">
                <Mic size={11} /> mic live
              </span>
            )}
            {!isDisconnected &&
              (audioBlocked ? (
                <button
                  onClick={enableAudio}
                  className="flex items-center gap-1 text-[#F59E0B] border border-[#F59E0B]/30 rounded px-1.5 py-0.5 hover:bg-[#F59E0B]/10 transition-colors"
                >
                  <VolumeX size={11} /> remote audio blocked — enable
                </button>
              ) : remoteAudio.length > 0 ? (
                <span className="flex items-center gap-1 text-[#10B981]">
                  <Volume2 size={11} /> remote audio: playing ({remoteAudio[0].identity})
                </span>
              ) : (
                <span className="flex items-center gap-1 text-[#64748B]">
                  <VolumeX size={11} /> remote audio: none
                </span>
              ))}
          </span>
        </div>

        {/* Connection form */}
        <div className="bg-[#0F0F1A] border border-[#1A1A2E] rounded-lg p-6 mb-6">
          <h2 className="text-[11px] tracking-widest uppercase text-[#64748B] mb-4">Connection</h2>

          <label className="block text-[10px] tracking-widest uppercase text-[#64748B] mb-1.5">
            LiveKit URL
          </label>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={!isDisconnected}
            placeholder="wss://your-project.livekit.cloud"
            className="w-full bg-[#13131F] border border-[#1A1A2E] rounded-md px-3 py-2 text-xs font-mono text-white placeholder-[#4A5568] focus:outline-none focus:border-[#6366F1] disabled:opacity-50 mb-4"
          />

          <label className="block text-[10px] tracking-widest uppercase text-[#64748B] mb-1.5">
            Access Token
          </label>
          <textarea
            value={token}
            onChange={(e) => setToken(e.target.value)}
            disabled={!isDisconnected}
            rows={3}
            placeholder="Paste the token printed by: node scripts/generate-livekit-token.js"
            className="w-full bg-[#13131F] border border-[#1A1A2E] rounded-md px-3 py-2 text-xs font-mono text-white placeholder-[#4A5568] focus:outline-none focus:border-[#6366F1] disabled:opacity-50 resize-none mb-4"
          />

          <div className="flex items-center gap-3">
            <button
              onClick={handleConnect}
              disabled={!canConnect}
              className="bg-[#6366F1] hover:bg-[#818CF8] disabled:opacity-40 disabled:hover:bg-[#6366F1] text-white text-xs tracking-wide rounded-md px-5 py-2 transition-colors"
            >
              Connect
            </button>
            <button
              onClick={disconnect}
              disabled={isDisconnected}
              className="border border-[#EF4444]/40 text-[#EF4444] hover:bg-[#EF4444]/10 disabled:opacity-40 disabled:hover:bg-transparent text-xs tracking-wide rounded-md px-5 py-2 transition-colors"
            >
              Disconnect
            </button>
          </div>

          {error && (
            <div className="mt-4 flex items-start gap-2 text-xs text-[#EF4444] border border-[#EF4444]/30 bg-[#EF4444]/5 rounded-md p-3">
              <AlertTriangle size={13} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Live stats */}
        <div className="bg-[#0F0F1A] border border-[#1A1A2E] rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[11px] tracking-widest uppercase text-[#64748B]">
              Transport Stats
            </h2>
            <span className="flex items-center gap-1.5 text-xs" style={{ color: quality.color }}>
              <quality.Icon size={13} />
              <span className="text-[10px] tracking-widest uppercase">
                Quality: {quality.label}
              </span>
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <StatTile
              label="Round-Trip"
              value={stats.rttMs}
              unit="ms"
              icon={Clock}
              color={thresholdColor(stats.rttMs, 150, 300)}
            />
            <StatTile
              label="Jitter"
              value={stats.jitterMs}
              unit="ms"
              icon={Activity}
              color={thresholdColor(stats.jitterMs, 30, 60)}
            />
            <StatTile
              label="Packet Loss"
              value={stats.packetLossPct}
              unit="%"
              icon={Wifi}
              color={thresholdColor(stats.packetLossPct, 1, 3)}
            />
            <StatTile
              label="Bitrate"
              value={stats.bitrateKbps}
              unit="kbps"
              icon={Gauge}
              color="#6366F1"
            />
          </div>

          <div className="flex items-center gap-4 text-[9px] text-[#4A5568]">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-[#10B981]" /> Good
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-[#F59E0B]" /> Tune
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-[#EF4444]" /> Poor
            </span>
            <span className="ml-auto">
              RTT · jitter · loss come from RTCP reports — allow a few seconds after connecting
            </span>
          </div>
        </div>

        <p className="mt-6 text-[10px] text-[#4A5568] leading-relaxed">
          Stage 1 transport validation — runs alongside the existing WebSocket voice pipeline
          without touching it. Generate a 2-hour token with{' '}
          <code className="text-[#64748B]">node scripts/generate-livekit-token.js</code>. In
          production, tokens will be issued by a server-side endpoint.
        </p>
      </div>
    </div>
  );
}
