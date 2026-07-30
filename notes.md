# LuminaStream — Work Log

Running summary of every working session, **newest entry first**. Each entry: what was done, which files changed, how it was verified, and the next step. This file is the standing summary channel — check the top entry for the most recent work.

## 30 July 2026 — CONSOLE POLISH + VOICE CONTINUITY: CEO tuning-session findings (PR pending, HOLD FOR CTO)

- Branch feat/tts-continuity-comfort off main (PR #18 merged first). Six tickets, one PR.
- **T1 request continuity (tone-drift fix):** verified vs docs — `previous_request_ids` (max 3) via the `request-id` header, full body read first, **NOT on eleven_v3**. Engine conditions each utterance on the prior; resets on session/voice/model change; bool knob `request_continuity` (default on). Panel marks "stitched".
- **T6 voice selector:** `GET /v1/voices` agent-side (free GET, browser never holds the key); dynamic `voice` enum w/ display names; apply validates + loads the new voice's own settings + resets continuity; refresh button; export pins voice_id+name; ELEVENLABS_VOICE_ID stays startup default. **Shared Library out of scope** (separate machinery) — flagged.
- **T2 comfort noise:** ComfortNoise bed (LPF white, crossfaded, dBFS) under gate-closed silence; knob `comfort_noise_db` (-80 off…-40); OFF=exact zeros so RVC byte-identical; analyzer taught the floor so the bed classifies as silence.
- **T3 punctuation:** confirmed transcript reaches synthesis verbatim (test pins ? ! …); panel shows terminal punctuation as the prosody channel.
- **T4 governor:** env names in tooltip, one-decimal remaining budget, README preset; caps stay env-only.
- **T5 layout:** knob grid overlap fixed (single-col until lg, min-w-0 + truncate + tabular-nums).
- Verified: 174 py (+19) / 26 node (+2) / lint clean / typecheck +0 / build green. RVC untouched.
- **Deviations flagged:** shared Library out of scope; comfort = operator-tuned shaped noise (not auto-derived); continuity via ids not previous_text.
- **Next:** open PR → CodeRabbit → **CTO presses merge**. Live E2E (continuity ×3, comfort by ear, voice switch) is the acceptance run.

## 29 July 2026 — TTS TUNING CONSOLE retooled for --engine tts (MERGED, PR #18)

- **Retooled the Phase 4 console for tts by EXTENDING the existing path** (registry → set_config under the FIFO lock → clamp → apply → config_change capture → agent_config broadcast → applied-truth badges) — no parallel system. RVC knobs stay (parked engine).
- **Verified voice_settings against live ElevenLabs docs.** Added the 5th param the brief omitted (`speed`) + a `bool` kind (`use_speaker_boost`) + `tts_model` select. Per-model validation: `eleven_v3` has NO `similarity_boost`/`use_speaker_boost` (quoted from docs) → UI disables with reason, agent rejects the set. Audit picks: `min_speech_ms` (real), `queue_wait_warn_ms` (diagnostic).
- **Config-as-code:** committed `agent/tts_profile.json`; precedence CLI/env > profile > clone settings > registry defaults, logged at startup. Frontend **Export JSON** downloads agent-confirmed config (never slider state) in the shape the loader reads back — round-trips. Governor caps shown read-only (stay env-only by design).
- **Addendum both done:** Live Transcript panel (consumes the existing `tts_utterance` messages — stt/ttfb/tail/chars/model/wer); warm-on-join fires a real 1-char warmup **synthesis** on participant_connected (flagged: the drill said "ping" but a GET ping can't move TTFB; only a synthesis warms the voice model).
- **Deviations flagged in PR:** ping→synth; profile keeps clone-settings as an intermediate layer; flash+style left enabled (docs contradictory).
- Verified: 155 py (+15) / 25 node (+6) / lint clean / typecheck +0 over baseline / build green. RVC suite untouched.
- **Next:** open PR → CodeRabbit → evidence replies → **CTO presses merge**. Live E2E (drill + free-talk, 3 models, watch transcript + governor line) is the acceptance run.

## 28 July 2026 — FRONTEND DEPLOY AUTOMATED: Pages recovered, deploy is now a property of the merge (PR pending, HOLD FOR CTO)

- **The frontend exists again.** Created Pages project `luminastream-studio` (prod branch `main`) and ran the first deploy from `fix/pages-deploy-automation`. Live now at **https://luminastream-studio.pages.dev** — `/` and `/livekit-test` both serve the app HTML shell (`#root`), not JSON. Bundle has `VITE_API_BASE=https://luminastream-api.obenholdingsltd.workers.dev` baked in.
- **Deploy is automated.** `.github/workflows/deploy-pages.yml` mirrors deploy-worker.yml: push to `main` touching build inputs → npm ci → guard that FAILS if `vars.VITE_API_BASE` empty → build → `wrangler-action pages deploy dist` pinned to wrangler 4.36.0. GITHUB_TOKEN stays read-only (no `gitHubToken` passed — it's optional, only writes a Deployment record).
- **New instrument:** `scripts/check-live.sh` — 3 layers (Worker /api/health, Pages /, Pages /livekit-test), one PASS/FAIL line each, nonzero exit on any fail. Positive run: all PASS. Negative run (`PAGES_URL=studio.luminastream.live`, still the Worker): FAIL exit 1, shows the `{"ok":false,"error":"not_found"}` JSON — catches the exact incident.
- **README:** deleted the manual dashboard-clicks section; documented the automated flow + the two deliberate human walls (token Pages:Edit edit — done; domain move off Worker onto Pages — pending, DNS human by doctrine). Fixed two stale "set VITE_API_BASE in the Pages dashboard" refs (it's a GitHub Actions variable now).
- **Surprise:** `CLOUDFLARE_API_TOKEN` is NOT in secrets.env; wrangler runs off an OAuth session with `pages (write)` on the correct account. Proceeded on that; authoritative check of the *CI secret's* Pages:Edit is the first green workflow run on merge.
- **Next:** open PR → CodeRabbit → evidence replies → **CTO presses merge**. Domain move is Amy's manual step post-merge.

## 28 July 2026 — GRADUATION: STT→TTS is now the DEFAULT engine (PR #15 ready for review)

- **CEO verdict (verbal, 28 July 2026), recorded verbatim:** *"clean 7/10, beats RVC on purity, emotions inconsistent vs live prosody."* CTO approved the PR for merge on the strength of it.
- **The full 3-model scorecard was NOT completed.** The verdict above is a single verbal assessment, not the structured drill: there are no per-model clean / latency-feel / "is it ME?" scores for `eleven_flash_v2_5`, `eleven_multilingual_v2` or `eleven_v3`, and the table in SPIKE.md remains blank. Treat "7/10" as an overall impression of the shipped default config, not a per-model result.
- **Two caveats that limit what the verdict can mean.** (1) The voice under test is the clone at `ELEVENLABS_VOICE_ID`, named "Celebrity lilcrush linda" — not Amy — so no "is it ME?" judgement has actually been made. (2) *"emotions inconsistent vs live prosody"* is the expected structural cost of this architecture, not a tuning defect: the engine discards the speaker's delivery at the transcript boundary and re-generates prosody from text alone. RVC preserves delivery because it never leaves the audio domain. That trade is what "beats RVC on purity" buys — worth revisiting against `voice_settings` (stability/style) and `eleven_v3` before accepting it as the ceiling.

- **Pivot committed (08cf39e):** `--engine` defaults to `tts`. RVC is NOT removed — `--engine rvc` is the parked baseline/fallback, unchanged and green. Rests on measured evidence: tail p50 1938→932ms, p95 2511→949ms (drill); live conversation 86 utterances p50 1001ms/p90 1111ms; quality flat throughout (transcripts byte-identical, WER unchanged 0.1458, no splitting/clipping).
- **Ear-drill: superseded by the verbal verdict at the top of this entry.** The pivot commit (08cf39e) was written before any verdict existed and states that the scores were unrecorded — still true of the per-model scorecard, which remains blank in SPIKE.md. Fill it in there if the 3-model drill is ever run.
- **Remaining floor:** ~400ms of the ~950ms p50 is Starlink RTT (measured: 200ms TCP, 433ms TLS to api.elevenlabs.io). **VPS deploy should reach p50 ~550-650ms with zero code change** — the biggest lever left. Needs ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID hand-typed into the VPS secrets.env by Amy; deploy sequence + preflight in agent/README.md.
- **p95 in live conversation (1920ms) is structural, not a defect:** synthesized audio plays for about as long as the speech took to say, so continuous talking accumulates backlog that drains at pauses. Video-sync budget for the avatar leg must be ELASTIC, not fixed.
- Merged origin/main (workers/api + server-mint frontend) — only conflict was SESSIONS.md ordering, both histories kept. All suites green: 136 py + 21 src/lib + 35 workers/api. Positive preflight added (STT READY / TTS READY / PREFLIGHT OK; failures are plain sentences, never tracebacks). CodeRabbit round complete (10 findings, all addressed — see PR #15). **CTO has since approved for merge; the merge itself is still the CTO's to press.**

## 28 July 2026 — Optimization sprint: tail latency HALVED, target met (full record: devlog/SESSIONS.md)

- **p50 1938 → 932ms, p95 2511 → 949ms** on the same drill, quality untouched (transcripts byte-identical, WER unchanged 0.1458, 5/5 utterances). Default config is `--tts-hangover-ms 200`; one launch command in SPIKE.md.
- Wins: streaming STT while the gate is open (STT 1121→315ms; test contract amended deliberately to "nothing COMMITTED while open"), and connection keepalive — the first-utterance ~1040ms TTFB was aiohttp's pool reaping the idle connection (default timeout 15s, my ping was 20s, so it always arrived too late). Rejected: `optimize_streaming_latency` + text normalization, both pure noise.
- **~400ms of the remaining 954ms is Starlink RTT** (measured: 200ms TCP, 433ms TLS). VPS topology is the biggest lever left — should reach p50 ~550-650ms with no code change. **Needs ELEVENLABS_API_KEY in the VPS secrets.env — Amy to place it, I did not copy it.**
- Trap avoided: analyzer's "clipped tails" is meaningless in tts mode (3 at 300ms baseline, 3 at 200ms, 2 at 100ms; envelope corr 0.047) — nearly cited it as clipping evidence. Analyzer now disowns it; transcripts are the real evidence.
- Open for the CEO's ear: aggressive `--tts-hangover-ms 100` hits p50 787ms but may split sentences at natural pauses — the drill (1.6s gaps) cannot show this, free-talking can. Both configs presented, not chosen.

## 28 July 2026 — SPIKE: STT→TTS engine measured; answer is NO (draft PR, full record: devlog/SESSIONS.md)

- Built `--engine tts` (Scribe v2 Realtime → cloned-voice TTS) behind the existing agent; `--engine rvc` default and bit-identical (RVC client never constructed in tts mode). Governor written+green BEFORE any billable call: per-run caps, skips utterances whole, never truncates.
- Live E2E, 3 models: tail_latency p50 1938 / 2459 / 2741 ms (flash / v3 / MMv2) vs RVC's ~200 ms. ~1.5s of it is serialized vendor round trips → structural, not tuning. 0 skipped, 0 underruns, 0 clipped tails, ~990 chars/min of speech.
- Surprises: `output_format` is a query param (body → silent MP3); HTTP beats the TTS websocket everywhere and v3 rejects WS entirely; 16k STT upload cut latency-to-final 1463→871ms; v3 was NOT the slowest — MMv2 was; WER can't vary by TTS model (all 7 edits = one digit-normalization line, other four lines 0.0).
- **Decision: branch stays DRAFT.** Good turn-taking tech, wrong for live conversion. Voice ID in secrets.env is named "Celebrity lilcrush linda", not Amy — confirm before "is it ME?" scoring.
- Next: Amy's drill (SPIKE.md protocol, 3 scores x 3 models). If revisited: stream audio to STT while the gate is open (~800-1000ms saving, deliberately out of scope here).

---

## 28 July 2026 — Micro-fix: pin wranglerVersion in deploy workflow, PR #16 held (full record: devlog/SESSIONS.md)

- PR #14 MERGED (2d37382) → first deploy-worker.yml run FAILED: wrangler-action fell back to
  its bundled wrangler 3.90.0 (no wrangler.jsonc support — that's 3.91+) → exit 1.
- Fix: pin `wranglerVersion: "4.36.0"` on the cloudflare/wrangler-action step (verified input
  name in the action's docs; exact = deterministic; matches workers/api/package.json ^4.36.0).
- Verified: workflow YAML parses, pin on the right step. Full run confirmable only post-merge.
- Next: PR #16 → CodeRabbit → **HOLD MERGE for CTO**; after merge, confirm Actions green +
  `curl <worker-url>/api/health`.

---

## 28 July 2026 — S3-Lite B: API Worker (admin gate + LiveKit mint), PR #14 held for CTO (full record: devlog/SESSIONS.md)

- `workers/api/` Cloudflare Worker, **zero deps**: GET /api/health; POST /api/admin/verify
  (rate-limit 5/60s → constant-time SHA-256 digest compare → 12h HMAC session token);
  POST /api/livekit/token (30/60s IP limit → X-Admin-Token gate → hand-rolled HS256 LiveKit
  token, 6h clamp). CORS: studio + *.luminastream-studio.pages.dev + localhost:5173.
- Minted by hand via Web Crypto (SDK pulls Node-only siblings); claims verified vs
  livekit-server-sdk + its TokenVerifier + the **real LiveKit Cloud** (Twirp ListRooms → 200).
- Frontend: `src/lib/serverMint.js` + LiveKitTest "Mint via server" (gated on VITE_API_BASE);
  manual paste stays the dev fallback. README has Amy's exact wrangler secret/deploy steps.
- CodeRabbit round closed (75a1f47): 1 Major (rate-limit ordering on token endpoint — now
  limit-first, +regression test) + 1 docs, both confirmed resolved, re-review pass.
- CEO addendum (CI/CD): `.github/workflows/deploy-worker.yml` (push main+workers/** →
  tests → wrangler-action@v3 deploys **production**); wrangler `env.staging` (agent/manual
  deploys default to staging via `npm run deploy`); `scripts/put-worker-secrets.sh`
  (secrets.env → stdin → `wrangler secret put`, never echoed); README = narrow token mint
  (Workers Scripts:Edit + Account Settings:Read, **no DNS**) + GitHub secrets; custom-domain
  DNS stays a human act. Verified: both dry-runs bundle, YAML + `bash -n` OK.
- Owner follow-up: session secret documented as `openssl rand -base64 32` into secrets.env
  (README + .dev.vars.example); ADMIN_SESSION_SECRET rotation noted as the **kill switch**
  (invalidates all outstanding sessions). Script already set all 5 secrets; base64 `=`-padding
  extraction proven byte-exact.
- Verified: 35/35 worker + 21/21 frontend tests, lint clean, typecheck at main baseline (+0),
  build green, `wrangler deploy --dry-run` bundles both prod + staging w/ rate limiters.
- CodeRabbit: 2 rounds, **4/4 findings resolved** (round 2: secret-script preflight + checkout
  persist-credentials:false, both confirmed). Check green; PR #14 mergeable.
- Next: **HOLD MERGE for CTO** on PR #14; on merge, workflow auto-deploys production (needs
  CLOUDFLARE_* GitHub secrets). Amy: token→GitHub, run secret script, set VITE_API_BASE.

---

## 27 July 2026 — S3-Lite A: Cloudflare Pages hosting, PR #13 (full record: devlog/SESSIONS.md)

- Chose git-connected Pages over wrangler (verified live CF docs): dashboard-only, zero Cloudflare config/keys in the public repo. Build: npm run build → dist, preset Vite. /livekit-test works via automatic SPA fallback (no 404.html in output) — proven on built dist w/ vite preview + headless Chrome.
- VITE_API_BASE (src/lib/apiBase.js, default '' fail-soft) feeds SDK serverUrl + AuthContext baseURL; wire-through proven in bundle. README has Amy's exact dashboard clicks incl. studio.luminastream.live custom domain.
- CodeRabbit round done (378aa45): per-host fail-soft wording fixed (dev 404 vs Pages 200-shell); build-fixture test added proving VITE_API_BASE bakes into the bundle. 8/8 apiBase + 5/5 knobState + lint clean. Replies posted.
- PR #13 open, merge HELD for CTO. Next: CTO decision; then Amy runs the README clicks.

---

## 27 July 2026 — Live E2E green, PR #12 MERGED (full record: devlog/SESSIONS.md)

- Starlink DNS recovered → lk_smoke CONNECTED OK → ran staged knob-twisting E2E (real agent + LiveKit Cloud + mock RVC): valid change applied verbatim; garbage change clamped/rejected cleanly, agent never crashed.
- Capture + analyzer verified live: config_change snapshots in meta.jsonl, config markers on dropout map, gated-hop-excluded buffer stats, VAD-gated attribution at 8% activity. Evidence on PR #12.
- PR #12 merged to main on owner's go-ahead — Phase 4 tuning console shipped.
- Next: pod tuning session per README A/B protocol (one knob at a time, fixed script, score, revert).

---

## 27 July 2026 — PR #12 CTO condition: config applies serialized (full record: devlog/SESSIONS.md)

- `_apply_config` body now runs under `self._config_lock` (asyncio.Lock in __init__): applies strictly FIFO, every agent_config broadcast reflects its apply's true final state — closes the RVC settings-frame interleave hazard ca4c302 left open.
- New test `test_overlapping_applies_serialize_fifo`: overlapping applies w/ slowed first send; LAST value must win in rvc.config, final broadcast, and last server frame. Verified to FAIL with the lock neutralized.
- 49/49 py + 5/5 node. Commit 9159ebb pushed; replied on PR #12 as the CTO-requested serialization.
- Merge still HELD for CTO sign-off. Next: CTO decision on #12; live knob E2E still blocked on Starlink DNS.

---

## 27 July 2026 — Phase 4: live tuning console (full record: devlog/SESSIONS.md)

- Tuning card on /livekit-test: RVC knobs (index_rate/protect/rms_mix_rate/f0_method) apply **mid-stream on the open socket** — verified in OpenVoiceChanger source @4cee7ef, no reconnect path needed; agent knobs (prime_hops, vad_threshold, vad_hangover_ms) instant. Clamp-never-crash registry in agent/knobs.py; agent broadcasts agent_config {config, defaults, ranges} and the UI renders ONLY that (applied-truth).
- Capture logs config_change with full applied snapshot; analyzer draws config markers + two fixes: buffer-depth stats now gate-open-only; VAD-gated bar recalibrated to measured duty-cycles (typing 8%, clap 5.3% → bar 2.5%).
- 48/48 py + 5/5 node tests. LIVE E2E BLOCKED: Starlink DNS (100.64.0.2) blackholes *.livekit.cloud (1.1.1.1 resolves fine) — rerun knob-twisting E2E when DNS recovers.
- PR open, merge HELD for CTO review. Next: pod tuning session per README A/B protocol.

---

## 24 July 2026 — Phase 3.1: ONNX diet (full record: devlog/SESSIONS.md)

- VAD inference switched to onnxruntime (`load_silero_vad(onnx=True)`, onnxruntime==1.19.2) — kills the NNPACK warning spam on the VPS; probabilities verified identical to the JIT path (fox 99% chunks ≥0.5).
- torch stays (silero imports it for tensor plumbing; OnnxWrapper rejects numpy) but now pinned CPU-only via the pytorch cpu index with platform markers — sheds the ~5 GB of nvidia-*-cu12 wheels the VPS pulled.
- 37/37 tests; branch fix/phase3-1-onnx-diet → PR.

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

Phase 3 Accepted. VAD successfully implemented, non-speech hallucination eradicated. Phase 3.1 micro-PR initiated to strip torch bloat via ONNX.