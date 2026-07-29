import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ConnectionQuality, ConnectionState } from 'livekit-client';
import { KNOB_STATE_COLORS, knobDisplay, knobState } from '@/lib/knobState';
import { buildConfigExport, configExportFilename } from '@/lib/configExport';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Clock,
  Download,
  Gauge,
  KeyRound,
  Loader2,
  MessageSquare,
  Mic,
  Repeat,
  Server,
  Signal,
  SignalHigh,
  SignalLow,
  SignalMedium,
  Sparkles,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react';
import { useLiveKitVoice } from '@/hooks/useLiveKitVoice';
import { API_BASE } from '@/lib/apiBase';
import { mintViaServer } from '@/lib/serverMint';

// DEV-ONLY page — Stage 1 WebRTC transport validation.
// Paste a token from `node scripts/generate-livekit-token.js` and compare live
// transport stats against the WebSocket pipeline. Production tokens will be
// issued by a server-side endpoint; this page never sees the API secret.

const URL_STORAGE_KEY = 'livekit-test-url';

// Phase 4 tuning console — the knob set is rendered ENTIRELY from the agent's
// agent_config broadcast (metadata + config = agent truth), keyed by engine.
// A tts agent shows tts knobs, an rvc agent the old set. No knob list, no
// ranges, and no engine assumptions are baked in here.

// Group broadcast metadata into ordered [{group, timing, knobs}] sections.
function groupKnobs(metadata) {
  const groups = [];
  const at = new Map();
  for (const knob of metadata || []) {
    if (!at.has(knob.group)) {
      at.set(knob.group, groups.length);
      groups.push({ group: knob.group, timing: knob.timing, knobs: [] });
    }
    groups[at.get(knob.group)].knobs.push(knob);
  }
  return groups;
}

// Trigger a client-side JSON download (no server round trip).
function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}

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

// Compact ms readout for the transcript panel: rounded, or an em dash if absent.
function fmtMs(value) {
  return value == null ? '—' : `${Math.round(value)}ms`;
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

// One tuning knob — rendered purely from broadcast metadata (kind + range +
// per-model support). Sliders/selects/toggles show the REQUESTED value; the
// badge renders ONLY the agent-confirmed applied value (green match / amber
// mismatch / muted unknown). A setting the current model doesn't support is
// DISABLED with the reason — never silently ignored.
function KnobRow({ knob, applied, requested, disabled, reason, onEdit, onCommit }) {
  const state = knobState(requested, applied);
  const labelId = `tuning-label-${knob.name}`;
  const hasLatencyHint = knob.hint && /latenc/i.test(knob.hint);
  const value = requested ?? applied;
  return (
    <div className="flex items-center gap-2">
      <span
        id={labelId}
        title={knob.hint || knob.name}
        className={`w-36 shrink-0 text-[10px] tracking-wide ${disabled ? 'text-[#4A5568]' : 'text-[#94A3B8]'}`}
      >
        {knob.label}
        {hasLatencyHint && (
          <Zap size={9} className="inline ml-1 -mt-0.5 text-[#F59E0B]" aria-label="documented latency cost" />
        )}
      </span>

      {knob.kind === 'enum' ? (
        <select
          aria-labelledby={labelId}
          value={value ?? knob.choices?.[0]}
          disabled={disabled}
          onChange={(e) => onCommit(knob.name, e.target.value)}
          className="flex-1 bg-[#13131F] border border-[#1A1A2E] rounded-md px-2 py-1 text-[11px] font-mono text-white disabled:opacity-40"
        >
          {(knob.choices || []).map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      ) : knob.kind === 'bool' ? (
        <button
          aria-labelledby={labelId}
          disabled={disabled}
          onClick={() => onCommit(knob.name, !value)}
          className={`flex-1 flex items-center gap-1.5 text-[11px] tracking-wide rounded-md px-3 py-1 transition-colors disabled:opacity-40 ${
            value
              ? 'bg-[#10B981]/15 border border-[#10B981]/40 text-[#10B981]'
              : 'border border-[#1A1A2E] text-[#64748B]'
          }`}
        >
          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: value ? '#10B981' : '#4A5568' }} />
          {value ? 'on' : 'off'}
        </button>
      ) : (
        <input
          type="range"
          aria-labelledby={labelId}
          min={knob.lo}
          max={knob.hi}
          step={knob.step}
          value={value ?? knob.lo}
          disabled={disabled}
          onChange={(e) => onEdit(knob.name, Number(e.target.value))}
          onPointerUp={(e) => onCommit(knob.name, Number(e.currentTarget.value))}
          onKeyUp={(e) => {
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
                 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
              onCommit(knob.name, Number(e.currentTarget.value));
            }
          }}
          className="flex-1 accent-[#6366F1] disabled:opacity-40"
        />
      )}

      <span className="w-10 text-right text-[10px] font-mono text-[#64748B]">
        {knob.kind === 'float' ? (value ?? '—') : ''}
      </span>
      {disabled ? (
        <span
          title={reason}
          className="w-16 text-right text-[9px] font-mono text-[#F59E0B] truncate"
        >
          n/a
        </span>
      ) : (
        <span
          title={
            state === 'unknown'
              ? `${knob.name}: awaiting agent confirmation`
              : `${knob.name}: agent applied ${knobDisplay(applied)}`
          }
          className="w-16 text-right text-[10px] font-mono"
          style={{ color: KNOB_STATE_COLORS[state] }}
        >
          {state === 'mismatch' && '⚠'}
          {knobDisplay(applied)}
        </span>
      )}
    </div>
  );
}

// DEV-ONLY convenience: prefill the SERVER URL from the query string so a
// ready-to-use test link can be handed over.
//
// The token is deliberately NOT prefillable. It is a bearer credential, and a
// query string is the worst place to put one: it persists in browser history,
// gets copied into chat when someone shares "the link", and shows up in
// proxy/analytics logs and referrer headers. The convenience was not worth the
// leak surface. Use the server-mint panel below, or paste the token by hand.
function paramOr(name, fallback) {
  if (typeof window === 'undefined') return fallback;
  return new URLSearchParams(window.location.search).get(name) || fallback;
}

export default function LiveKitTest() {
  const [url, setUrl] = useState(
    () => paramOr('url', localStorage.getItem(URL_STORAGE_KEY) || ''));
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
    utterances,
    connect,
    disconnect,
    enableAudio,
    requestAgentMode,
    requestAgentConfig,
    setCaptureConstraint,
  } = useLiveKitVoice(url.trim(), token.trim());

  // Knob groups rendered from agent truth, keyed by the broadcast engine.
  const knobGroups = useMemo(
    () => groupKnobs(agentConfig?.metadata),
    [agentConfig?.metadata],
  );
  const currentModel = agentConfig?.config?.tts_model;

  const handleExport = () => {
    const payload = buildConfigExport(agentConfig);
    if (payload) downloadJSON(payload, configExportFilename(agentConfig));
  };

  // Local slider positions = REQUESTED values; confirmed badges render only
  // from agentConfig.config (the applied-truth pattern from Phase 2)
  const [knobEdits, setKnobEdits] = useState({});

  // Server-mint path — only surfaces when VITE_API_BASE is set. Password →
  // /api/admin/verify → /api/livekit/token, auto-filling the URL + token
  // fields above. Manual paste stays the dev fallback, so a drill never
  // depends on the Worker being up.
  const apiConfigured = Boolean(API_BASE);
  const [adminPassword, setAdminPassword] = useState('');
  const [mintRoom, setMintRoom] = useState('luminastream-test');
  const [mintIdentity, setMintIdentity] = useState('test-user');
  const [adminToken, setAdminToken] = useState('');
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState('');
  const [mintNotice, setMintNotice] = useState('');

  const status = STATUS[connectionState] || STATUS[ConnectionState.Disconnected];
  const quality = QUALITY[connectionQuality] || QUALITY[ConnectionQuality.Unknown];
  const isDisconnected = connectionState === ConnectionState.Disconnected;
  const canConnect = isDisconnected && url.trim() && token.trim();
  const micLive = room?.localParticipant?.isMicrophoneEnabled;

  const handleConnect = () => {
    localStorage.setItem(URL_STORAGE_KEY, url.trim());
    connect();
  };

  const canMint =
    apiConfigured &&
    isDisconnected &&
    !minting &&
    Boolean(mintRoom.trim()) &&
    Boolean(mintIdentity.trim()) &&
    Boolean(adminPassword || adminToken);

  const handleMintViaServer = async () => {
    setMinting(true);
    setMintError('');
    setMintNotice('');
    try {
      const identity = mintIdentity.trim();
      const {
        token: lkToken,
        url: lkUrl,
        adminToken: session,
      } = await mintViaServer({
        password: adminPassword,
        adminToken,
        room: mintRoom.trim(),
        identity,
      });
      setAdminToken(session);
      if (lkUrl) setUrl(lkUrl);
      setToken(lkToken);
      setAdminPassword(''); // don't keep the password around once it's exchanged
      setMintNotice(`token minted for ${identity} — ready to connect`);
    } catch (err) {
      if (err.status === 401) setAdminToken(''); // stale session → force re-auth next time
      setMintError(err.message || 'mint failed');
    } finally {
      setMinting(false);
    }
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

          {/* Server-mint path — only when VITE_API_BASE is set. The manual URL
              + token fields above remain the dev fallback so drills never
              depend on the Worker being up. */}
          {apiConfigured && (
            <div className="mt-6 pt-5 border-t border-[#1A1A2E]">
              <div className="flex items-center gap-2 mb-3">
                <Server size={13} className="text-[#6366F1]" />
                <h3 className="text-[11px] tracking-widest uppercase text-[#64748B]">
                  Mint via server
                </h3>
                <span className="text-[9px] text-[#4A5568] ml-auto">
                  manual paste above stays the dev fallback
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="block text-[10px] tracking-widest uppercase text-[#64748B] mb-1.5">
                    Room
                  </label>
                  <input
                    type="text"
                    value={mintRoom}
                    onChange={(e) => setMintRoom(e.target.value)}
                    disabled={!isDisconnected || minting}
                    className="w-full bg-[#13131F] border border-[#1A1A2E] rounded-md px-3 py-2 text-xs font-mono text-white placeholder-[#4A5568] focus:outline-none focus:border-[#6366F1] disabled:opacity-50"
                  />
                </div>
                <div>
                  <label className="block text-[10px] tracking-widest uppercase text-[#64748B] mb-1.5">
                    Identity
                  </label>
                  <input
                    type="text"
                    value={mintIdentity}
                    onChange={(e) => setMintIdentity(e.target.value)}
                    disabled={!isDisconnected || minting}
                    className="w-full bg-[#13131F] border border-[#1A1A2E] rounded-md px-3 py-2 text-xs font-mono text-white placeholder-[#4A5568] focus:outline-none focus:border-[#6366F1] disabled:opacity-50"
                  />
                </div>
              </div>

              <label className="block text-[10px] tracking-widest uppercase text-[#64748B] mb-1.5">
                Admin password
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="password"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && canMint) handleMintViaServer();
                  }}
                  disabled={!isDisconnected || minting}
                  placeholder={
                    adminToken ? 'session active — re-enter only if it expires' : 'admin password'
                  }
                  autoComplete="off"
                  className="flex-1 bg-[#13131F] border border-[#1A1A2E] rounded-md px-3 py-2 text-xs font-mono text-white placeholder-[#4A5568] focus:outline-none focus:border-[#6366F1] disabled:opacity-50"
                />
                <button
                  onClick={handleMintViaServer}
                  disabled={!canMint}
                  className="flex items-center gap-1.5 bg-[#6366F1] hover:bg-[#818CF8] disabled:opacity-40 disabled:hover:bg-[#6366F1] text-white text-xs tracking-wide rounded-md px-5 py-2 transition-colors whitespace-nowrap"
                >
                  {minting ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <KeyRound size={13} />
                  )}
                  {minting ? 'Minting…' : 'Mint via server'}
                </button>
              </div>

              {mintError && (
                <div className="mt-3 flex items-start gap-2 text-xs text-[#EF4444] border border-[#EF4444]/30 bg-[#EF4444]/5 rounded-md p-3">
                  <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                  <span>{mintError}</span>
                </div>
              )}
              {mintNotice && !mintError && (
                <p className="mt-3 text-[11px] text-[#10B981]">{mintNotice}</p>
              )}

              <p className="mt-3 text-[9px] text-[#4A5568] leading-relaxed">
                Password → server verifies (constant-time) → LiveKit token minted server-side
                (≤6h) and auto-filled above. The LiveKit secret never reaches the browser.
              </p>
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

        {/* Tuning console (Phase 4) — dev instrument, not product UI. Knob
            groups render ENTIRELY from the agent's agent_config broadcast,
            keyed by engine (tts vs rvc). Controls show the REQUESTED value; the
            badge renders ONLY the agent-confirmed applied value (green match /
            amber mismatch / muted unknown). A setting the current model doesn't
            support is DISABLED with the reason, never silently ignored. */}
        <div className="bg-[#0F0F1A] border border-[#1A1A2E] rounded-lg p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[11px] tracking-widest uppercase text-[#64748B]">
              Tuning
              {agentConfig?.engine && (
                <span className="ml-2 normal-case tracking-normal text-[#6366F1]">
                  {agentConfig.engine} engine
                </span>
              )}
              <span className="ml-2 normal-case tracking-normal text-[#4A5568]">
                agent-confirmed values only
              </span>
            </h2>
            <div className="flex items-center gap-2">
              <button
                onClick={handleExport}
                disabled={!agentConfig?.config}
                title="Download the agent-confirmed config as JSON — commit it as agent/tts_profile.json to lock it in"
                className="flex items-center gap-1.5 border border-[#1A1A2E] text-[#94A3B8] hover:border-[#10B981]/50 disabled:opacity-40 text-[10px] tracking-wide rounded-md px-3 py-1.5 transition-colors"
              >
                <Download size={12} /> Export JSON
              </button>
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
          </div>

          {knobGroups.length === 0 ? (
            <p className="text-[11px] text-[#64748B]">
              {isDisconnected ? 'Connect to an agent to tune.' : 'Awaiting agent config broadcast…'}
            </p>
          ) : (
            knobGroups.map((group) => (
              <div key={group.group} className="mb-4 last:mb-0">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[9px] tracking-widest uppercase text-[#64748B]">
                    {group.group}
                  </span>
                  <span className="text-[9px] text-[#4A5568] normal-case tracking-normal">
                    applies {group.timing}
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2.5">
                  {group.knobs.map((knob) => {
                    const applied = agentConfig?.config?.[knob.name];
                    const requested = knobEdits[knob.name] ?? applied;
                    const reason = knob.unsupported_models?.[currentModel];
                    const disabled = isDisconnected || Boolean(reason);
                    return (
                      <KnobRow
                        key={knob.name}
                        knob={knob}
                        applied={applied}
                        requested={requested}
                        disabled={disabled}
                        reason={reason ? `${reason} (model ${currentModel})` : undefined}
                        onEdit={(name, val) =>
                          setKnobEdits((prev) => ({ ...prev, [name]: val }))
                        }
                        onCommit={(name, val) => {
                          setKnobEdits((prev) => ({ ...prev, [name]: val }));
                          requestAgentConfig({ [name]: val });
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            ))
          )}

          {agentConfig?.rejected && (
            <p className="mt-3 text-[9px] text-[#F59E0B]">
              rejected by agent: {Object.entries(agentConfig.rejected)
                .map(([k, v]) => `${k} (${v})`).join(' · ')}
            </p>
          )}
          <p className="mt-3 text-[9px] text-[#4A5568]">
            <Zap size={9} className="inline -mt-0.5 text-[#F59E0B]" /> marks a documented latency cost.
            A/B method: change ONE knob, speak the fixed script, score, revert.
            Export &amp; commit agent/tts_profile.json to lock a profile in.
          </p>
        </div>

        {/* Live transcript (VPS-drill addendum) — per utterance: what STT heard
            plus the timing breakdown, streamed over the data channel. The CEO
            tunes VAD + voice settings BY EAR against this evidence. Applied
            truth: everything here is agent-reported, never inferred here. */}
        {agentConfig?.engine === 'tts' && (
          <div className="bg-[#0F0F1A] border border-[#1A1A2E] rounded-lg p-6 mb-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[11px] tracking-widest uppercase text-[#64748B]">
                <MessageSquare size={11} className="inline -mt-0.5 mr-1.5 text-[#6366F1]" />
                Live Transcript
                <span className="ml-2 normal-case tracking-normal text-[#4A5568]">
                  what STT heard · newest first
                </span>
              </h2>
              {utterances.length > 0 && (
                <span className="text-[9px] text-[#4A5568]">{utterances.length} shown</span>
              )}
            </div>
            {utterances.length === 0 ? (
              <p className="text-[11px] text-[#64748B]">
                No utterances yet — speak in convert mode and each one appears here.
              </p>
            ) : (
              <div className="space-y-1.5 max-h-80 overflow-y-auto">
                {utterances.map((u) => (
                  <div
                    key={u.index}
                    className={`text-[11px] rounded-md px-3 py-2 border ${
                      u.dropped
                        ? 'border-[#F59E0B]/30 bg-[#F59E0B]/5'
                        : 'border-[#1A1A2E] bg-[#13131F]'
                    }`}
                  >
                    {u.dropped ? (
                      <div className="flex items-start gap-2 text-[#F59E0B]">
                        <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                        <span>
                          #{u.index} dropped ({u.reason})
                          {u.detail && <span className="text-[#94A3B8]"> — {u.detail}</span>}
                        </span>
                      </div>
                    ) : (
                      <>
                        <p className="text-white leading-snug">
                          <span className="text-[#4A5568] mr-1.5">#{u.index}</span>
                          {u.transcript || <span className="text-[#64748B] italic">(empty)</span>}
                        </p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px] font-mono text-[#64748B]">
                          <span style={{ color: thresholdColor(u.stt_ms, 400, 800) }}>stt {fmtMs(u.stt_ms)}</span>
                          <span style={{ color: thresholdColor(u.tts_ttfb_ms, 400, 800) }}>ttfb {fmtMs(u.tts_ttfb_ms)}</span>
                          <span style={{ color: thresholdColor(u.tail_latency_ms, 1000, 1500) }}>tail {fmtMs(u.tail_latency_ms)}</span>
                          <span>{u.chars ?? '—'} chars</span>
                          <span className="text-[#4A5568]">{u.model_id}</span>
                          {typeof u.wer === 'number' && <span>wer {u.wer.toFixed(2)}</span>}
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

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
          without touching it. Generate a token with{' '}
          <code className="text-[#64748B]">node scripts/generate-livekit-token.js</code> and paste
          it, or — when <code className="text-[#64748B]">VITE_API_BASE</code> is set — use{' '}
          <span className="text-[#94A3B8]">Mint via server</span> above, the production path that
          keeps the LiveKit secret server-side.
        </p>
      </div>
    </div>
  );
}
