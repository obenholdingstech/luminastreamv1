# LuminaStream — Work Log

Running summary of every working session, **newest entry first**. Each entry: what was done, which files changed, how it was verified, and the next step. This file is the standing summary channel — check the top entry for the most recent work.

---

## 23 July 2026 — Phase 3: Silero VAD gate shipped (full record: devlog/SESSIONS.md)

- Convert agent now VAD-gates the RVC pipeline (silero-vad 6.2.1, 512@16k chunks, 4/hop): speech+300ms hangover sent, everything else clean output silence with 15ms equal-power edge ramps; context accumulates through gates; fail-open like the RVC fallback; gated hops enqueue nothing (idle GPU) and aren't drops. Flags: --no-vad / --vad-threshold 0.5 / --vad-hangover-ms 300.
- Analyzer attributes silences three ways: benign / VAD-gated (intentional) / dropout — E2E vs mock with real silero: typing+clap → VAD-GATED, speech through, 0 clipped tails, 0 dropouts, gate never opened for noise. 37/37 tests.
- agent_mode payload gains additive vad {enabled, gate, threshold, hangover_ms} — Phase 4 console consumes it; current frontend unaffected.
- Next: pod acceptance run per README Phase 3 protocol (compare garble dropouts vs Phase 2 Session A), then Phase 4 console.

---

## 22 July 2026 (late) — Phase 2 CTO fixes (full record: devlog/SESSIONS.md)

- NS/EC/AGC readout now renders the browser's APPLIED settings (`getSettings()` after publish/restart), amber ⚠ on request-vs-applied mismatch — browsers silently ignoring constraints is now visible, which is itself Phase 2 data.
- `CTO_HANDOVER*.md` gitignored (checked: never tracked, no history scrub needed). README protocol: macOS mic mode "Standard" + built-in mic only.
- gh CLI available at `/opt/homebrew/bin/gh` (not on PATH) — PR updated with it; awaiting CodeRabbit.

---

## 22 July 2026 (night) — Phase 2 frontend: mic-processing toggles (full record: devlog/SESSIONS.md)

- `/livekit-test` now has NS/EC/AGC toggles (default ON = browser default), applied via `setMicrophoneEnabled(true, AudioCaptureOptions)` at publish and `restartTrack` live — **no reconnect needed**, track SID survives (live-verified in headless Chrome against LiveKit Cloud). Active state shown next to the agent-mode indicator.
- Gotcha found: livekit-client injects `deviceId {ideal:'default'}` into restart constraints — hook pins the current device with `{exact}` so toggles never switch mics. Headless Chrome now needs `--auto-accept-camera-and-microphone-capture` for fake-mic runs.
- README: Phase 2 protocol = two convert-mode captures (all-ON vs all-OFF, fox + "mic test one two"×3), compare clipped-tail reports.
- Next: run the experiment on the pod session and compare `report.txt` tail-clip counts between the two sessions.

---

## 22 July 2026 (eve) — CodeRabbit fixes on feat/capture-analysis-runbook (full record: devlog/SESSIONS.md)

- capture.py is now unkillable-by-design: 60s un-flushed-audio bound, 1h duration cap (WAV uint32 headroom), writer-failure handling — any trip disables capture for the session (ONE loud log, buffers freed, hot path no-ops), agent audio untouched.
- Stale windows pop their pending entry (`window_stale`) — each window counted exactly once; runbook UFW commands now runnable + RVC pinned to validated commit 7b284a63 (deterministic DR).
- 23/23 tests (3 new); fresh mock convert capture: 340 ms offset, 86/86 windows, analyzer clean. Pushed to same branch.
- BLOCKED: posting CodeRabbit replies — no `gh` on this machine; drafts in agent/captures/PR_REPLIES.md ready to paste (install gh to automate next time).

---

## 22 July 2026 (pm) — Phase 1 diagnostics: capture mode + analyzer + runbook (full record: devlog/SESSIONS.md)

- `convert_agent.py --capture-dir` records per-session input/output WAVs + meta.jsonl (windows, drops, underruns, stale, mode changes, buffer depth/hop) via new `capture.py` — zero sync disk I/O in the frame loop, provably inert without the flag.
- `analyze_capture.py`: aligned waveforms (xcorr latency), spectrogram pair, RMS overlay + tail-clip detector, dropout map (benign silence vs DROPOUT vs input), report. 12 new tests; 20/20 pass. matplotlib + aiofiles now pinned.
- Verified vs mock both modes: passthrough offset 0 ms (corr 1.000), convert 340 ms (corr 0.978, buffer that run 1.44 hops), 0 clipped tails / dropouts.
- `lk_smoke.py` (portable CONNECTED-OK gate) + `runbook.md` (full DR recipe: pod template/ports/TCP-direct, uv venv + torch cu128 pin, VPS setup, Stop-not-Terminate). README's old "agent on pod" runbook marked SUPERSEDED.
- Next: run the capture protocol against the REAL RVC pod to make "chunky gibberish" visible, then tune (prime depth/HOP/XFADE) off the evidence.

---

## 22 July 2026 — Move 2b COMPLETE: convert agent live-verified (full record: devlog/SESSIONS.md)

- Built `agent/bridge.py` (+8 passing tests), `rvc_client.py`, `mock_rvc_server.py`, `convert_agent.py`; frontend toggle + agent-truth mode indicator in the two allowed files. Runbooks (Mac mock + pod) in `agent/README.md`.
- Live E2E on LiveKit Cloud vs mock: 11/11 PASS — toggle round-trips, fallback (`rvc_unavailable`) + auto-recovery (`rvc_recovered`), zero stutter/underruns, turnaround p50/p95 81/158 ms.
- Measured convert-mode added latency ~375 ms (hop 128 + turnaround ~80 + jitter buffer ~170) → ~560 ms total vs 500 target; priming depth (1.5 hops) and HOP are the tuning knobs.
- Gotcha: `agent/.venv/bin/pip` writes to a OneDrive repo copy — always `./.venv/bin/python -m pip`.
- Next: flow tuning (prime depth/HOP/XFADE), then pod test with real RVC (`RVC_STREAM_CONTEXT_SECONDS=0`, `--mode convert`); ear test via Mac runbook.

---

## 20 July 2026 — /livekit-test now plays the echo agent's audio 🔊

**Outcome:** the test page attaches any remote audio track (the echo agent's returned stream) to an auto-playing `<audio>` element the moment it arrives, and cleans it up on unsubscribe, disconnect, and page unmount — no lingering audio, no leaked elements. A new indicator in the header shows **remote audio: none / playing (identity) / blocked — enable** (the "blocked" state covers browser autoplay policies, with a one-click fix).

**Files changed (only the two allowed):**
- `src/hooks/useLiveKitVoice.js` — track attach/detach lifecycle, playback-blocked detection, `remoteAudio` + `audioBlocked` state, `enableAudio()` action; all handlers carry the same orphaned-room guards as the connect/disconnect race fixes.
- `src/pages/LiveKitTest.jsx` — the indicator UI (Volume icons, three states, enable button).

**Exact APIs used** (each verified in the installed livekit-client 2.20.1 before coding): `RoomEvent.TrackSubscribed` / `TrackUnsubscribed` → `track.attach()` (creates the `<audio>` element and attempts autoplay) / `track.detach()` (returns all elements for removal); `RoomEvent.AudioPlaybackStatusChanged` + `room.canPlaybackAudio` + `room.startAudio()` for the autoplay-blocked path.

**Verified live** against the running echo agent in headless Chrome: element attached and actually *playing* (`paused: false`, `readyState: 4`, 1 audio track, ~9 KB/s arriving), then detach removed it completely (0 `<audio>` elements left in DOM). Lint, typecheck, and build all clean.

**Try it:** start the agent (`cd agent && ./.venv/bin/python echo_agent.py`), open `/livekit-test`, connect as test-user — you should now **hear your own voice echoed back** through the server (~200 ms behind, which is the transport round trip both ways).

**Next step:** this completes the browser side of the Stage 1 loop. The natural follow-on is replacing the echo passthrough with the first real voice-conversion worker (RVC benchmark), per the blueprint.

---

## 20 July 2026 — Echo agent built & verified (Python, `agent/`)

**The echo agent is built and the full loop was verified live**: browser (fake mic, as `test-user`) → LiveKit Cloud → Python agent → back to the browser. The agent processed 100 frames/second with received == published exactly (2,618/2,618) and zero drops; the browser confirmed it subscribed to the agent's track (matching SID) with echo audio arriving at ~77 kbps. Nothing in src/ was touched.

### API research findings (verified before writing code)

**Framework verdict: the plain `livekit` rtc SDK is the right fit, not `livekit-agents`.** The agents framework (1.6.6, July 2026) is built around LLM voice pipelines (`Agent`, `AgentSession`, `JobContext`, STT/TTS integrations) — no raw-passthrough path, unnecessary dispatch plumbing. The rtc SDK (livekit 1.1.13, Python ≥3.9) gives direct frame access. Revisit the framework when the real voice-conversion GPU worker needs orchestration.

Research caveat: LiveKit restructured their docs site (Python reference URLs 404), so every signature was verified against the installed packages via introspection — stronger anyway.

**APIs used** (livekit 1.1.13 / livekit-api 1.2.0): `api.AccessToken(key, secret).with_identity("echo-agent").with_grants(api.VideoGrants(room_join=True, room=…)).with_ttl(…).to_jwt()` (server-side minting from secrets.env); `rtc.Room.connect(url, token, RoomOptions(auto_subscribe=True))`; `rtc.AudioStream.from_track(track=…, sample_rate=48000, num_channels=1)` (resamples, so stream and source always match); `rtc.AudioSource(48000, 1)` + `rtc.LocalAudioTrack.create_audio_track` + `publish_track(…, TrackPublishOptions(source=SOURCE_MICROPHONE))`.

**What differed from expectation:**
- The room's `connected` event never fires on initial connect in this SDK version (observed live) — the join is logged after `connect()`, state via `connection_state_changed`.
- `AudioSource.capture_frame` is a coroutine whose await IS the flow control — "drops" only occur on errors, which the agent counts and logs.
- `connection_state_changed` delivers a raw protobuf int; mapped through `ConnectionState.Name()` for readable logs.

### What's in agent/

`echo_agent.py` (logs connection state, participants, per-5s frame stats with drops; ignores `echo-*` identities to prevent agent feedback loops; adopts one human track at a time), `requirements.txt` (pinned), `README.md` (setup/run/troubleshooting), local `.gitignore` for the venv.

**To run:** `cd agent && ./.venv/bin/python echo_agent.py` (from scratch: `python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt`).

Sources: [LiveKit Agents repo](https://github.com/livekit/agents), [LiveKit python-sdks repo](https://github.com/livekit/python-sdks), [livekit on PyPI](https://pypi.org/project/livekit/), [LiveKit Agents docs](https://docs.livekit.io/agents/)


####
RVC Baseline Validation (Applio Test):

"Local Applio test on RTX 3060 proved real-time RVC conversion runs with low latency on lower-end hardware. Confirms RVC architecture is fast enough for live streaming; focus remains on WebRTC transport bridge."

Voice Cloning Sample Duration (Stage 4):

"Stage 4 — Voice Cloning: Decide reference audio duration (e.g., 1 min vs. 2 min vs. 4 min) after selecting the exact cloning method."

MCP Infrastructure Automation (Stage 5):

"Stage 5 — Scale & Harden: Evaluate @runpod/mcp-server and LiveKit MCP servers for agent-driven infrastructure once manual deployments are routine."
###

Move 1 complete (21 Jul): RVC server relaunched from EU-RO-1 volume koehrg7i63. aloy_beta12333333.pth loaded on cuda:0, target_sr 40000, activated OK. Models intact (hubert 181M, rmvpe 173M). Applio datapoint: real-time RVC ran fine on RTX 3060 — model speed is not the risk; the streaming bridge is. Next: Move 2 — LiveKit↔RVC frame bridge with passthrough/convert toggle.

Decision (provisional, 21 Jul): cloning is ASYNC — quality over instancy. 30–60min clone wait is acceptable UX. RVC baseline remains valid; model benchmark = quality first, latency second. Research doc's zero-shot candidates (Seed-VC etc.) to be verified against real repos/weights/licenses during benchmark phase.

Move 2a COMPLETE (22 Jul): stateless server (RVC_STREAM_CONTEXT_SECONDS=0) + client SOLA. 6.9/10 flow, RTF 0.55, 384ms worst-case budget. Failed approaches: stateful+naive chunks (4/10), stateful+overlap (context pollution, 5/10). Remaining: flow tuning (XFADE/SOLA/CTX) in agent; timbre leakage → benchmark phase with proper .pth.

VPS kernel (for the runbook environment record): 6.8.0-110-generic.

Phase 2 verdict (22 Jul, pod session): the browser is innocent — the "word-clipping" issue is re-scoped to a low-priority Starlink return-path issue. New standing testing protocol: mic-processing toggles OFF + closed headphones.