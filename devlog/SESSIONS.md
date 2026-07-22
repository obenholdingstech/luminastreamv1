# LuminaStream — Session Log

Full session records, **newest at top**. Terse handover summaries live in `notes.md`.

---

## 22 July 2026, ~04:35 — Move 2b: RVC convert agent built & verified live

### Task (verbatim)

> Build the RVC conversion agent (Move 2b): transplant the proven
> agent/bridge_test_v3.py pipeline into a LiveKit agent with a LIVE
> passthrough/convert mode toggle.
>
> CONTEXT — read these files first:
> - agent/echo_agent.py = proven transport skeleton (room join, server-side
>   token from secrets.env, subscribe/republish, echo-* identity guard).
>   Keep it untouched as the known-good reference.
> - agent/bridge_test_v3.py = proven conversion recipe: stateless sliding
>   windows @48k mono (WINDOW 14336 = CTX 8192 + HOP 6144), warmup window
>   before live pacing, backpressure (max 2 in-flight, drop hops), SOLA-
>   aligned equal-power crossfade (XFADE 1024, SOLA 384, stride 8).
>   RVC WebSocket protocol: JSON config first {"sample_rate":48000,
>   "chunk_size":14336,"f0_method":"rmvpe","index_rate":0.75,"protect":0.33,
>   "rms_mix_rate":0.25,"filter_radius":3,"pitch_shift":0}, then binary
>   [uint32 seq][uint32 reserved][float32 PCM] both directions.
> - Production topology: agent runs on the same box as the RVC server
>   (RunPod), RVC_WS_URL=ws://127.0.0.1:8000/ws/audio. Server MUST run with
>   RVC_STREAM_CONTEXT_SECONDS=0 (stateless) — document in README.
>
> BEFORE CODING — verify against the installed packages (livekit 1.1.13
> Python, livekit-client 2.20.1 JS), never memory. Report what you find:
> 1. Data channels: exact Python receive API (event name, payload shape,
>    participant attribution) and JS publish API (signature, reliable flag),
>    plus Python->JS publish for confirmations.
> 2. rtc.AudioStream 48k mono frame cadence — confirm same as echo agent.
> 3. AudioSource.capture_frame flow control — confirm await = backpressure.
>
> BUILD:
> 1. agent/bridge.py — pure logic extracted from bridge_test_v3.py:
>    - WindowAssembler: feed 480-sample frames -> yields (seq, window[14336])
>      every 6144 new samples; zero-left-pad at stream start
>    - SolaStitcher: accepts converted windows (lengths may vary slightly,
>      ratio ~1.008 observed), SOLA-align + crossfade, exposes continuous
>      output readable in 480-sample frames; counts underruns
>    - All params constructor args with v3 defaults
>    - pytest unit tests: assembly bookkeeping; sine-wave chop/reassemble
>      must show no phase jumps; underrun behavior
> 2. agent/rvc_client.py — async RVC WS client: connect, config, warmup
>    exchange, send_window, receive loop, in-flight tracking, turnaround
>    stats, reconnect-on-drop (re-warmup on reconnect).
> 3. agent/mock_rvc_server.py — same WS protocol, echoes each window back
>    unchanged after configurable delay (default 70ms, occasional 150ms
>    spike). Purpose: full plumbing test on Mac without GPU.
> 4. agent/convert_agent.py — main agent, based on echo_agent structure:
>    - Modes: "passthrough" (frames straight through; RVC paused = GPU cost
>      control) | "convert" (frames -> WindowAssembler -> rvc_client ->
>      SolaStitcher -> frames out)
>    - Live switching via data messages {"type":"set_mode","mode":...};
>      agent confirms {"type":"agent_mode","mode":...}; re-send confirmation
>      when a participant joins
>    - Jitter buffer: drain converted output only after ~1.5 hops buffered;
>      underrun -> emit silence + count
>    - Backpressure: in-flight >= 2 -> drop hop, emit silence for it (late
>      audio is worse than lost audio)
>    - Startup: warmup RVC BEFORE joining the room (stream never sees a
>      cold model)
>    - Robustness: RVC connection failure in convert mode -> auto-fallback
>      to passthrough + {"type":"agent_mode","mode":"passthrough",
>      "reason":"rvc_unavailable"} + background retry
>    - Stats every 5s: mode, frames in/out, windows sent/recv/dropped,
>      underruns, turnaround p50/p95, buffer depth
>    - CLI/env: RVC_WS_URL, --mode (default passthrough), room/identity
>      same pattern as echo agent
> 5. Frontend — ONLY src/pages/LiveKitTest.jsx and
>    src/hooks/useLiveKitVoice.js: Passthrough|Convert toggle publishing
>    set_mode; "Agent mode: X" indicator driven by agent_mode confirmations
>    (agent is source of truth, not the button). Everything else intact.
> 6. agent/requirements.txt (pin additions: websockets, scipy, numpy as
>    needed) + agent/README.md: Mac mock runbook AND pod runbook (stateless
>    env var, activate model, launch agent).
>
> VERIFY LIVE (like the echo agent): on the Mac with mock server — connect,
> passthrough (hear yourself at ~echo latency), toggle convert (hear
> yourself + ~200ms pipeline latency, no plumbing stutter), toggle back,
> confirmations round-trip, stats sane, unit tests pass, lint/build clean,
> typecheck adds no NEW errors. Report: APIs verified, files changed,
> surprises, and the exact pod runbook.
>
> Do NOT modify echo_agent.py, useVoiceStream.js, or anything in base44/.

(Also this session: created `CLAUDE.md` session-logging convention — this file is its first entry.)

### APIs verified against installed packages (never memory)

- **Python receive (livekit 1.1.13):** room event `"data_received"` delivers one
  `DataPacket` dataclass — `.data: bytes`, `.kind`, `.participant:
  RemoteParticipant | None` (None when sent by a server SDK), `.topic`.
- **Python publish:** `await local_participant.publish_data(payload: bytes|str, *,
  reliable: bool = True, destination_identities: List[str] = [], topic: str = '')`
  — confirmed coroutine via `iscoroutinefunction`.
- **JS publish (livekit-client 2.20.1):** `publishData(data: Uint8Array, options?:
  DataPublishOptions): Promise<void>` with `DataPublishOptions = {reliable?:
  boolean, destinationIdentities?: string[], topic?: string}` (types.d.ts:46).
- **JS receive:** `RoomEvent.DataReceived → (payload: Uint8Array, participant?,
  kind?, topic?, encryptionType?)` (Room.d.ts:327).
- **AudioStream:** `from_track(track=, sample_rate=48000, num_channels=1,
  frame_size_ms=None…)` — same call as echo agent; 10 ms/480-sample cadence
  (observed live at 100 fps in Stage 1 and again this session).
- **capture_frame:** coroutine; docstring states it waits until the internal
  queue (default `queue_size_ms=1000`) has space — the await IS the backpressure.
- **Also verified before use:** `rtc.ConnectionState.CONN_CONNECTED`,
  `Room.connection_state`, and that `AudioFrame.create(...).data` is writable
  through `np.frombuffer`.

### What was built

- `agent/bridge.py` — pure logic, no LiveKit/network. `WindowAssembler`
  (arbitrary frame sizes → `(seq, window[14336])` every 6144 samples,
  zero-left-pad at start, **seq monotonic across reset()** so stale in-flight
  returns are discardable by seq). `SolaStitcher` (v3 math verbatim: last
  HOP+XFADE+2·SOLA of each window, stride-8 SOLA search, sin²/cos² equal-power
  crossfade) — streaming twist: the last XFADE samples are provisional (next
  window rewrites them), so they're **held back from readers**; whole-frame
  silence on underrun (no mid-frame splice click) + counters.
- `agent/test_bridge.py` — 8 pytest tests. Strongest: sine → assembler →
  identity-stitcher reproduces the input **exactly** (SOLA offsets land on the
  hop grid at 768); plus a ×1.008-stretched variant (continuity), underrun
  counting, holdback invariants, seq-across-reset.
- `agent/rvc_client.py` — async WS client; `connect()` always does
  config + zero-window warmup (so reconnect ⇒ re-warmup by construction);
  receive loop with in-flight tracking and p50/p95 turnaround; `on_disconnect`
  fires only for unexpected drops.
- `agent/mock_rvc_server.py` — same wire protocol; FIFO per connection
  (mirrors GPU serialization); 70 ms delay, 150 ms spike every 10th window;
  output resampled ×1.008 (scipy, 126/125) to exercise SOLA like the real server.
- `agent/convert_agent.py` — echo-agent skeleton + live mode toggle; jitter
  buffer primes at 1.5 hops; in-flight ≥ 2 → drop hop; RVC warmup before room
  join; auto-fallback to passthrough (`rvc_unavailable`) + 5 s background retry
  + auto-restore (`rvc_recovered`); 5 s stats; confirmations re-sent on every
  participant join. 1 frame in → 1 frame out keeps output paced by input.
- Frontend (only the two allowed files): `useLiveKitVoice.js` gained
  `agentMode`/`agentModeReason` state fed by `RoomEvent.DataReceived` and a
  fire-and-forget `requestAgentMode()`; `LiveKitTest.jsx` gained the
  Passthrough|Convert card — buttons only *request*, the indicator shows what
  the agent *confirmed*.
- `agent/requirements.txt` pinned additions: websockets 15.0.1, numpy 2.0.2,
  scipy 1.13.1, pytest 8.4.2. `agent/README.md`: Mac mock runbook + RunPod
  runbook (RVC_STREAM_CONTEXT_SECONDS=0 documented twice, incl. troubleshooting).

### Key findings / surprises

- **The venv trap:** `agent/.venv/bin/pip` is a `#!/bin/sh` trampoline whose
  absolute path points at a *OneDrive copy* of this repo — `pip install` was
  landing in the wrong site-packages. Fix: always `./.venv/bin/python -m pip`.
- **scipy first import took 40 s** (macOS scanning fresh .so files) — made the
  mock server look dead on first launch. One warm import fixes it forever.
- Measured added latency of convert mode is **~375 ms**, not the hoped ~200 ms:
  ≈ hop 128 + turnaround ~80 + jitter buffer ~170 (1.3–1.5 hops steady).
  With the Move 2a transport figure (185 ms) that's ~560 ms vs the 500 ms
  target — the priming depth (1.5 hops) and HOP are the tuning knobs, already
  flagged as the "flow tuning" follow-up in notes.md.
- Shutdown via SIGINT prints an asyncio "task exception never retrieved"
  traceback after "stopped by user" — cosmetic, matches the run-until-Ctrl-C
  pattern, zero runtime errors.

### Files changed

New: `agent/bridge.py`, `agent/test_bridge.py`, `agent/rvc_client.py`,
`agent/mock_rvc_server.py`, `agent/convert_agent.py`, `devlog/SESSIONS.md`.
Modified: `agent/requirements.txt`, `agent/README.md`,
`src/hooks/useLiveKitVoice.js`, `src/pages/LiveKitTest.jsx`, `CLAUDE.md`
(session-logging convention), `notes.md`.
Untouched as required: `echo_agent.py`, `useVoiceStream.js`, `base44/`.

### Verification results

- Unit tests: **8/8 pass**.
- Offline pipeline smoke (assembler → RvcClient → mock → stitcher, real-time
  paced sine): 62/62 windows, 0 drops, 0 underruns, p50/p95 79/159 ms,
  max sample jump 0.0286 (= pure sine derivative → zero splice artifacts).
- **Live E2E, 11/11 checks PASS** — mock + convert_agent + scripted LiveKit
  user (Python SDK, publishes real-time 440 Hz tone) on LiveKit Cloud:
  confirmation on join; passthrough echo rms 0.354, onset 408 ms; toggle →
  convert confirmed; convert audio rms 0.355, onset 783 ms, **0/250 silent
  slices (no stutter)**; mock killed mid-convert → `agent_mode passthrough /
  rvc_unavailable` auto-sent; mock restarted → `convert / rvc_recovered`
  auto-restored; toggle back confirmed. Agent stats sane throughout
  (frames in == out, buffer ~1.3 hops, turnaround p50/p95 81/158 ms, 0 drops,
  0 underruns, 0 stale).
- Frontend: eslint clean on both touched files (the repo's 1 pre-existing
  error in `VoiceMetricsPanel.jsx` — unused `Check` import — predates this
  session, confirmed via stash, and that file is out of scope); `vite build`
  clean; `tsc` reports no errors in the touched files (all pre-existing
  errors are in Register/ResetPassword/etc.).
- Human ear test still worth a minute: run the Mac runbook in
  `agent/README.md` and listen for the ~0.4 s echo in convert mode.
