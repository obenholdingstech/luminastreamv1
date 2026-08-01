import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ConnectionState, Track } from 'livekit-client';
import { AlertTriangle, KeyRound, Loader2, Mic, Power, SlidersHorizontal, Volume2 } from 'lucide-react';

import { useLiveKitVoice } from '@/hooks/useLiveKitVoice';
import { useMicLevel } from '@/hooks/useMicLevel';
import { API_BASE } from '@/lib/apiBase';
import { LENS_MODES, agentModeFor, deriveLensStatus, medianTailMs } from '@/lib/lensState';
import { getSessionIdentity } from '@/lib/sessionIdentity';
import { mintViaServer } from '@/lib/serverMint';

// The product surface: LuminaStream as a lens.
//
// This page and /livekit-test drive the SAME engine through the SAME hook. The
// difference is what each one is for. The console exposes every knob the agent
// broadcasts, in the agent's own vocabulary, because tuning requires seeing the
// machine. This page exposes one decision — Direct or Converted — and one
// action, because using the lens should not require understanding it.
//
// Nothing here is a second source of truth. Mode is whatever the agent
// CONFIRMED (agent_mode), status is derived from agent-reported state in
// lensState.js, and latency is the agent's own measurement. When the agent has
// not spoken, this page says so rather than guessing.

// The room the VPS agent joins by default (convert_agent.py DEFAULT_ROOM).
// Overridable at build time for a second concurrent session; per-session rooms
// arrive with /api/session/create, which retires this constant.
const ROOM = import.meta.env?.VITE_LIVEKIT_ROOM || 'luminastream-test';

const TONE = {
  idle: { color: '#64748B', glow: 'rgba(100,116,139,0.18)' },
  working: { color: '#6366F1', glow: 'rgba(99,102,241,0.30)' },
  live: { color: '#10B981', glow: 'rgba(16,185,129,0.34)' },
  warn: { color: '#F59E0B', glow: 'rgba(245,158,11,0.30)' },
  error: { color: '#EF4444', glow: 'rgba(239,68,68,0.30)' },
};

// The lens itself. Three concentric rings over a soft core; the outermost is
// driven by live microphone amplitude through the --level custom property, so
// speaking visibly moves it without React re-rendering a single component.
function Lens({ tone, spinning, reduceMotion, levelHostRef }) {
  const { color, glow } = TONE[tone] ?? TONE.idle;
  return (
    <div
      ref={levelHostRef}
      className="relative flex items-center justify-center"
      // A CSS custom property is not in React's CSSProperties map; the cast
      // is the standard way to set one without loosening the whole style.
      style={/** @type {any} */ ({ '--level': 0, width: 260, height: 260 })}
    >
      {/* Amplitude halo — scale and opacity both ride --level so a quiet room
          settles to nothing rather than sitting at a permanent glow. */}
      <div
        aria-hidden
        className="absolute rounded-full"
        style={{
          width: 260,
          height: 260,
          background: `radial-gradient(circle, ${glow} 0%, transparent 68%)`,
          transform: 'scale(calc(0.82 + (var(--level) * 0.34)))',
          opacity: 'calc(0.35 + (var(--level) * 0.65))',
          transition: 'background 600ms ease',
        }}
      />

      {/* Static rim */}
      <div
        aria-hidden
        className="absolute rounded-full"
        style={{
          width: 190,
          height: 190,
          border: `1px solid ${color}`,
          opacity: 0.28,
          transition: 'border-color 600ms ease',
        }}
      />

      {/* Amplitude rim — the one that answers your voice */}
      <div
        aria-hidden
        className="absolute rounded-full"
        style={{
          width: 190,
          height: 190,
          border: `1.5px solid ${color}`,
          transform: 'scale(calc(1 + (var(--level) * 0.18)))',
          opacity: 'calc(0.20 + (var(--level) * 0.80))',
          transition: 'border-color 600ms ease',
        }}
      />

      {/* Connecting arc — a single rotating quadrant. Rendered only while the
          session is being established, and never when the viewer has asked
          for reduced motion. */}
      {spinning && !reduceMotion && (
        <motion.div
          aria-hidden
          className="absolute rounded-full"
          style={{
            width: 216,
            height: 216,
            border: '1.5px solid transparent',
            borderTopColor: color,
          }}
          animate={{ rotate: 360 }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'linear' }}
        />
      )}

      {/* Core */}
      <div
        aria-hidden
        className="rounded-full"
        style={{
          width: 96,
          height: 96,
          background: `radial-gradient(circle at 38% 32%, ${color}44, #0B0A16 72%)`,
          border: `1px solid ${color}33`,
          transform: 'scale(calc(1 + (var(--level) * 0.10)))',
          transition: 'background 600ms ease, border-color 600ms ease',
        }}
      />
    </div>
  );
}

function Stat({ label, value, unit = null }) {
  return (
    <div className="flex flex-col items-center gap-1 px-5">
      <span className="text-[9px] tracking-[0.2em] uppercase text-[#4A5568]">{label}</span>
      <span className="text-sm font-light text-[#E2E8F0] tabular-nums">
        {value ?? '—'}
        {value != null && unit && <span className="text-[10px] text-[#64748B] ml-0.5">{unit}</span>}
      </span>
    </div>
  );
}

export default function Studio() {
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');

  const {
    connectionState,
    room,
    error,
    audioBlocked,
    agentMode,
    agentModeReason,
    agentBusy,
    utterances,
    connect,
    disconnect,
    enableAudio,
    requestAgentMode,
  } = useLiveKitVoice(url, token);

  // ── access ────────────────────────────────────────────────────────────
  // Dev-stage gate. The Worker's admin session is the only server-side
  // authority that exists today, so it is what stands between a browser and a
  // LiveKit token. It is NOT the product's access model: subscription (access)
  // plus prepaid wallet (usage), both enforced server-side, arrive with
  // /api/session/create. Nothing here mints anything client-side — the browser
  // never holds a LiveKit API secret, before or after that change.
  const apiConfigured = Boolean(API_BASE);
  const [accessKey, setAccessKey] = useState('');
  const [adminToken, setAdminToken] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState('');

  // Lazy initializer so sessionStorage is read once, not on every render. A
  // literal shared identity is what made a second listener evict the first.
  const [identity] = useState(() => getSessionIdentity('studio'));

  const [lensMode, setLensMode] = useState('converted');

  const isDisconnected = connectionState === ConnectionState.Disconnected;
  const hasCredentials = Boolean(url && token);

  const status = useMemo(
    () => deriveLensStatus({ connectionState, agentMode, agentBusy, audioBlocked, error }),
    [connectionState, agentMode, agentBusy, audioBlocked, error],
  );
  const latencyMs = useMemo(() => medianTailMs(utterances), [utterances]);

  // ── the lens ring's amplitude source ──────────────────────────────────
  const levelHostRef = useRef(null);
  const micTrack = room?.localParticipant
    ?.getTrackPublication(Track.Source.Microphone)
    ?.audioTrack?.mediaStreamTrack;
  const reduceMotion = useReducedMotion();
  const paintLevel = useCallback((level) => {
    levelHostRef.current?.style.setProperty('--level', String(level));
  }, []);
  // Reduced motion is honoured by not building the audio graph at all, rather
  // than by building it and discarding every frame. A viewer who asked for a
  // still interface should not also pay for an AudioContext and a 60 Hz
  // animation frame loop to produce a number nothing reads.
  useMicLevel(reduceMotion ? null : (micTrack ?? null), paintLevel);

  const unlock = async (event) => {
    event?.preventDefault();
    if (unlocking) return;
    setUnlocking(true);
    setUnlockError('');
    try {
      const {
        token: lkToken,
        url: lkUrl,
        adminToken: session,
      } = await mintViaServer({
        password: accessKey,
        adminToken,
        room: ROOM,
        identity,
      });
      setAdminToken(session);
      setUrl(lkUrl);
      setToken(lkToken);
      setAccessKey(''); // exchanged — no reason to keep it in memory
    } catch (err) {
      if (err.status === 401) setAdminToken('');
      setUnlockError(err.message || 'could not unlock');
    } finally {
      setUnlocking(false);
    }
  };

  // The agent is the source of truth for mode, so the selector only ever
  // REQUESTS. While connected, a click goes on the wire; while disconnected it
  // is remembered and sent once the agent confirms it has joined.
  const chooseMode = (id) => {
    setLensMode(id);
    if (!isDisconnected) {
      const wire = agentModeFor(id);
      if (wire) requestAgentMode(wire);
    }
  };

  // On connect the agent announces whatever mode IT started in. Push the
  // user's choice once, and only when it actually differs — re-sending a mode
  // the agent already holds would make the "reason" field flap for no reason.
  const pushedRef = useRef(false);
  useEffect(() => {
    if (isDisconnected) {
      pushedRef.current = false;
      return;
    }
    if (pushedRef.current || !agentMode) return;
    pushedRef.current = true;
    const wire = agentModeFor(lensMode);
    if (wire && wire !== agentMode) requestAgentMode(wire);
  }, [isDisconnected, agentMode, lensMode, requestAgentMode]);

  const tone = TONE[status.tone] ?? TONE.idle;
  const activeMode = LENS_MODES.find((m) => m.id === lensMode) ?? LENS_MODES[0];

  return (
    <div className="min-h-screen bg-[#08080F] text-white flex flex-col">
      {/* Ambient ground — a single soft wash, tinted by the current tone. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0"
        style={{
          background: `radial-gradient(120% 70% at 50% -10%, ${tone.glow} 0%, transparent 60%)`,
          transition: 'background 900ms ease',
        }}
      />

      <header className="relative flex items-center justify-between px-6 sm:px-10 py-6">
        <div className="flex items-baseline gap-3">
          <span className="text-[13px] tracking-[0.42em] uppercase text-white/90">Lumina</span>
          <span className="text-[13px] tracking-[0.42em] uppercase text-white/35">Stream</span>
        </div>
        <Link
          to="/livekit-test"
          className="flex items-center gap-2 text-[10px] tracking-[0.16em] uppercase text-[#4A5568] hover:text-[#94A3B8] transition-colors"
        >
          <SlidersHorizontal size={12} />
          Console
        </Link>
      </header>

      <main className="relative flex-1 flex flex-col items-center justify-center px-6 pb-16">
        <Lens
          tone={status.tone}
          spinning={status.tone === 'working'}
          reduceMotion={reduceMotion}
          levelHostRef={levelHostRef}
        />

        {/* Status. aria-live so the state change is announced, not just seen —
            this is the one piece of text that tells you whether your voice is
            actually going anywhere. */}
        <div className="mt-8 min-h-16 text-center" role="status" aria-live="polite">
          {/* initial={false} is load-bearing, not a preference. With the enter
              animation armed on first mount, this block renders at opacity 0
              and only becomes visible once framer-motion's first frame lands —
              so anything that delays or breaks that frame leaves the single
              piece of text that says whether your voice is reaching the room
              invisible, with no error anywhere. Verified: headless Chrome
              screenshots the page with `opacity: 0` on this node. Status
              CHANGES still animate; the first one is simply already there. */}
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={status.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: reduceMotion ? 0 : 0.24 }}
            >
              <p
                className="text-base font-light tracking-wide"
                style={{ color: tone.color }}
              >
                {status.label}
              </p>
              <p className="mt-1 text-[11px] text-[#64748B] max-w-sm mx-auto leading-relaxed">
                {status.detail}
                {agentModeReason && status.tone === 'live' && (
                  <span className="text-[#F59E0B]"> ({agentModeReason})</span>
                )}
              </p>
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Mode. Both options are always visible — this is the product's one
            real decision, and hiding it behind a toggle would make it feel
            incidental. The ring marks the user's REQUEST; the check marks what
            the agent confirmed. They differ, briefly, on every switch. */}
        <div className="mt-6 flex items-center gap-2 p-1 rounded-full border border-[#1A1A2E] bg-[#0C0C16]">
          {LENS_MODES.map((mode) => {
            const selected = mode.id === lensMode;
            const confirmed = agentMode === mode.agentMode;
            return (
              <button
                key={mode.id}
                onClick={() => chooseMode(mode.id)}
                aria-pressed={selected}
                className="relative px-6 py-2 rounded-full text-[11px] tracking-[0.14em] uppercase transition-colors"
                style={{ color: selected ? '#FFFFFF' : '#64748B' }}
              >
                {selected && (
                  <motion.span
                    layoutId="mode-pill"
                    className="absolute inset-0 rounded-full"
                    style={{ backgroundColor: '#161626', border: `1px solid ${tone.color}44` }}
                    transition={{ duration: reduceMotion ? 0 : 0.28, ease: [0.32, 0.72, 0, 1] }}
                  />
                )}
                <span className="relative flex items-center gap-1.5">
                  {mode.label}
                  {confirmed && !isDisconnected && (
                    <span
                      className="w-1 h-1 rounded-full"
                      style={{ backgroundColor: '#10B981' }}
                      title="confirmed by the agent"
                    />
                  )}
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-[11px] text-[#4A5568] text-center max-w-xs leading-relaxed">
          {activeMode.blurb}
        </p>

        {/* Action */}
        <div className="mt-10 w-full max-w-sm">
          {hasCredentials ? (
            <button
              onClick={isDisconnected ? connect : disconnect}
              disabled={connectionState === ConnectionState.Connecting}
              className="w-full flex items-center justify-center gap-2.5 rounded-full py-3.5 text-[11px] tracking-[0.2em] uppercase transition-all disabled:opacity-50"
              style={
                isDisconnected
                  ? { backgroundColor: '#FFFFFF', color: '#08080F' }
                  : { border: '1px solid #1A1A2E', color: '#94A3B8' }
              }
            >
              {connectionState === ConnectionState.Connecting ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Power size={13} />
              )}
              {isDisconnected ? 'Start the lens' : 'Stop'}
            </button>
          ) : apiConfigured ? (
            <form onSubmit={unlock} className="flex flex-col gap-2.5">
              <label
                htmlFor="access-key"
                className="text-[9px] tracking-[0.2em] uppercase text-[#4A5568] text-center"
              >
                Early access key
              </label>
              <div className="flex gap-2">
                <input
                  id="access-key"
                  type="password"
                  autoComplete="current-password"
                  value={accessKey}
                  onChange={(e) => setAccessKey(e.target.value)}
                  placeholder="••••••••"
                  className="flex-1 min-w-0 bg-[#0C0C16] border border-[#1A1A2E] rounded-full px-5 py-3 text-sm text-white placeholder:text-[#2E2E44] focus:outline-none focus:border-[#6366F1]/60 transition-colors"
                />
                <button
                  type="submit"
                  disabled={unlocking || !accessKey}
                  className="flex items-center gap-2 rounded-full px-6 text-[11px] tracking-[0.16em] uppercase bg-white text-[#08080F] disabled:opacity-40 transition-opacity"
                >
                  {unlocking ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />}
                  Unlock
                </button>
              </div>
              {unlockError && (
                <p className="flex items-center justify-center gap-1.5 text-[11px] text-[#EF4444]">
                  <AlertTriangle size={11} /> {unlockError}
                </p>
              )}
            </form>
          ) : (
            <p className="text-[11px] text-[#64748B] text-center leading-relaxed">
              No API is configured for this build (<span className="font-mono">VITE_API_BASE</span>{' '}
              is unset), so there is nowhere to get a session from. The{' '}
              <Link to="/livekit-test" className="text-[#6366F1] hover:underline">
                console
              </Link>{' '}
              accepts a hand-pasted token.
            </p>
          )}
        </div>

        {/* Blocked playback is a click away from fixed, so offer the click. */}
        {audioBlocked && (
          <button
            onClick={enableAudio}
            className="mt-4 flex items-center gap-2 text-[11px] tracking-wide text-[#F59E0B] border border-[#F59E0B]/40 rounded-full px-4 py-2 hover:bg-[#F59E0B]/10 transition-colors"
          >
            <Volume2 size={12} /> Enable audio playback
          </button>
        )}

        {/* Live strip — only while there is something real to report. */}
        <AnimatePresence>
          {!isDisconnected && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: reduceMotion ? 0 : 0.3 }}
              className="mt-10 flex items-stretch divide-x divide-[#161626] border border-[#161626] rounded-xl bg-[#0B0B14]/70 py-3"
            >
              <Stat label="Latency" value={latencyMs} unit="ms" />
              <Stat label="Utterances" value={utterances.length || null} />
              <div className="flex flex-col items-center gap-1 px-5">
                <span className="text-[9px] tracking-[0.2em] uppercase text-[#4A5568]">Mic</span>
                <span
                  className="flex items-center gap-1.5 text-sm font-light"
                  style={{ color: micTrack ? '#10B981' : '#64748B' }}
                >
                  <Mic size={12} /> {micTrack ? 'live' : 'off'}
                </span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <footer className="relative px-6 sm:px-10 py-5 text-center text-[10px] text-[#2E2E44] tracking-wide">
        Session <span className="font-mono text-[#4A5568]">{identity}</span> · room{' '}
        <span className="font-mono text-[#4A5568]">{ROOM}</span>
      </footer>
    </div>
  );
}
