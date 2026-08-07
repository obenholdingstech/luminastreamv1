import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ConnectionState, RoomEvent, Track } from 'livekit-client';
import { AlertTriangle, KeyRound, Loader2, Mic, Power, SlidersHorizontal, Video, Volume2 } from 'lucide-react';

import { AccountPanel } from '@/components/AccountPanel';
import { SURFACE_URLS } from '@/lib/surface';
import { useLiveKitVoice } from '@/hooks/useLiveKitVoice';
import { useAuth } from '@/hooks/useAuth';
import { useMicLevel } from '@/hooks/useMicLevel';
import { useSyncMeter } from '@/hooks/useSyncMeter';
import { useFpsMeter } from '@/hooks/useFpsMeter';
import { API_BASE } from '@/lib/apiBase';
import { LENS_MODES, agentModeFor, deriveLensStatus, medianTailMs } from '@/lib/lensState';
import { endSession, openSession, releaseOnUnload } from '@/lib/sessionClient';
import { PHASE, createSessionHolder } from '@/lib/sessionHolder';
import { VIDEO_PHASE, useLensVideo } from '@/hooks/useLensVideo';
import { createVoiceSelector } from '@/lib/voiceSelection';
import { findLiveRemoteAudioTrack } from '@/lib/remoteAudioTrack';
import { shouldToggleCleanView } from '@/lib/cleanView';
import {
  createAutoStartLatch,
  createVoicePreference,
  crossfadeState,
  isOrphanVideoLeg,
} from '@/lib/unifiedLens';
import { DEFAULT_VIDEO_PATH_MS, VIDEO_PATH_LIMITS, clampVideoPathMs } from '@/lib/alignStage';
import voiceManifest from '@/lib/voiceManifest.json';

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

// There is no room constant here any more. The server allocates one — from a
// pool of rooms an agent is actually serving — along with an identity that
// cannot collide and a grant scoped to both. A room chosen by the client was
// only ever workable while exactly one room existed.

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
      //
      // `--level` must stay a CONSTANT LITERAL here. React only rewrites a
      // style property when its value changed since the last render, and that
      // is the entire reason paintLevel can own this property imperatively.
      // Derive it from state or a prop and every render will clobber the
      // current animation frame — the ring would stutter, not break, which is
      // the kind of bug nobody traces back to this line.
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
    agentConfig,
    requestAgentConfig,
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

  // Every decision about WHEN a slot is claimed and released lives in
  // sessionHolder.js — including the races that made this untestable while it
  // lived here (AGENTS.md: "anything with real logic belongs in src/lib/,
  // because this is the part that can be tested without a browser"). What
  // remains in this component is publishing that state into React and
  // rendering it.
  const [holder] = useState(() =>
    createSessionHolder({
      open: openSession,
      end: endSession,
      beacon: releaseOnUnload,
      onChange: (next) => setHeld(next),
    }),
  );
  const [held, setHeld] = useState(() => holder.snapshot());

  const { adminToken, allocation, error: unlockError } = held;
  const unlocking = held.phase === PHASE.starting;

  const [lensMode, setLensMode] = useState('converted');

  // ── voice selection (CEO directive, 3 Aug 2026) ───────────────────────
  // The machine lives in the agent (dynamic `voice` knob, validated by
  // _switch_voice, broadcast via agent_config) and the request lifecycle
  // lives in src/lib/voiceSelection.js where it is tested — confirmation,
  // rejection-tied-to-its-request, failed sends, disconnect. What remains
  // here is wiring and rendering, per AGENTS.md. The browser never holds
  // the vendor key; ids and labels arrive in the agent's own broadcast.
  const confirmedVoice = agentConfig?.config?.voice ?? null;
  const voiceMeta = agentConfig?.metadata?.voice ?? null;
  const voiceChoices = Array.isArray(voiceMeta?.choices) ? voiceMeta.choices : [];
  // useMemo so the object is referentially stable for the autosave effect's
  // dependency array (exhaustive-deps: a fresh {} per render re-arms it).
  const voiceLabels = useMemo(() => voiceMeta?.choice_labels ?? {}, [voiceMeta]);

  // Pre-start identity (CEO directive, 3 Aug evening): the voice is chosen
  // BEFORE the lens starts. The selector is populated from the agent's live
  // broadcast when there is one, else from the committed manifest (a capture
  // of that same broadcast) — and the choice persists across visits, then
  // keys in the moment the agent confirms the session (the latch below,
  // tested in src/lib/unifiedLens.js). The agent stays the source of truth:
  // its broadcast overrides the manifest, and its confirmation is what the
  // connected selector displays.
  const [chosenVoice, setChosenVoice] = useState(() => {
    try {
      return globalThis.localStorage?.getItem('lens-voice-choice') || null;
    } catch {
      return null; // sandboxed/privacy contexts throw on READ too
    }
  });
  const chooseVoice = useCallback((voiceId) => {
    setChosenVoice(voiceId);
    try {
      globalThis.localStorage?.setItem('lens-voice-choice', voiceId);
    } catch {
      /* private mode — the choice still holds for this visit */
    }
  }, []);
  const liveVoiceList = voiceChoices.length > 0;
  const effectiveVoiceChoices = liveVoiceList
    ? voiceChoices
    : voiceManifest.voices.map((v) => v.id);
  const effectiveVoiceLabels = liveVoiceList
    ? voiceLabels
    : Object.fromEntries(voiceManifest.voices.map((v) => [v.id, v.label]));
  // A stored choice is only a choice while the current list still offers it.
  // A voice deleted from the account (or absent from the agent's live list)
  // would otherwise leave the controlled <select> with no matching option —
  // the browser displays the FIRST entry while the latch requests the ghost.
  // The stored value itself is kept: the list in view changes (manifest
  // pre-connect, broadcast after), and a choice invalid against one may be
  // perfectly valid against the next.
  const validChosenVoice =
    chosenVoice && effectiveVoiceChoices.includes(chosenVoice) ? chosenVoice : null;
  const [voicePref] = useState(() => createVoicePreference());

  const voiceSelector = useMemo(
    () => createVoiceSelector({ publish: requestAgentConfig }),
    [requestAgentConfig],
  );
  const [voiceSel, setVoiceSel] = useState({ requested: null, rejection: null });

  // Every NEW broadcast is offered to the selector — which is what ties a
  // rejection to the request that produced it: snapshots from before the
  // request were consumed before it existed.
  useEffect(() => {
    if (agentConfig) {
      voiceSelector.onBroadcast(agentConfig);
      setVoiceSel(voiceSelector.snapshot());
    }
  }, [agentConfig, voiceSelector]);

  const requestVoice = useCallback(
    async (voiceId) => {
      await voiceSelector.request(voiceId, agentConfig?.config?.voice ?? null);
      setVoiceSel(voiceSelector.snapshot());
    },
    [voiceSelector, agentConfig],
  );

  // Disconnect leaves no pending question — there is no agent to answer it.
  useEffect(() => {
    if (connectionState !== ConnectionState.Connected) {
      voiceSelector.reset();
      setVoiceSel(voiceSelector.snapshot());
    }
  }, [connectionState, voiceSelector]);

  // ── the video leg (P2d) ───────────────────────────────────────────────
  // Independent of the audio session on purpose: video is metered separately
  // (the SpendLedger), costs vendor money per second, and must be startable
  // and stoppable without disturbing a conversation in progress.
  const video = useLensVideo(adminToken);
  const videoElRef = useRef(null);
  const localElRef = useRef(null);
  // RAW PASSTHROUGH (CEO verdict, 6 Aug 2026): Direct mode presents the
  // vendor's stream exactly as it arrives — no elastic delay, no synthesis,
  // no upscale between Decart and the screen. The pipeline's processed
  // stream is Converted mode's; the page picks per confirmed mode, and a
  // mid-session mode switch swaps the element's source instantly.
  const presentingRaw =
    agentMode === agentModeFor('direct') && Boolean(video.rawStream);
  const presentedStream = presentingRaw ? video.rawStream : video.stream;
  useEffect(() => {
    if (videoElRef.current) videoElRef.current.srcObject = presentedStream ?? null;
  }, [presentedStream]);
  useEffect(() => {
    if (localElRef.current) localElRef.current.srcObject = video.localStream ?? null;
  }, [video.localStream]);
  // A DECODED FRAME, not an assigned stream, is what the crossfade waits
  // for: `ontrack` and NEGOTIATION.live arrive in either order, and neither
  // means pixels exist yet. loadeddata is the element's own word for "I have
  // a frame"; readyState covers a stream that decoded before this effect
  // attached. Reset whenever the stream changes — a replaced stream's first
  // frame is a new first frame.
  const [transformedReady, setTransformedReady] = useState(false);
  useEffect(() => {
    setTransformedReady(false);
    const el = videoElRef.current;
    if (!el || !presentedStream) return undefined;
    if (el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      setTransformedReady(true);
      return undefined;
    }
    const ready = () => setTransformedReady(true);
    el.addEventListener('loadeddata', ready);
    return () => el.removeEventListener('loadeddata', ready);
  }, [presentedStream]);
  const fidelity = video.pipeline.describe();
  // The rate of what the element ACTUALLY presents — raw or processed,
  // whichever mode chose. Null renders as nothing; the readout never
  // invents a frame rate.
  const deliveredFps = useFpsMeter(videoElRef, presentedStream);

  // ── A/V sync (P3): audio is the master clock, measured at the ear ─────
  // The sync meter measures the true mouth→ear delay per utterance (local
  // mic onset → remote voice onset, one browser clock); the align stage
  // turns those samples into an elastic video delay, subtracting the video
  // path's own cost. This retargeted the controller (4 Aug): the previous
  // diet was the agent's tail_latency_ms, which misses utterance duration,
  // backlog, and network — the 5/10 "inconsistent" sync. WIRING only — the
  // policy, queue, stage, and meter all live in src/lib/ with their tests.
  // (The feed itself is below, after the meter's state exists.)

  // ── the reference avatar + live prompt (CEO directive, 3 Aug 2026) ────
  // Presentation state only — the work lives in videoClient/videoNegotiator.
  // The avatar is a static identity image Lucy animates with the camera feed;
  // the prompt can restyle it MID-STREAM ("change cloth to blue") without
  // reconnecting, so neither costs a new reservation.
  const [avatar, setAvatar] = useState(null); // { dataUrl, name } | null
  const [avatarError, setAvatarError] = useState('');
  // FileReader is asynchronous: between the pick and onload there is a
  // window where the UI promises an avatar it does not yet hold. The video
  // auto-start waits for this flag — without it, a Start pressed inside
  // that window opened the session with NO reference image, and the latch
  // (correctly) refused a second start to add it.
  const [avatarReading, setAvatarReading] = useState(false);
  const [livePrompt, setLivePrompt] = useState('');
  const [promptApplied, setPromptApplied] = useState(false);
  const avatarInputRef = useRef(null);

  const onAvatarPicked = useCallback(
    (file) => {
      setAvatarError('');
      if (!file) return;
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
        setAvatarError('use a JPEG, PNG, or WebP image');
        return;
      }
      // The vendor wants the reference under ~5 MB as base64; 3.5 MB of file
      // inflates to just under that. Refused here so a too-big pick is a
      // message, never a failed session start.
      if (file.size > 3.5 * 1024 * 1024) {
        setAvatarError('keep the image under 3.5 MB');
        return;
      }
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = String(reader.result ?? '');
        // The pick always sticks — it rides the next start regardless. What
        // must NOT be silent is the live swap's outcome: a refused swap means
        // the stream keeps animating the PREVIOUS identity, and saying
        // nothing would be the UI claiming something the vendor never did.
        setAvatar({ dataUrl, name: file.name });
        setAvatarReading(false);
        if (video.phase === VIDEO_PHASE.live) {
          const ok = await video.updateImage(dataUrl);
          if (!ok) {
            setAvatarError(
              'the live stream kept its previous look — this avatar will apply at the next start',
            );
          }
        }
      };
      // A failed read MUST clear the flag, or the video leg waits forever
      // for an identity that is never coming.
      reader.onerror = () => {
        setAvatarReading(false);
        setAvatarError('the image could not be read — try picking it again');
      };
      setAvatarReading(true);
      reader.readAsDataURL(file);
    },
    [video],
  );

  const clearAvatar = useCallback(() => {
    setAvatar(null);
    // There is no vendor call to REMOVE a reference mid-session, so during a
    // live stream "clear" can only be true of the next session. Say so.
    setAvatarError(
      video.phase === VIDEO_PHASE.live
        ? 'cleared for the next session — the live stream keeps its current identity'
        : '',
    );
  }, [video.phase]);

  const applyPrompt = useCallback(async () => {
    const prompt = livePrompt.trim();
    if (!prompt || video.phase !== VIDEO_PHASE.live) return;
    setPromptApplied(await video.updatePrompt(prompt));
  }, [livePrompt, video]);

  // ── Clean View (CEO directive, 3 Aug 2026) ────────────────────────────
  // Pressing H hides every piece of chrome, leaving only the raw video and
  // the synced audio — the stream exactly as a third-party platform's viewer
  // receives it. The toggle decision (typing guard, chords, auto-repeat)
  // lives in src/lib/cleanView.js with its tests; this is just the listener
  // and a second <video> painting the SAME MediaStream, full-frame and
  // unmasked. The chrome underneath stays MOUNTED — hiding it must never
  // disturb the session or silence the audio.
  const [cleanView, setCleanView] = useState(false);
  const cleanViewElRef = useRef(null);
  const cleanViewRef = useRef(null);
  const restoreFocusRef = useRef(null);
  useEffect(() => {
    const onKey = (event) => {
      if (shouldToggleCleanView(event)) setCleanView((v) => !v);
    };
    globalThis.addEventListener?.('keydown', onKey);
    return () => globalThis.removeEventListener?.('keydown', onKey);
  }, []);
  useEffect(() => {
    if (cleanViewElRef.current) cleanViewElRef.current.srcObject = presentedStream ?? null;
  }, [presentedStream, cleanView]);
  // Hidden must mean INOPERABLE: without this, focus stays on an underlying
  // button and Tab/Enter can press controls the overlay conceals — Stop,
  // invisibly. The chrome goes inert, focus moves into the overlay, and the
  // way back returns focus where it was.
  useEffect(() => {
    if (cleanView) {
      restoreFocusRef.current = document.activeElement;
      cleanViewRef.current?.focus();
    } else if (restoreFocusRef.current instanceof HTMLElement) {
      restoreFocusRef.current.focus();
      restoreFocusRef.current = null;
    }
  }, [cleanView]);
  // React 18 renders boolean `inert` unreliably; the empty-string spread is
  // the documented workaround. Applied to header/main/footer — the overlay is
  // their sibling, so it stays interactive.
  const chromeInert = cleanView ? { inert: '' } : {};

  // Set when credentials arrive, cleared when the connect fires. See `start`.
  const [pendingConnect, setPendingConnect] = useState(false);

  const isDisconnected = connectionState === ConnectionState.Disconnected;
  // Not the same question as "not disconnected". The room object exists during
  // Connecting and Reconnecting, so anything that publishes on the data channel
  // must ask this, not the negation above.
  const isConnected = connectionState === ConnectionState.Connected;

  // ── the unified lens (CEO mandate, 3 Aug 2026) ────────────────────────
  // ONE button starts the combined reality: the audio session opens, and the
  // moment it is connected the video leg starts itself — once per session,
  // never over a user's explicit stop (the latch, tested in
  // src/lib/unifiedLens.js). A video failure degrades to voice with a
  // visible reason; it never blocks the lens. When video goes LIVE the UI
  // turns cinematic: the stream becomes the background and the chrome
  // recedes (press H for the fully raw view).
  const [autoLatch] = useState(() => createAutoStartLatch());
  useEffect(() => {
    // A pick mid-read: hold the video leg WITHOUT consuming the latch —
    // audio proceeds, and this effect re-fires the moment the read settles,
    // so the avatar the user was promised actually rides the start.
    if (avatarReading) return;
    if (
      autoLatch.shouldStart({
        sessionId: allocation?.identity ?? null,
        connected: isConnected,
        videoPhase: video.phase,
      })
    ) {
      video.start({
        ...(avatar ? { imageData: avatar.dataUrl } : {}),
        ...(livePrompt.trim() ? { prompt: livePrompt.trim() } : {}),
      });
    }
  }, [allocation, isConnected, video, autoLatch, avatar, livePrompt, avatarReading]);

  const cinematic = video.phase === VIDEO_PHASE.live && Boolean(video.stream);
  // Which backdrop layer owns the stage — the ordering policy lives in
  // unifiedLens.js (crossfadeState) with tests for both callback orders.
  const fade = crossfadeState({
    streamPresent: Boolean(video.stream),
    transformedReady,
    cinematic,
  });

  // The pre-start voice choice keys in the moment the agent confirms the
  // session — once, and never against a choice the agent already holds.
  useEffect(() => {
    // Gated on the CONFIRMED converted mode — the selector hides under
    // Direct because voice changes are unsupported there, and the latch must
    // not do behind the curtain what the UI refuses to offer in front of it.
    if (
      agentMode === agentModeFor('converted') &&
      voicePref.shouldApply({
        sessionId: allocation?.identity ?? null,
        connected: isConnected,
        // The VALIDATED choice: by this point the agent's broadcast has
        // arrived (confirmedVoice gates shouldApply), so the list in force
        // is the live one — a stored id it no longer offers is not sent.
        chosen: validChosenVoice,
        confirmedVoice,
      })
    ) {
      requestVoice(validChosenVoice);
    }
  }, [allocation, isConnected, validChosenVoice, confirmedVoice, voicePref, requestVoice, agentMode]);
  const hasCredentials = Boolean(url && token);

  // The invariant behind the fix above, enforced structurally: NO audio
  // session ⇒ NO video leg. The decision lives in unifiedLens.js with its
  // tests (AGENTS.md: lifecycle logic in a component is lifecycle logic
  // nobody can break on purpose); what remains here closes over the CURRENT
  // render's video, so it cannot go stale the way a memoized handler can.
  useEffect(() => {
    if (isOrphanVideoLeg({ hasCredentials, videoPhase: video.phase })) {
      video.stop();
    }
  }, [hasCredentials, video]);

  const status = useMemo(
    () => deriveLensStatus({ connectionState, agentMode, agentBusy, audioBlocked, error }),
    [connectionState, agentMode, agentBusy, audioBlocked, error],
  );
  const latencyMs = useMemo(() => medianTailMs(utterances), [utterances]);

  // ── the lens ring's amplitude source ──────────────────────────────────
  const levelHostRef = useRef(null);

  // Track publications are not React state. `room` is set once at connect, so
  // reading getTrackPublication() during render captures whatever was published
  // at that moment and nothing re-renders when it changes later. A mic that is
  // unpublished mid-session — device lost, permission revoked — would leave the
  // meter animating a stopped track and the readout still saying "live". Held
  // in state and refreshed from the SDK's own publish/unpublish events instead.
  const [micTrack, setMicTrack] = useState(null);
  useEffect(() => {
    if (!room) {
      setMicTrack(null);
      return undefined;
    }
    let current = null;
    const read = () => {
      const next =
        room.localParticipant?.getTrackPublication(Track.Source.Microphone)?.audioTrack
          ?.mediaStreamTrack ?? null;
      // readyState, not merely presence. A device unplugged mid-session leaves
      // the publication in place with a track that has ENDED — still an object,
      // producing nothing. Treating that as live is how the ring animates
      // silence while the readout insists the mic is working.
      const live = next && next.readyState === 'live' ? next : null;

      // `ended` fires on the track itself and produces no room event at all,
      // so nothing above would ever re-read without this listener.
      if (current !== live) {
        current?.removeEventListener?.('ended', read);
        live?.addEventListener?.('ended', read);
        current = live;
      }
      setMicTrack(live);
    };
    read();
    room.on(RoomEvent.LocalTrackPublished, read);
    room.on(RoomEvent.LocalTrackUnpublished, read);
    // Muting can stop the underlying track without unpublishing it.
    room.on(RoomEvent.TrackMuted, read);
    room.on(RoomEvent.TrackUnmuted, read);
    return () => {
      room.off(RoomEvent.LocalTrackPublished, read);
      room.off(RoomEvent.LocalTrackUnpublished, read);
      room.off(RoomEvent.TrackMuted, read);
      room.off(RoomEvent.TrackUnmuted, read);
      current?.removeEventListener?.('ended', read);
    };
  }, [room]);

  // The agent's audio track, for the sync meter's EAR. Same discipline as
  // micTrack above, in full: the SELECTION policy lives in src/lib
  // (findLiveRemoteAudioTrack, tested), publications are held in state and
  // refreshed from the SDK's events — and the track's own `ended` is
  // listened to directly, because a device-level termination fires no room
  // event at all and would otherwise leave the meter analysing a corpse.
  const [remoteAudioTrack, setRemoteAudioTrack] = useState(null);
  useEffect(() => {
    if (!room) {
      setRemoteAudioTrack(null);
      return undefined;
    }
    let current = null;
    const read = () => {
      const found = findLiveRemoteAudioTrack(room.remoteParticipants);
      if (current !== found) {
        current?.removeEventListener?.('ended', read);
        found?.addEventListener?.('ended', read);
        current = found;
      }
      setRemoteAudioTrack(found);
    };
    read();
    room.on(RoomEvent.TrackSubscribed, read);
    room.on(RoomEvent.TrackUnsubscribed, read);
    room.on(RoomEvent.ParticipantDisconnected, read);
    return () => {
      room.off(RoomEvent.TrackSubscribed, read);
      room.off(RoomEvent.TrackUnsubscribed, read);
      room.off(RoomEvent.ParticipantDisconnected, read);
      current?.removeEventListener?.('ended', read);
    };
  }, [room]);

  // The mouth→ear measurement: the true A/V number, measured at the ear —
  // and since the retarget, the controller's only diet. The hook publishes
  // state exactly once per NEW measurement, so this effect fires once per
  // measured utterance, never per render.
  const sync = useSyncMeter(micTrack, remoteAudioTrack);
  // The sync trim (CEO calibration, 4 Aug evening): the video-path estimate,
  // live-adjustable and persisted. Direction, in her words: the voice
  // arriving BEFORE the lips means the video is being held too long — press
  // toward "lips earlier". The stage clamps; this just remembers and feeds.
  const [videoPathMs, setVideoPathMsState] = useState(() => {
    // Missing is distinguished from zero: an absent key means "never
    // trimmed" (use the default); a stored "0" is a trim the user made.
    // Every value passes through the lib's single normalizer, so storage,
    // the stage, and the UI can never disagree about legality (CodeRabbit).
    try {
      const raw = globalThis.localStorage?.getItem('lens-video-path-ms');
      if (raw == null || raw === '') return DEFAULT_VIDEO_PATH_MS;
      return clampVideoPathMs(Number(raw)) ?? DEFAULT_VIDEO_PATH_MS;
    } catch {
      return DEFAULT_VIDEO_PATH_MS;
    }
  });
  const trimVideoPath = useCallback((deltaMs) => {
    setVideoPathMsState((prev) => clampVideoPathMs(prev + deltaMs) ?? prev);
  }, []);
  // Persistence is an EFFECT of the value, never a side effect inside the
  // state updater — React is free to replay updaters (CodeRabbit).
  useEffect(() => {
    try {
      globalThis.localStorage?.setItem('lens-video-path-ms', String(videoPathMs));
    } catch {
      /* private mode — the trim still holds for this visit */
    }
  }, [videoPathMs]);
  useEffect(() => {
    video.pipeline.stages.align.setVideoPathMs?.(videoPathMs);
  }, [videoPathMs, video.pipeline]);

  // ── the account (P4b-ui): the lens remembers who you are ─────────────
  const auth = useAuth();

  // STUDIO LOCKDOWN (realignment, CEO 7 Aug 2026): on the canonical studio
  // hostname, a signed-out visitor is walked to the account surface — the
  // arranged order (hero → account → studio) holds even for someone typing
  // the studio URL directly. Previews/localhost keep working (dev), and
  // `?ops` preserves the non-browser ops flow the probes drive. Security
  // does not live here — every server gate checks identity regardless; this
  // is the ORDER of the experience.
  const opsMode = useMemo(
    () => new URLSearchParams(globalThis.location?.search ?? '').has('ops'),
    [],
  );
  const lockedSurface = globalThis.location?.hostname === 'studio.luminastream.live';
  useEffect(() => {
    if (!lockedSurface || opsMode) return;
    if (auth.status === 'signedOut') {
      globalThis.location?.replace(SURFACE_URLS.account);
    }
  }, [auth.status, lockedSurface, opsMode]);
  // Destructured because it is the STABLE member (useCallback in the hook);
  // `auth` itself is a fresh object every render and must never sit in a
  // debounce effect's dependency array.
  const { saveProfile } = auth;
  // The saved identity applies ONCE per sign-in: server truth lands on the
  // local knobs (voice, style, sync trim), and from then on the knobs are
  // the truth again — a re-render must never re-stomp a local change.
  const profileAppliedRef = useRef(false);
  useEffect(() => {
    if (auth.status !== 'signedIn') {
      profileAppliedRef.current = false;
      return;
    }
    if (profileAppliedRef.current) return;
    const p = auth.profile;
    // Latch AFTER the null check: the first signedIn state can carry
    // profile:null (the enriching probe still in flight) — latching there
    // would block the real profile forever (CodeRabbit, PR 86).
    if (!p) return;
    profileAppliedRef.current = true;
    if (p.voiceId) chooseVoice(p.voiceId);
    if (typeof p.stylePrompt === 'string' && p.stylePrompt) setLivePrompt(p.stylePrompt);
    const ms = clampVideoPathMs(p.videoPathMs);
    if (ms != null) setVideoPathMsState(ms);
  }, [auth.status, auth.profile, chooseVoice]);

  // Autosave, debounced, signed-in only. The FIRST observation after the
  // profile applies is the baseline (never echoed back to the server); every
  // later change ships the whole current identity — the server COALESCEs,
  // so unnamed fields survive regardless.
  const lastSavedIdentityRef = useRef(null);
  useEffect(() => {
    if (auth.status !== 'signedIn' || !profileAppliedRef.current) {
      lastSavedIdentityRef.current = null;
      return undefined;
    }
    const snapshot = JSON.stringify({
      voiceId: validChosenVoice,
      videoPathMs,
      stylePrompt: livePrompt.trim(),
    });
    if (lastSavedIdentityRef.current === null) {
      lastSavedIdentityRef.current = snapshot;
      return undefined;
    }
    if (lastSavedIdentityRef.current === snapshot) return undefined;
    const timer = setTimeout(() => {
      lastSavedIdentityRef.current = snapshot;
      saveProfile({
        voiceId: validChosenVoice ?? undefined,
        // The same label source the <select> renders — the broadcast labels
        // alone are empty before the agent connects, and COALESCE would then
        // pair the NEW voiceId with the PREVIOUS voice's stored name.
        voiceName: validChosenVoice ? effectiveVoiceLabels[validChosenVoice] : undefined,
        stylePrompt: livePrompt.trim() || undefined,
        videoPathMs,
      });
    }, 800);
    return () => clearTimeout(timer);
    // Stable members only: `auth` itself is a fresh object every render, and
    // depending on it re-arms this debounce faster than 800ms while the lens
    // is live — the timer would be cleared before it EVER fired.
  }, [auth.status, saveProfile, validChosenVoice, videoPathMs, livePrompt, effectiveVoiceLabels]);
  // Direct-mode audio alignment — THE LAGGARD IS THE MASTER CLOCK (doctrine
  // generalized, 4 Aug evening): in converted mode audio is slow and video
  // holds (above); in Direct mode audio returns in ~350ms while the video
  // leg costs ~700ms, so audio COULD take the hold through a WebAudio delay
  // line (useAudioAlign — built, tested, kept for the native shell). It is
  // deliberately NOT engaged: the CEO chose rawness over alignment for
  // passthrough (6 Aug 2026 — the hold's engagement read as a jump on her
  // screen). Direct mode adds zero artificial delay anywhere; the laggard
  // doctrine governs Converted mode only.

  // The applied hold, as RENDER-VISIBLE state: the render that displays it
  // happens before the effect that moves it, so reading targetMs() during
  // render would trail by one measurement (CodeRabbit, PR 67). Written here,
  // in the same breath as the observation that moves it.
  const [appliedHoldMs, setAppliedHoldMs] = useState(0);
  // Each measurement is fed EXACTLY once, however often this effect re-runs
  // (a trim press changes videoPathMs; a render changes nothing) — a
  // re-observed sample would bypass both policies' slew. The meter's hook
  // publishes a NEW state object per measurement, so object identity is the
  // dedupe key.
  const lastFedMeasurementRef = useRef(null);
  useEffect(() => {
    if (!Number.isFinite(sync?.lastMs) || lastFedMeasurementRef.current === sync) return;
    lastFedMeasurementRef.current = sync;
    // The measurement feeds the VIDEO hold (Converted's elastic). Direct
    // mode is raw by verdict — nothing to feed there.
    video.pipeline.stages.align.observeMouthToEar?.(sync.lastMs);
    setAppliedHoldMs(video.pipeline.stages.align.targetMs?.() ?? 0);
  }, [sync, video.pipeline]);

  const reduceMotion = useReducedMotion();
  const paintLevel = useCallback((level) => {
    levelHostRef.current?.style.setProperty('--level', String(level));
  }, []);
  // Reduced motion is honoured by not building the audio graph at all, rather
  // than by building it and discarding every frame. A viewer who asked for a
  // still interface should not also pay for an AudioContext and a 60 Hz
  // animation frame loop to produce a number nothing reads.
  useMicLevel(reduceMotion ? null : micTrack, paintLevel);

  // Claim a slot and connect.
  //
  // The old flow unlocked and connected in one step because the room was a
  // constant — unlocking was only ever "fetch a token for the room we already
  // knew". Now the server owns the room, so this is a claim on a scarce thing
  // and it happens when the person actually wants to talk.
  //
  // openSession applies ONE deadline across the whole exchange
  // (sessionClient.DEFAULT_TIMEOUT_MS). Without it a hung request would never
  // settle, `finally` would never run, and the only control on the page would
  // sit disabled with nothing to show.
  // Claim a slot and connect.
  //
  // The old flow unlocked and connected in one step because the room was a
  // constant. Now the server owns the room, so this is a claim on a scarce
  // thing and it happens when the person actually wants to talk.
  const start = async (event) => {
    event?.preventDefault();
    if (auth.status === 'signedIn') {
      // The signed-in path (realignment): the session cookie is the
      // authority — no password, no admin exchange, holder.start({}) rides
      // the cookie straight into /api/session/create.
      await holder.start({});
      return;
    }
    await holder.start({ password: accessKey });
    setAccessKey(''); // exchanged — no reason to keep it in memory
  };

  const stop = useCallback(async () => {
    setPendingConnect(false);
    // Release FIRST, teardown second — and never sequence the release behind
    // the teardown. The previous version awaited disconnect() before
    // holder.stop() inside a try/finally, which protects against a disconnect
    // that REJECTS but not one that HANGS — and a LiveKit teardown wedged in a
    // mid-connect retry loop (the Starlink DNS blackhole, observed live on
    // 2 Aug) hangs. The release then never fired and the slot stayed held for
    // the full lease. Proven by the E2E drill: Stop clicked, zero
    // /api/session/end requests on the wire, server still counting the slot.
    //
    // There is no data dependency between the two: endSession talks to the
    // Worker, disconnect tears down this tab's room object. The only coupling
    // was the accident of sequencing. A lingering room briefly overlapping a
    // reallocated slot is harmless — identities are unique per session, so no
    // eviction (see sessionRegistry.js).
    const released = holder.stop();
    // The unified lens: ONE stop ends everything. Video in the same breath
    // (its settle is money), and none of it sequences behind anything that
    // can hang. The latch is NOT reset here: session identities are unique,
    // so a new session re-arms it by being new — and a manual reset once
    // re-armed it for a session still mid-teardown.
    video.stop();
    disconnect().catch(() => {});
    await released;
    // `video` MUST be in the deps. This callback was once memoized on
    // [disconnect, holder] alone — both identity-stable from the first
    // render — so the Stop button forever called the PRE-UNLOCK render's
    // video.stop(), bound to a negotiator that had never started anything.
    // The real negotiator kept the camera and the billed vendor session
    // until the tab was reloaded (CEO, 4 Aug 2026: camera light on after
    // Stop, Decart billing in the background). exhaustive-deps is now an
    // error in eslint.config.js so this cannot be reintroduced silently.
  }, [disconnect, holder, video]);

  // Publish the holder's credentials into the hook, then connect.
  //
  // connect() cannot be called from the click handler: it reads the url and
  // token from refs that only update on render. Guarded on both so a partial
  // update never dials with one empty, which LiveKit reports as a generic
  // connection failure.
  useEffect(() => {
    setUrl(held.url);
    setToken(held.token);
    if (held.phase === PHASE.held && held.url && held.token) setPendingConnect(true);
  }, [held]);

  useEffect(() => {
    if (!pendingConnect || !url || !token) return;
    setPendingConnect(false);
    connect();
  }, [pendingConnect, url, token, connect]);

  // Browser lifecycle in, holder decisions out. `pagehide` rather than
  // `unload`: unload is unreliable and blocks the back/forward cache. The
  // unmount case is the in-app navigation pagehide never sees — following the
  // link to /livekit-test does not touch the document.
  useEffect(() => {
    const hide = () => holder.hide();
    const show = (event) => {
      if (event?.persisted) holder.restored();
    };
    globalThis.addEventListener?.('pagehide', hide);
    globalThis.addEventListener?.('pageshow', show);
    return () => {
      globalThis.removeEventListener?.('pagehide', hide);
      globalThis.removeEventListener?.('pageshow', show);
      holder.dispose();
    };
  }, [holder]);

  // The agent is the source of truth for mode, so the selector only ever
  // REQUESTS. While connected, a click goes on the wire; while disconnected it
  // is remembered and sent once the agent confirms it has joined.
  const chooseMode = (id) => {
    setLensMode(id);
    // Connected, not merely not-disconnected: the room object already exists
    // during Connecting and Reconnecting, so publishing here would throw the
    // request into a data channel that is not open yet. The effect below picks
    // it up once the agent speaks.
    if (isConnected) {
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
    if (pushedRef.current || !isConnected || !agentMode) return;
    pushedRef.current = true;
    const wire = agentModeFor(lensMode);
    if (wire && wire !== agentMode) requestAgentMode(wire);
  }, [isDisconnected, isConnected, agentMode, lensMode, requestAgentMode]);

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

      <header
        {...chromeInert}
        className={`relative flex items-center justify-between px-6 sm:px-10 py-6 transition-opacity duration-500 motion-reduce:transition-none ${cinematic ? 'opacity-60 hover:opacity-100 focus-within:opacity-100' : ''}`}
      >
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

      <main
        {...chromeInert}
        className={`relative isolate flex-1 flex flex-col items-center justify-center px-6 pb-16 ${cinematic ? 'cinematic-chrome' : ''}`}
      >
        {/* cinematic-veil: the ring cedes the stage to the stream (CSS keeps
            its layout box, so nothing below jumps). The mic meter keeps
            painting a hidden ring — cheaper than tearing the graph down and
            rebuilding it every time the mode flips. */}
        <div className={cinematic ? 'cinematic-veil' : ''}>
          <Lens
            tone={status.tone}
            // status.id, not status.tone: 'waiting for the agent' shares the
            // 'working' tone, and a ring that spins forever reads as "almost
            // there" when the truth may be that no agent is running at all.
            spinning={status.id === 'connecting'}
            reduceMotion={reduceMotion}
            levelHostRef={levelHostRef}
          />
        </div>

        {/* The backdrop — the transition IS the product moment (CEO, 4 Aug):
            on Start the page fades slowly toward the person's own camera
            while the lens connects, then crossfades into the transformed
            stream when it goes live. Two stacked <video> layers, each owning
            only its opacity; the raw feed is dimmed and desaturated so it
            reads as "materializing", never as the finished thing.

            MUST be a direct child of <main>, NEVER inside lens-console. Two
            invariants depend on that position: the cinematic recede rule
            exempts it by DIRECT-child selector (`> *:not(.lens-backdrop)`) —
            wrapped, the stream itself dims to 60%; and the console's
            backdrop-filter creates a CONTAINING BLOCK, so an inset-0 backdrop
            inside it fills the panel instead of the viewport. Both happened
            (#75 — the stream shrank into the panel box on production; caught
            by the post-deploy probe's evidence frame, not by the assertions,
            which only check intrinsic pixels). */}
        {(video.localStream || video.stream) && (
          <div className="lens-backdrop absolute inset-0 -z-10 overflow-hidden">
            {video.localStream && (
              <video
                ref={localElRef}
                // The probe (and any future instrument) must be able to tell
                // the camera preview from the vendor's output — asserting on
                // "a <video> plays" would pass on the fake camera alone.
                data-role="camera-preview"
                autoPlay
                playsInline
                muted
                className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-[1600ms] ease-out motion-reduce:transition-none ${
                  fade.preview === 'hidden' ? 'opacity-0' : 'opacity-30'
                }`}
                style={{ filter: 'saturate(0.55) brightness(0.6)' }}
              />
            )}
            {video.stream && (
              <video
                ref={videoElRef}
                data-role="transformed-stream"
                autoPlay
                playsInline
                muted
                className={`absolute inset-0 w-full h-full object-cover transition-[opacity,transform] duration-[1200ms] ease-out motion-reduce:transition-none ${
                  fade.transformed === 'full'
                    ? 'opacity-100 scale-100'
                    : fade.transformed === 'ambient'
                      ? 'opacity-40 scale-[1.03]'
                      : 'opacity-0 scale-[1.03]'
                }`}
              />
            )}
            {/* Readability, in two regimes: before live, a radial mask keeps
                the center column legible over the materializing feed; once
                cinematic, edge scrims take over so the header and controls
                sit on darkness while the face stays untouched. */}
            <div
              aria-hidden
              className="absolute inset-0 transition-opacity duration-[1200ms] motion-reduce:transition-none"
              style={{
                background:
                  'radial-gradient(circle at 50% 45%, transparent 18%, #08080F 72%)',
                // The mask lifts when the TRANSFORMED layer takes the stage —
                // keyed on the same policy as the layers, so a live-but-not-
                // yet-decoded moment never unmasks the raw preview.
                opacity: fade.transformed === 'full' ? 0 : 1,
              }}
            />
            <div
              aria-hidden
              className={`absolute inset-0 transition-opacity duration-700 motion-reduce:transition-none ${
                fade.transformed === 'full' ? 'opacity-100' : 'opacity-0'
              }`}
              style={{
                background:
                  'linear-gradient(to bottom, rgba(5,5,10,0.65) 0%, transparent 24%, transparent 68%, rgba(5,5,10,0.78) 100%)',
              }}
            />
          </div>
        )}

        {/* lens-console: every control and readout in ONE panel. In cinematic
            mode the panel carries its own scrim (CSS), because legibility must
            not depend on what the camera happens to see — the 4 Aug drill put
            this chrome over a white-and-yellow wall and the CEO could not read
            the fps number or find the trim buttons. A text-shadow tuned for
            dark scenes is a bet on the scene; a contained backdrop is not. */}
        <div className="lens-console w-full max-w-xl flex flex-col items-center">
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
                type="button"
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
                {/* aria-pressed reports the REQUEST. The agent's confirmation
                    has to be in the accessible name too, or a screen-reader
                    user hears their own request read back as though the agent
                    had agreed — the exact applied-vs-requested conflation this
                    page exists to avoid. A title on a span is not reliably
                    announced, and is invisible to keyboard and touch users. */}
                <span className="relative flex items-center gap-1.5">
                  {mode.label}
                  {confirmed && !isDisconnected && (
                    <>
                      <span
                        aria-hidden
                        className="w-1 h-1 rounded-full"
                        style={{ backgroundColor: '#10B981' }}
                      />
                      <span className="sr-only">, confirmed by the agent</span>
                    </>
                  )}
                </span>
              </button>
            );
          })}
        </div>
        {/* The blurb describes the mode the user PICKED. While a switch is in
            flight the status line above still reports the mode the agent
            confirmed, so the two disagree — and an unlabelled blurb would read
            as a description of what is happening rather than of what was
            asked for. Say which one it is. */}
        <p className="mt-3 text-[11px] text-[#4A5568] text-center max-w-xs leading-relaxed">
          {activeMode.blurb}
          {isConnected && agentMode && agentMode !== activeMode.agentMode && (
            <span className="block mt-1 text-[#F59E0B]">
              Requested — waiting for the agent to confirm.
            </span>
          )}
        </p>

        {/* Voice selection. Visibility and value are both CONFIRMED state:
            shown only when the agent's confirmed mode is convert (a selector
            during a Direct-confirmed transition would promise what the agent
            has not agreed to), and the <select> shows the agent-confirmed
            voice — a pending request is a labeled message, never the value.
            Same honesty rule as the mode toggle above. */}
        {/* Voice selection — PRE-START FIRST (CEO directive): pick before the
            lens starts, from the agent's live list when connected or the
            committed manifest before that. Connected, the value shown is the
            agent-CONFIRMED voice (the mode toggle's honesty rule); before
            the lens starts it is the stored choice, labeled as such. Hidden
            only when the agent has confirmed Direct — a voice selector there
            would promise what the mode cannot do.

            Deliberately NOT gated on the unlock (CEO, 4 Aug 2026): the whole
            identity — voice, avatar, style — is chosen on the same screen as
            the access key, so the ONE press of Start carries all of it. The
            choices are local until then; nothing here needs a server. */}
        {effectiveVoiceChoices.length > 0 &&
          !(isConnected && agentMode && agentMode !== agentModeFor('converted')) && (
          <div className="mt-4 flex flex-col items-center gap-1">
            <div className="flex items-center gap-2">
              <label
                htmlFor="lens-voice"
                className="text-[9px] tracking-[0.18em] uppercase text-[#4A5568]"
              >
                Voice
              </label>
              <select
                id="lens-voice"
                value={isConnected && confirmedVoice ? confirmedVoice : (validChosenVoice ?? confirmedVoice ?? '')}
                onChange={(e) => {
                  chooseVoice(e.target.value);
                  if (isConnected) requestVoice(e.target.value);
                }}
                className="bg-transparent border border-[#1A1A2E] rounded-full px-3 py-1.5 text-[10px] text-[#94A3B8] focus:outline-none focus:border-[#6366F1]"
              >
                {/* With no stored choice the select's value is '' — without
                    this option the browser would DISPLAY the first voice in
                    the list while the session would actually use the agent's
                    default. A placeholder keeps the display honest until a
                    real choice exists. */}
                {!validChosenVoice && !(isConnected && confirmedVoice) && (
                  <option value="" disabled className="bg-[#08080F]">
                    choose a voice…
                  </option>
                )}
                {effectiveVoiceChoices.map((id) => (
                  <option key={id} value={id} className="bg-[#08080F]">
                    {effectiveVoiceLabels[id] ?? id}
                  </option>
                ))}
              </select>
            </div>
            {!isConnected && validChosenVoice && (
              <span className="text-[9px] text-[#3E4A5F]">
                applies when the lens starts
              </span>
            )}
            {voiceSel.requested && (
              <span className="text-[9px] text-[#F59E0B]">
                Requested {voiceLabels[voiceSel.requested] ?? voiceSel.requested} — waiting for
                the agent to confirm.
              </span>
            )}
            {!voiceSel.requested && voiceSel.rejection && (
              <span role="alert" className="text-[9px] text-[#F59E0B]">
                the agent kept {voiceLabels[confirmedVoice] ?? 'its voice'} —{' '}
                {voiceSel.rejection.reason}
              </span>
            )}
          </div>
        )}

        {/* The lens's video state — no separate button (CEO mandate: ONE
            universal Start). The lens starts audio and video together; what
            remains here is the truth about the video leg, and the identity
            controls that shape it. Like the voice above, the avatar and the
            style prompt are pre-unlock controls: both are local state that
            rides the first start, so hiding them behind the key would force
            the user to configure their identity AFTER the meter starts. */}
        <div className="mt-8 w-full max-w-sm flex flex-col items-center gap-2">
            <div className="flex items-center gap-3">
              {(video.phase === VIDEO_PHASE.starting || video.phase === VIDEO_PHASE.stopping) && (
                <span className="flex items-center gap-2 text-[9px] tracking-[0.14em] uppercase text-[#64748B]">
                  <Loader2 size={11} className="animate-spin" />
                  {video.phase === VIDEO_PHASE.starting ? 'video joining the lens' : 'video closing'}
                </span>
              )}
              {/* The fidelity readout says what the pipeline ACTUALLY
                  delivers. While the upscale slot is empty it says 720p and
                  names what is pending — claiming FHD before the stage exists
                  would be the kind of lie this project keeps refusing. */}
              {video.phase === VIDEO_PHASE.live && presentingRaw && (
                /* Raw passthrough (CEO verdict, 6 Aug): the element shows the
                   vendor's stream untouched, so the readout claims VENDOR
                   truth only — native resolution, measured rate, no pipeline
                   labels for work the presented pixels never received. */
                <span className="text-[9px] tracking-[0.14em] uppercase text-[#94A3B8]">
                  <Video size={10} className="inline mr-1" aria-hidden />
                  {fidelity.vendorNative.height}p
                  {deliveredFps != null && ` · ${deliveredFps}fps`}
                  {' · raw passthrough · press H for clean view'}
                </span>
              )}
              {video.phase === VIDEO_PHASE.live && !presentingRaw && (
                <span className="text-[9px] tracking-[0.14em] uppercase text-[#94A3B8]">
                  <Video size={10} className="inline mr-1" aria-hidden />
                  {fidelity.delivering.height}p
                  {deliveredFps != null && ` · ${deliveredFps}fps`}
                  {/* The tier LABEL is the synthesis stage's claim about what
                      runs; the fps NUMBER stays the meter's measurement of
                      what the element presents. Kept separate on purpose —
                      when they disagree, the disagreement is the diagnosis. */}
                  {fidelity.synthLabel && ` · ${fidelity.synthLabel}`}
                  {!fidelity.upscaleActive && ' · upscale pending'}
                  {/* The applied hold, not a vanity light: how far the video
                      is standing behind real time to meet its voice. State,
                      not a render-time read — written by the same effect
                      that moves the target, so it is never a beat behind. */}
                  {fidelity.alignActive && ` · video held ${(appliedHoldMs / 1000).toFixed(1)}s`}
                  {' · press H for clean view'}
                </span>
              )}
            </div>

            {/* The sync trim — the calibration knob, in the language of the
                symptom rather than the mechanism. Buttons step the video-path
                estimate 100ms at a time; the elastic slews the picture there
                smoothly. Rendered only while the aligned stream is live AND
                presented — a raw passthrough has nothing to trim. */}
            {video.phase === VIDEO_PHASE.live && fidelity.alignActive && !presentingRaw && (
              <div className="flex items-center gap-2 text-[9px] tracking-[0.14em] uppercase text-[#94A3B8]">
                <span>sync trim</span>
                <button
                  type="button"
                  onClick={() => trimVideoPath(-100)}
                  disabled={videoPathMs <= VIDEO_PATH_LIMITS.min}
                  title="the lips move before the voice arrives — hold the video longer"
                  className="rounded-full border border-[#475569] px-2.5 py-1 transition-colors hover:text-[#A5B4FC] hover:border-[#A5B4FC] disabled:opacity-40"
                >
                  lips later
                </button>
                <span className="tabular-nums text-[#E2E8F0]">{videoPathMs}ms</span>
                <button
                  type="button"
                  onClick={() => trimVideoPath(100)}
                  disabled={videoPathMs >= VIDEO_PATH_LIMITS.max}
                  title="the voice arrives before the lips — release the video sooner"
                  className="rounded-full border border-[#475569] px-2.5 py-1 transition-colors hover:text-[#A5B4FC] hover:border-[#A5B4FC] disabled:opacity-40"
                >
                  lips earlier
                </button>
              </div>
            )}

            {/* Identity controls: the reference avatar and the live prompt.
                Both work BEFORE start (they ride the create) and DURING the
                stream (identity swap / restyle without reconnecting). */}
            <div className="w-full flex items-center gap-2">
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => {
                  onAvatarPicked(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => avatarInputRef.current?.click()}
                className="flex items-center gap-1.5 shrink-0 rounded-full px-3 py-1.5 text-[9px] tracking-[0.14em] uppercase border border-[#1A1A2E] text-[#64748B] transition-colors hover:text-[#A5B4FC]"
                title={avatar ? `reference: ${avatar.name}` : 'upload a reference avatar image'}
              >
                {avatar ? (
                  <img
                    src={avatar.dataUrl}
                    alt=""
                    className="w-4 h-4 rounded-full object-cover"
                  />
                ) : (
                  <Video size={10} aria-hidden />
                )}
                {avatar ? 'Avatar set' : 'Avatar'}
              </button>
              {avatar && (
                <button
                  type="button"
                  onClick={clearAvatar}
                  className="shrink-0 text-[9px] uppercase tracking-[0.14em] text-[#4A5568] hover:text-[#F59E0B]"
                >
                  clear
                </button>
              )}
              <input
                type="text"
                // The accessible name carries the same two tenses as the
                // placeholder — a screen reader must not be told less than
                // the placeholder shows (CodeRabbit, PR 63).
                aria-label={
                  video.phase === VIDEO_PHASE.live
                    ? 'restyle the live stream'
                    : 'style the lens at start'
                }
                value={livePrompt}
                onChange={(e) => {
                  setLivePrompt(e.target.value);
                  setPromptApplied(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') applyPrompt();
                }}
                // Same input, two honest tenses: before the lens starts the
                // prompt STYLES the identity that will ride the first start;
                // once live it RESTYLES the running stream.
                placeholder={
                  video.phase === VIDEO_PHASE.live
                    ? 'restyle live — e.g. "change cloth to blue"'
                    : 'style the lens — e.g. "warm studio light, navy jacket"'
                }
                className="min-w-0 flex-1 bg-transparent border border-[#1A1A2E] rounded-full px-3 py-1.5 text-[10px] text-[#94A3B8] placeholder:text-[#3E4A5F] focus:outline-none focus:border-[#6366F1]"
              />
              {video.phase === VIDEO_PHASE.live && (
                <button
                  type="button"
                  onClick={applyPrompt}
                  disabled={!livePrompt.trim()}
                  className="shrink-0 rounded-full px-3 py-1.5 text-[9px] tracking-[0.14em] uppercase border border-[#1A1A2E] text-[#64748B] transition-colors hover:text-[#A5B4FC] disabled:opacity-40"
                >
                  {promptApplied ? 'Applied' : 'Apply'}
                </button>
              )}
            </div>
            {avatarError && (
              <p role="alert" className="text-[10px] text-[#F59E0B]">
                {avatarError}
              </p>
            )}

            {video.budget && (
              <span className="text-[9px] text-[#7C8AA5] tabular-nums">
                video budget {Math.floor(video.budget.remainingSeconds / 60)}m{' '}
                {video.budget.remainingSeconds % 60}s remaining
              </span>
            )}

            {video.error && (
              <p
                role="alert"
                className="flex items-center gap-1.5 text-[10px] text-[#F59E0B] text-center"
              >
                <AlertTriangle size={10} /> {video.error}
              </p>
            )}
          </div>

        {/* Action */}
        <div className="mt-10 w-full max-w-sm">
          {hasCredentials ? (
            /* A slot is held. Stop must be reachable from EVERY state of this
               block — the previous version disabled the button while
               Connecting, which meant a person wedged mid-connect (the
               Starlink DNS blackhole) had no way to release their own slot: an
               unreleasable hold on the only agent, by design. The scarce thing
               must always have a give-it-back button. */
            <div className="flex flex-col gap-2.5">
              {isDisconnected && (
                /* Holding but not connected — the connect failed (bad network,
                   DNS). The slot and grant are still valid, so retrying is
                   free and does not touch the registry. */
                <button
                  onClick={() => setPendingConnect(true)}
                  className="w-full flex items-center justify-center gap-2.5 rounded-full py-3.5 text-[11px] tracking-[0.2em] uppercase transition-all"
                  style={{ backgroundColor: '#FFFFFF', color: '#08080F' }}
                >
                  <Power size={13} /> Reconnect
                </button>
              )}
              <button
                onClick={stop}
                className="w-full flex items-center justify-center gap-2.5 rounded-full py-3.5 text-[11px] tracking-[0.2em] uppercase transition-all"
                style={{ border: '1px solid #1A1A2E', color: '#94A3B8' }}
              >
                {connectionState === ConnectionState.Connecting ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Power size={13} />
                )}
                Stop
              </button>
            </div>
          ) : adminToken ? (
            /* Unlocked, holding no slot — after a Stop, or after a refusal.
               The access key has already been exchanged, so asking for it
               again would be theatre. One button, and it is the only one that
               can claim a slot. */
            <div className="flex flex-col gap-2.5">
              <button
                type="button"
                onClick={start}
                disabled={unlocking}
                className="w-full flex items-center justify-center gap-2.5 rounded-full py-3.5 text-[11px] tracking-[0.2em] uppercase bg-white text-[#08080F] disabled:opacity-50 transition-opacity"
              >
                {unlocking ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Power size={13} />
                )}
                Start the lens
              </button>
              {unlockError && (
                <p
                  role="alert"
                  className="flex items-center justify-center gap-1.5 text-[11px] text-[#EF4444]"
                >
                  <AlertTriangle size={11} /> {unlockError}
                </p>
              )}
            </div>
          ) : apiConfigured && auth.status === 'signedIn' ? (
            /* The signed-in start (realignment): the account IS the key. One
               button; the cookie carries the authority. Unverified accounts
               get the server's verification_required back, surfaced by the
               holder's error line below the button. */
            <form onSubmit={start} className="flex flex-col items-center gap-2.5">
              <button
                type="submit"
                disabled={unlocking}
                className="flex items-center justify-center gap-2 rounded-full px-10 py-3.5 text-[11px] tracking-[0.16em] uppercase bg-white text-[#08080F] disabled:opacity-40 transition-opacity"
              >
                {unlocking ? <Loader2 size={13} className="animate-spin" /> : <Power size={13} />}
                Start the lens
              </button>
              {unlockError && (
                <p role="alert" className="flex items-center justify-center gap-1.5 text-[11px] text-[#EF4444]">
                  <AlertTriangle size={11} /> {unlockError}
                </p>
              )}
            </form>
          ) : apiConfigured ? (
            <form onSubmit={start} className="flex flex-col gap-2.5">
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
                  // Locked while the exchange is in flight: the submit handler
                  // captured the old value, so a mid-request edit would either
                  // be silently discarded on success or blamed in the error on
                  // failure.
                  disabled={unlocking}
                  autoComplete="current-password"
                  value={accessKey}
                  onChange={(e) => setAccessKey(e.target.value)}
                  placeholder="••••••••"
                  aria-invalid={Boolean(unlockError)}
                  aria-describedby={unlockError ? 'access-key-error' : undefined}
                  className="flex-1 min-w-0 bg-[#0C0C16] border border-[#1A1A2E] rounded-full px-5 py-3 text-sm text-white placeholder:text-[#2E2E44] focus:outline-none focus:border-[#6366F1]/60 transition-colors"
                />
                <button
                  type="submit"
                  disabled={unlocking || !accessKey}
                  className="flex items-center gap-2 rounded-full px-6 text-[11px] tracking-[0.16em] uppercase bg-white text-[#08080F] disabled:opacity-40 transition-opacity"
                >
                  {unlocking ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />}
                  Start the lens
                </button>
              </div>
              {/* role="alert" rather than plain text: this form is the only
                  way into the lens, so a screen-reader user who submits a bad
                  key would otherwise get silence and no idea why nothing
                  happened. */}
              {unlockError && (
                <p
                  id="access-key-error"
                  role="alert"
                  className="flex items-center justify-center gap-1.5 text-[11px] text-[#EF4444]"
                >
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

          {/* The account surface (P4b-ui). Sits WITH the access form, not
              instead of it: the admin key still gates the lens during the
              dev period; the account is what makes the lens REMEMBER you —
              voice, style, sync trim — across sessions and devices. */}
          {apiConfigured && (
            <div className="mt-5 pt-4 border-t border-[#14141F]">
              <AccountPanel auth={auth} />
            </div>
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
              key="live-strip"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: reduceMotion ? 0 : 0.3 }}
              className="mt-10 flex items-stretch divide-x divide-[#161626] border border-[#161626] rounded-xl bg-[#0B0B14]/70 py-3"
            >
              <Stat label="Latency" value={latencyMs} unit="ms" />
              {/* Mouth→ear: the WHOLE voice path measured at the ear —
                  speech duration, queue, synthesis, backlog, network, jitter
                  buffer, all of it. This is the number video sync answers
                  to; "Latency" above is the agent's own (smaller) tail. */}
              <Stat
                label="Mouth→Ear"
                value={sync?.medianMs != null ? Math.round(sync.medianMs) : null}
                unit="ms"
              />
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
        </div>
      </main>

      {/* Both values are the SERVER's now, so the footer reports what was
          allocated rather than what this tab decided. Blank until a slot is
          held — showing a stale room after Stop would name one somebody else
          may already be using. */}
      <footer
        {...chromeInert}
        className={`relative px-6 sm:px-10 py-5 text-center text-[10px] text-[#2E2E44] tracking-wide transition-opacity duration-500 motion-reduce:transition-none ${cinematic ? 'opacity-60 hover:opacity-100 focus-within:opacity-100' : ''}`}
      >
        {allocation ? (
          <>
            Session <span className="font-mono text-[#4A5568]">{allocation.identity}</span> · room{' '}
            <span className="font-mono text-[#4A5568]">{allocation.room}</span>
          </>
        ) : (
          <>No session — the server allocates a room when the lens starts</>
        )}
      </footer>

      {/* Clean View: the raw output, nothing else. An opaque overlay ON TOP
          of the (still-mounted) page, so audio keeps playing and the session
          is untouched. No chrome by design — H is the only way in or out,
          and the sr-only line tells assistive tech what happened and how to
          return. The video is full-frame and unmasked: what a third-party
          platform's viewer would receive, not the lens's ring treatment. */}
      {cleanView && (
        <div
          ref={cleanViewRef}
          tabIndex={-1}
          className="fixed inset-0 z-50 bg-black flex items-center justify-center outline-none"
        >
          <span className="sr-only" role="status">
            Clean view: interface hidden. Press H to restore the controls.
          </span>
          {video.stream ? (
            <video
              ref={cleanViewElRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-contain"
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
