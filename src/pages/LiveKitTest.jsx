import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ConnectionQuality, ConnectionState } from 'livekit-client';
import { KNOB_STATE_COLORS, knobDisplay, knobState } from '@/lib/knobState';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Clock,
  Gauge,
  Mic,
  Repeat,
  Signal,
  SignalHigh,
  SignalLow,
  SignalMedium,
  Sparkles,
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

// Phase 4 tuning console — display metadata only. Ranges/choices/defaults
// arrive in the agent's agent_config broadcast (agent truth); these
// fallbacks only size the sliders before the first broadcast.
const TUNING_KNOBS = [
  { key: 'index_rate', label: 'Index Rate', step: 0.05, lo: 0, hi: 1 },
  { key: 'protect', label: 'Protect', step: 0.01, lo: 0, hi: 0.5 },
  { key: 'rms_mix_rate', label: 'RMS Mix', step: 0.05, lo: 0, hi: 1 },
  { key: 'f0_method', label: 'F0 Method', choices: ['rmvpe', 'harvest', 'crepe', 'pm'] },
  { key: 'prime_hops', label: 'Prime Depth (hops)', step: 0.1, lo: 0.5, hi: 4 },
  { key: 'vad_threshold', label: 'VAD Threshold', step: 0.05, lo: 0, hi: 1 },
  { key: 'vad_hangover_ms', label: 'VAD Hangover (ms)', step: 50, lo: 0, hi: 2000 },
];

// Phase 2 experiment — browser mic processing toggles. Keys match
// livekit-client's AudioCaptureOptions; all ON is the browser default.
const MIC_PROCESSING = [
  { key: 'noiseSuppression', label: 'Noise Suppression', short: 'NS' },
  { key: 'echoCancellation', label: 'Echo Cancellation', short: 'EC' },
  { key: 'autoGainControl', label: 'Auto Gain', short: 'AGC' },
];

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
    agentMode,
    agentModeReason,
    captureConstraints,
    appliedConstraints,
    agentConfig,
    connect,
    disconnect,
    enableAudio,
    requestAgentMode,
    requestAgentConfig,
    setCaptureConstraint,
  } = useLiveKitVoice(url.trim(), token.trim());

  // Local slider positions = REQUESTED values; confirmed badges render only
  // from agentConfig.config (the applied-truth pattern from Phase 2)
  const [knobEdits, setKnobEdits] = useState({});

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

        {/* Voice mode — talks to the convert agent over the data channel.
            The buttons only REQUEST a mode; the indicator shows what the
            agent CONFIRMED via agent_mode (the agent is the source of truth). */}
        <div className="bg-[#0F0F1A] border border-[#1A1A2E] rounded-lg p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[11px] tracking-widest uppercase text-[#64748B]">Voice Mode</h2>
            <span className="flex items-center gap-3 text-[10px] tracking-widest uppercase">
              {/* APPLIED mic-processing state — strictly what the browser
                  granted (getSettings()), never the requested React state.
                  Amber ⚠ = browser silently ignored a requested constraint. */}
              <span className="flex items-center gap-1.5 font-mono normal-case tracking-normal">
                {MIC_PROCESSING.map(({ key, short }) => {
                  const applied = appliedConstraints?.[key];
                  const requested = captureConstraints[key];
                  if (appliedConstraints == null || applied === undefined) {
                    // no live mic yet, or browser doesn't report this setting
                    return (
                      <span
                        key={key}
                        title={`${key}: ${appliedConstraints == null ? 'no live mic' : 'not reported by browser'}`}
                        className="text-[#64748B]"
                      >
                        {short}–
                      </span>
                    );
                  }
                  const mismatch = applied !== requested;
                  return (
                    <span
                      key={key}
                      title={
                        mismatch
                          ? `${key}: requested ${requested ? 'on' : 'off'} but browser applied ${applied ? 'on' : 'off'}`
                          : `${key}: ${applied ? 'on' : 'off'} (applied)`
                      }
                      style={{ color: mismatch ? '#F59E0B' : applied ? '#10B981' : '#64748B' }}
                    >
                      {mismatch && '⚠'}
                      {short}
                      {applied ? '✓' : '✗'}
                    </span>
                  );
                })}
              </span>
              {agentMode ? (
                <span
                  className="flex items-center gap-1.5"
                  style={{ color: agentMode === 'convert' ? '#10B981' : '#6366F1' }}
                >
                  {agentMode === 'convert' ? <Sparkles size={12} /> : <Repeat size={12} />}
                  Agent mode: {agentMode}
                  {agentModeReason && (
                    <span className="text-[#F59E0B] normal-case tracking-normal">
                      ({agentModeReason})
                    </span>
                  )}
                </span>
              ) : (
                <span className="text-[#64748B]">Agent mode: awaiting agent…</span>
              )}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => requestAgentMode('passthrough')}
              disabled={isDisconnected}
              className={`flex items-center gap-1.5 text-xs tracking-wide rounded-md px-5 py-2 transition-colors disabled:opacity-40 ${
                agentMode === 'passthrough'
                  ? 'bg-[#6366F1] text-white'
                  : 'border border-[#1A1A2E] text-[#94A3B8] hover:border-[#6366F1]/50'
              }`}
            >
              <Repeat size={13} /> Passthrough
            </button>
            <button
              onClick={() => requestAgentMode('convert')}
              disabled={isDisconnected}
              className={`flex items-center gap-1.5 text-xs tracking-wide rounded-md px-5 py-2 transition-colors disabled:opacity-40 ${
                agentMode === 'convert'
                  ? 'bg-[#10B981] text-white'
                  : 'border border-[#1A1A2E] text-[#94A3B8] hover:border-[#10B981]/50'
              }`}
            >
              <Sparkles size={13} /> Convert
            </button>
            <span className="text-[9px] text-[#4A5568] ml-auto">
              passthrough = RVC idle · convert = ~200 ms pipeline
            </span>
          </div>

          {/* Mic processing constraints — applied at publish; toggling while
              connected re-acquires the mic in place (no reconnect needed) */}
          <div className="mt-4 pt-4 border-t border-[#1A1A2E]">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-[10px] tracking-widest uppercase text-[#64748B]">
                Mic Processing
              </span>
              {MIC_PROCESSING.map(({ key, label }) => {
                const on = captureConstraints[key];
                return (
                  <button
                    key={key}
                    onClick={() => setCaptureConstraint(key, !on)}
                    className={`flex items-center gap-1.5 text-[11px] tracking-wide rounded-md px-3 py-1.5 transition-colors ${
                      on
                        ? 'bg-[#10B981]/15 border border-[#10B981]/40 text-[#10B981]'
                        : 'border border-[#1A1A2E] text-[#64748B] hover:border-[#64748B]/50'
                    }`}
                  >
                    <span
                      className="w-1.5 h-1.5 rounded-full"
                      style={{ backgroundColor: on ? '#10B981' : '#4A5568' }}
                    />
                    {label}: {on ? 'on' : 'off'}
                  </button>
                );
              })}
              <span className="text-[9px] text-[#4A5568] ml-auto">
                applies live — mic re-acquired on toggle
              </span>
            </div>
          </div>
        </div>

        {/* Tuning console (Phase 4) — dev instrument, not product UI.
            Sliders/selects show the REQUESTED value; the badge next to each
            renders ONLY the agent-confirmed applied value from agent_config
            (green match / amber mismatch / muted unknown). */}
        <div className="bg-[#0F0F1A] border border-[#1A1A2E] rounded-lg p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[11px] tracking-widest uppercase text-[#64748B]">
              Tuning
              <span className="ml-2 normal-case tracking-normal text-[#4A5568]">
                agent-confirmed values only
              </span>
            </h2>
            <button
              onClick={() => {
                if (agentConfig?.defaults) {
                  setKnobEdits({ ...agentConfig.defaults });
                  requestAgentConfig(agentConfig.defaults);
                }
              }}
              disabled={isDisconnected || !agentConfig?.defaults}
              className="border border-[#1A1A2E] text-[#94A3B8] hover:border-[#6366F1]/50 disabled:opacity-40 text-[10px] tracking-wide rounded-md px-3 py-1.5 transition-colors"
            >
              Revert to defaults
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
            {TUNING_KNOBS.map((knob) => {
              const applied = agentConfig?.config?.[knob.key];
              const range = agentConfig?.ranges?.[knob.key];
              const requested = knobEdits[knob.key] ?? applied;
              const state = knobState(requested, applied);
              const color = KNOB_STATE_COLORS[state];
              const choices = range?.choices ?? knob.choices;
              return (
                <div key={knob.key} className="flex items-center gap-2">
                  <span className="w-36 shrink-0 text-[10px] tracking-wide text-[#94A3B8]">
                    {knob.label}
                  </span>
                  {choices ? (
                    <select
                      value={requested ?? choices[0]}
                      disabled={isDisconnected}
                      onChange={(e) => {
                        setKnobEdits((prev) => ({ ...prev, [knob.key]: e.target.value }));
                        requestAgentConfig({ [knob.key]: e.target.value });
                      }}
                      className="flex-1 bg-[#13131F] border border-[#1A1A2E] rounded-md px-2 py-1 text-[11px] font-mono text-white disabled:opacity-40"
                    >
                      {choices.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="range"
                      min={range?.lo ?? knob.lo}
                      max={range?.hi ?? knob.hi}
                      step={knob.step}
                      value={requested ?? knob.lo}
                      disabled={isDisconnected}
                      onChange={(e) =>
                        setKnobEdits((prev) => ({ ...prev, [knob.key]: Number(e.target.value) }))
                      }
                      onPointerUp={() => {
                        const value = knobEdits[knob.key];
                        if (value !== undefined) requestAgentConfig({ [knob.key]: value });
                      }}
                      className="flex-1 accent-[#6366F1] disabled:opacity-40"
                    />
                  )}
                  <span className="w-12 text-right text-[10px] font-mono text-[#64748B]">
                    {choices ? '' : (requested ?? '—')}
                  </span>
                  <span
                    title={
                      state === 'unknown'
                        ? `${knob.key}: awaiting agent confirmation`
                        : `${knob.key}: agent applied ${knobDisplay(applied)}`
                    }
                    className="w-14 text-right text-[10px] font-mono"
                    style={{ color }}
                  >
                    {state === 'mismatch' && '⚠'}
                    {knobDisplay(applied)}
                  </span>
                </div>
              );
            })}
          </div>
          {agentConfig?.rejected && (
            <p className="mt-3 text-[9px] text-[#F59E0B]">
              rejected by agent: {Object.entries(agentConfig.rejected)
                .map(([k, v]) => `${k} (${v})`).join(' · ')}
            </p>
          )}
          <p className="mt-3 text-[9px] text-[#4A5568]">
            RVC knobs apply mid-stream on the open socket; agent knobs apply instantly.
            A/B method: change ONE knob, speak the fixed script, score, revert.
          </p>
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
