# LuminaStream — Work Log

Running summary of every working session, **newest entry first**. Each entry: what was done, which files changed, how it was verified, and the next step. This file is the standing summary channel — check the top entry for the most recent work.

## 2 August 2026 (overnight close) — P1 CLOSED: 6/6, two people at once (#40, #41 merged)

- **The multi-user run passed against production:** two contexts, concurrent Starts, two DIFFERENT rooms (`luminastream-test` + `luminastream-2`), live 2 → both released → live 0. `check-live.sh` PASS ×3. **P1 closed** — planned ~1½ weeks, done in a day.
- **Open debts, unchanged:** CEO's scored voice drill (same-day log when run); concurrent-CPU `top` drill before the pool grows past 6; staging agent → E2E-in-CI; `phase='stopping'` polish → P7. **Next phase: P2 — video, spend wall FIRST, Decart key only after it merges.**

## 2 August 2026 (night) — P1c: TWO AGENTS LIVE, capacity constant measured (#39, #40)

- **#39 (zero findings — first clean pass):** systemd template `lumina-agent@<room>`; deploys restart + gate EVERY agent unit by name; harness 39→50 assertions. CEO ran the runbook cleanly; her paste showed the deploy had already restarted the primary itself.
- **THE CONSTANT (first measurement, 2 Aug):** 7.8 GiB/4-core box; **~350 MiB RSS per agent** (325–338 observed, Silero-dominated); ~3 % lifetime-avg CPU ⇒ **⌊6963/350⌋ = 19 agents RAM-bound**. Caveat: `ps %cpu` is lifetime average — concurrent-load CPU unmeasured ⇒ **hold pool ≤ 6** until a two-conversation `top` drill. Floored, never rounded.
- **#40:** pool = `luminastream-test,luminastream-2`, capacity **2**. E2E capacity-agnostic + paced (verify limiter is 5/60 s doctrine; the robot slows down instead). New test: **two browser contexts holding two sessions in two rooms simultaneously** — skips honestly while deployed pool is 1; 6/6 expected post-merge.
- **Still owed:** CEO's scored voice drill (same-day log when run); concurrent-CPU measurement before pool > 6.

## 2 August 2026 (late) — INCIDENT: stuck slot → reset tool, root cause, E2E harness (#37 merged, #38)

- **CEO's drill hit `503 at_capacity` with no session visible** — one stuck slot holding the only room. Unblocked by running the new `scripts/reset-sessions.sh production` (`live:1 → released:1 → live:0`).
- **Root cause found by instrumented E2E, not reading:** create 200 → LiveKit WS `ERR_NAME_NOT_RESOLVED` (**Starlink DNS blackhole, active** — host resolves via 1.1.1.1) → Stop clicked → **zero `/api/session/end` on the wire**. `stop()` sequenced the release behind `await disconnect()`; a teardown wedged mid-connect HANGS (the #35 try/finally only covered rejection). Second defect: Stop was `disabled` while Connecting — an unreleasable hold for anyone wedged mid-connect.
- **Fix (#38):** release first, teardown in parallel; Stop reachable from every held state; Reconnect button when holding-but-disconnected (slot+grant still valid, retry is free).
- **Playwright installed (CEO demand): `npm run e2e`** — her drill automated: start/stop/start-again/busy-in-words/leave-page, all asserting the SERVER agrees, screenshots+traces per run. Old bundle 3/5 red, fixed bundle **5/5 green** — that old-vs-new run is the discrimination. Not in CI (needs admin password, consumes the prod slot); on-demand like check-live.sh.
- **CEO's Mac still needs the OS-level 1.1.1.1 DNS fix** before voice connects on Starlink. Capacity=1 = one agent exists, not policy; P1c multiplies agents.
- **Next: merge #38, CEO retries after DNS fix, then P1c** (second agent + capacity constant, her hands).

## 2 August 2026 — P1b SHIPPED: the lens takes a real session (#34, #35 merged)

- **CEO decision: the admin password stays as the lens door for now** (3 options offered; gate retires in P4 when accounts exist). So P1b was plumbing, not a door change.
- **#34 — "a session slot is a room with an agent in it."** Found while wiring the lens: `/api/session/create` was inventing room names, and **no agent joins a name we made up**. The browser would have connected, published its mic and waited forever while the registry reported a healthy session. Rooms now come from a **pool**; two limits kept distinct — `SESSION_ROOMS` (physical: rooms with an agent) and `MAX_CONCURRENT_SESSIONS` (policy), capacity = `min(pool, policy)` so the knob can never admit **more** than there are agents (`min` permits equality — with one agent and a cap of 1 it *is* equality). **P1c is now one command plus one config line**, not a design problem. `SESSIONS_ENABLED=false` on staging, because no agent serves it and issuing credentials for silence is the same bug through a config door.
- **#35 — the lens.** Server picks room + identity + grant; client picks nothing. Slot held **Start → Stop**, released on Stop, unmount, and `pagehide` (`fetch` + `keepalive`, not `sendBeacon`, which cannot set the auth header). Refusals say something true: `at_capacity` (retry) vs `sessions_disabled` (do not). A busy lens no longer costs the user their access key.
- **Five review rounds, 11 findings — 4 of the 6 real bugs were in code written to fix an earlier round.** That is the number worth remembering, not the total.
- **Three defects were in my own tests.** One asserted the bug as correct behaviour (early return on a hidden failure → Start button dead until reload). One replacement test hid the page *after* the failure, so it never touched the path it named. One asserted messages were "different" when a regression still produced a different — but useless — message. All three found by mutation, not by reading.
- **CodeRabbit cited our own `AGENTS.md` rule** — logic belongs in `src/lib/`, tested without a browser — against lifecycle code I had put in `Studio.jsx` and shipped with a note saying it was untested. **That note is what the rule exists to prevent.** Extracting to `sessionHolder.js` (22 tests) then *found* a bug: a bfcached page returns holding credentials for a room since given to someone else.
- **Declined with reasoning:** server-side abort-reclaim when the browser dies mid-create. The abort can fire after a success is already in flight, turning a rare 2h stall into a rare mid-call eviction. Known window; revisit in P1c.
- **Verified:** 132 frontend / 100 worker / 224 agent; lint, typecheck, build, both deploys green, `check-live.sh` PASS ×3. **NOT verified: no live drill yet** — Start→Stop→Start and Start→navigate-away→Start are precisely what no test reaches. Awaiting the CEO; logged same day per convention.
- **Next: P1c** (CEO's hands) — second agent via `--room`, add to `SESSION_ROOMS`, measure the **capacity constant**.

## 2 August 2026 — P1a SHIPPED: the session layer, O(1) enforced (#32 merged)

- **`SessionRegistry` DO + three endpoints** (`/api/session/create|end|capacity`) live in production. Coordination state only, **not** the database (P4). Server-side only — nothing user-visible changed yet.
- **The lease is what makes the invariant affordable, not the code.** `SESSION_LEASE_SECONDS` (2h, capped by the 6h LiveKit ceiling) is simultaneously the max session length *and* the max time an abandoned slot stays held, and the grant is minted for the same span — slot and credential expire together, so **nothing has to check in to stay alive**. `create` returns everything the client needs in one response, so nothing comes back to ask. No polling, no heartbeat, no WebSocket, no `setTimeout`/`setInterval`; one demand-driven `alarm()` at the earliest expiry.
- **Boundary now stated, not implied:** the claim is "no request as a function of elapsed time **within a lease**", not "duration is free forever". Renewal, if ever needed, is O(duration ÷ 2h).
- **CodeRabbit: 5 findings, all accepted and confirmed.** Two mattered. (a) `storage.delete()` caps at **128 keys** and throws above it — unchunked sweeps would strand the whole reap when every lease expires together; now batched, and **the test harness enforces the real limit** so the fix can't be quietly removed. (b) The wrangler assertion **could not fail on the thing it named** — it grepped the file for one occurrence, and named envs inherit neither `durable_objects` nor `migrations`, so staging could have been missing both. Now parses and walks every scope.
- **I overstated my own mutation evidence and was corrected.** I wrote that short-vs-long was "the only row that convicted the duration-scaling mutation"; the abandoned row reddens too. Real table in `ROADMAP.md` §P1: rows 1 and 4 are blind to a fixed sweep, row 2's ≤2 budget absorbs an extra request, and **row 3 is the only row red under both** — weaker than I claimed, better reason to keep it. Also: under the extra-request mutation row 3 fails on the *absolute pin*, not the `deepEqual` (both sides gain the same request), so the pins bound the constant and only the comparison detects duration-scaling. Neither is redundant. **The failure mode was a true-sounding summary of evidence I did not re-read.**
- **Verified:** 88 worker / 89 frontend / 224 agent green; lint, typecheck, build, md guard; dry-run both envs; 4 discrimination mutations each reddened exactly the intended tests. Post-merge deploy log shows `env.SESSION_REGISTRY (SessionRegistry) Durable Object` + `MAX_CONCURRENT_SESSIONS ("1")`; `check-live.sh` PASS ×3; routes probe 401/405 with a 404 control. **The DO was not exercised end-to-end — that needs the admin password, which is the CEO's.**
- **Next: P1b** — lens wired to `/api/session/create`, admin-password gate retired. Then **P1c** (CEO's hands): agent-per-session on the VPS + the capacity constant.

## 2 August 2026 — ROADMAP v2.4: the DO O(1) invariant (CEO cost concern, and it bites NOW)

- **CEO flagged Durable Objects as metered on paid plans and warned a chatty DO could run up a bill overnight.** Right — and review sharpened it further: **it bites on the free tier we are on today, as failures rather than a bill.** Workers Free allows **100,000 DO requests and 13,000 GB-s per day**, and exceeding either makes further operations of that type **fail with an error** (reset 00:00 UTC).
- **Polling the DO once a second breaks at 55 sessions/day** (request quota binds first; duration would allow 57 — both floored). O(1) gets **33,333/day** (bound by requests; duration allows millions, because **a hibernation-eligible DO accrues no duration charge at all** — not even in the 10 s before it hibernates, so an O(1) session bills only its active execution). On paid the same comparison is ~$303/month vs $0 in *incremental DO usage* at 100k sessions (the Workers Paid **$5/month minimum** applies either way); the $0 row is ~375 GB-s (3 requests × ~10 ms active × 128 MB × 100k), and holds even under the pessimistic 375,000 GB-s reading — still inside the 400,000 included, so three orders of modelling error give the same answer — and **duration is ~90% of that**, because a DO polled every second never reaches the **10 s** hibernation threshold and bills its allocated **128 MB** for the whole session. Cost tracks *how long people stream*.
- **Invariant, a P1 requirement:** DO requests per session are **O(1)**, never O(session duration). Rules: no polling (status rides the LiveKit data channel we already pay for), no heartbeats through the DO, **no non-hibernating** WebSocket, **no `setTimeout`/`setInterval`** (a pending timer makes the object ineligible for hibernation *entirely*), and the reaper alarm is **demand-driven — one alarm set to the earliest pending expiry, re-armed on wake**. A fixed-interval reaper would itself make alarm count scale with duration, breaking the invariant it was meant to serve.
- **Test oracle defined in `ROADMAP.md` (source of truth), not left as "constant".** Counts every DO `fetch()` plus every `alarm()`. Clean session (create → capacity read → end) ≤3 req/0 alarms; abandoned ≤2 req/exactly 1 alarm; **short vs long session must be identical** (the duration-scaling detector — the budget rows catch a poll that breaches the count, this one catches one that scales with length while staying inside it); N sessions ≤ N × budget. Discrimination-tested by adding a poll and by making the reaper fixed-interval.
- **Next: P1a** — the Worker endpoint + `SessionRegistry` DO + that oracle.

## 2 August 2026 — ROADMAP v2.3: admin phase added, storage question answered

- **P8 — Admin & operations** added at the CEO's request, scope deliberately open until we discuss it. Split into two things that get conflated: **operational visibility** (agent up? sessions live? capacity?) which needs no accounts and rides along with P1, and the **admin system proper** which reads identity (P4) and money (P5) and genuinely cannot exist sooner. Sketched what it usually covers — people, money, COGS-vs-charged, **audit log**, and role separation — as a starting point to react to, not a decision. Scale & harden renumbered P8 → P9.
- **"Is P1 the database stage?" — no, and the roadmap now says so in both places.** P1's Durable Object is the first server-side storage but it holds *coordination* state — which rooms exist, who holds them. Its storage **is** durable (survives eviction and restart — the name is accurate); what separates it from P4 is purpose and lifetime, not permanence: session records written at create and deleted at session end, never the system of record for user history. **P4 is the database** — the first storage whose job is remembering a person between sessions. Billing and admin both wait on it.
- **Cloudflare scopes for P1: no change expected.** Durable Object migrations are applied as part of the script deploy, which `Workers Scripts: Edit` already authorises — the token has it. Confirmed at the first staging deploy, not assumed; if it 403s the fix is one checkbox. **SQLite-backed DOs are available on Workers Free**, so on Free and within its limits P1 adds no incremental charge — but on Workers **Paid** they are metered (requests, duration, storage) above that plan's monthly minimum. **Which plan the account is on has not been checked**, so "P1 is free" is not a claim I can make yet. Added to the CEO actions.
- Apple Developer enrolment **started 2 Aug** — struck from the open-actions table. P0 marked closed; P1 marked NEXT.

## 2 August 2026 — P0 CLOSED (#26, #27, #28 merged)

- **`ROADMAP.md` is canon** — lens paragraph, real state, P0–P8, and 29 doctrine entries reconstructed from this repo's own failure narratives. **P7 is the CEO's design session**: its own brief, after P1, system debt named (hardcoded hex, unset font tokens, framer-motion in one place).
- **CI exists.** Nothing ran on a PR before. Four jobs now do, and the Pages deploy gates on tests. It caught two of my test defects within a day — both races between my test and the platform, both invisible on this Mac.
- **Rate limiter fails closed** (503 for a missing binding vs 429 for a real throttle — distinguishable in logs). Python floor 3.10 for a patched aiohttp. `agent/README` no longer documents the `.venv/bin/pip` trampoline. Shutdown has a real regression test; the SIGINT fix itself was already on main.
- **P6 corrected twice:** the camera needs `/Applications` + activation + user approval; `AudioDriverKit` is **not a route** — Apple grants no entitlements for virtual audio devices, so the mic's admin-password install is a fixed constraint to design around.
- **Lesson recorded:** I added the AudioDriverKit route on a review suggestion and verified only when pushed back on. A suggestion is a verdict too.
- **Next: P1, the session layer** — `/api/session/create`, DO ledger, agent-per-session, and the capacity constant that has never been measured. Retires the shared room, `agent_busy`, and the admin gate on the lens.

## 1 August 2026 — LENS ON `/`, BASE44 GONE, CANON WRITTEN (PRs #24 + #25 merged, branch docs/roadmap-canon)

- **VPS is on systemd.** CEO installed the units; `lumina-agent` runs as a service and `lumina-deploy.timer` polls `origin/main` every 2 min. **Merging is now deploying** — no more hand commands on the box.
- **#25 merged:** `/` is the lens (one decision, one action, everything from agent-confirmed state), `/livekit-test` stays the instrument. Base44 excised — 107 files, 33 deps. The Vite plugin was also the undocumented source of the `@` alias; now explicit.
- **CEO drill, 1 Aug:** unlocked the lens against the live agent — **it works**. Informal, no analyzer report or scores. Her note: the UI is generic. Deferred to a dedicated design session, now **P7** in `ROADMAP.md` (after P1, since the session layer changes what the page shows).
- **9 CodeRabbit rounds, 25 findings** — 24 accepted, 1 declined with reasoning, 1 reframed at its root. **Six were defects in my own tests**, two of which could not fail and one of which hung the runner rather than failing. That pattern is now doctrine entry 10.
- **`ROADMAP.md` v2.2 written:** the lens canon, real state (648 ms baseline, 8.7 scorecard), phases P0–P8, and **29 doctrine entries reconstructed from `devlog/SESSIONS.md` failure narratives**, each citing the session that paid for it. The lost 27-entry original is explicitly *not* claimed as recovered.
- **P6 corrected in review:** the macOS camera extension needs `OSSystemExtensionRequest` activation, the app in `/Applications`, and a user approval step — "no installer" is not "no install flow". The **microphone is the harder half**: an `AudioServerPlugIn` needs a privileged installer into `/Library/Audio/Plug-Ins/HAL` and a `coreaudiod` restart. **`AudioDriverKit` is not an option** — Apple supports it for physical audio devices only and will not grant entitlements for virtual ones, so the admin-password install is a fixed constraint to design around, not a decision. P6 = 3–4 weeks of build, excluding Apple enrolment latency.
- **Next:** CI hardening — the deploy workflow still runs **no tests and no lint**, which is why nine rounds of review fell to a bot instead of a pipeline. Then the owed micro-fixes (fail-open rate limiter at `workers/api/src/index.js:47`), then P1.

## 31 July 2026 — RECORD REPAIR: the VPS deploy already happened (branch fix/vps-record-repair, PR pending, HOLD FOR CEO)

- **The VPS deploy already happened.** Amy placed the ElevenLabs keys by hand on 29 Jul and the TTS engine ran a full live drill on the box that night: tail p50 **648 ms**, steady-state TTFB 81–129 ms, CEO scorecard **8.7 overall** (clean 8 / latency-feel 8.3 / is-it-ME 8.5 — the first is-it-ME judgement ever made). Never logged.
- **So the incoming CTO reconstructed a false history** from `notes.md:71` + an empty `devlog/`, and reported the completed migration as the biggest unclaimed win. Method (repo over handover) stands; the record had the hole.
- **Fix:** `CLAUDE.md` gains a **VPS OPERATIONS** section (box, no-SSH wall, fire-up runbook + gates, pull-then-pip, VPS-tracks-main, Starlink DNS hazard) and a new convention — CEO-run drills logged the SAME DAY. Host left as a placeholder; repo is PUBLIC.
- `notes.md:63`/`:71` corrected in place with dated markers; 29 Jul drill backfilled to `devlog/SESSIONS.md`.
- **Stage 2 baseline re-derived: 648 ms.** Remaining latency work is optimization *from* 648; the "VPS move" track is struck from the plan, replaced by the never-run capacity test.
- **Analyzer report is gone** (CEO, 31 Jul) — 29 Jul entry closed on stated provenance: figures are CEO-reported, not analyzer output; acceptance rests on her closed-headphone listening test before Stage 1 close; TTFB independently corroborated by the logged Starlink RTT. **Next:** merge #22, sync, then M0 PR A (canon docs + doctrine reconstruction).

## 30 July 2026 — POST-STAGE-1 POLISH: loudness, governor console, --room, layout (branch feat/loudness-governor-console, PR pending, HOLD FOR CTO)

- Four tickets, off main (#18/#19/#20 merged). Commits: loudness+room, governor console, layout, docs.
- **T1 loudness:** new `loudness.py` — per-utterance RMS leveling to `loudness_target_db` + soft-knee limiter (asymptotes to -1 dBFS, cannot clip). **RMS not integrated LUFS** (LUFS gating unstable on short utterances; one stationary voice → K-weighting moot). Engine buffers the short utterance for exact RMS before enqueue; `enqueue_delay_ms` reports the cost; OFF = byte-identical streaming. Knobs `loudness_normalize` (on) + `loudness_target_db` (-20). Panel shows `lvl`.
- **T2 governor:** REVERSES #19 "no sliders" — caps are now dynamic-float knobs `tts_chars`/`stt_seconds`, walled by env-only `SPIKE_MAX_*_CEILING`. `set_cap()` clamps to [0,ceiling] w/ three-way disposition. **Ceiling defaults to the starting cap → console can only LOWER spend un-overridden** (guardrail intact). Console renders cap sliders (metadata-driven); spend line reframed.
- **T3 --room:** env-aware (`LIVEKIT_ROOM`) + startup banner → two agents, two rooms.
- **T4 layout:** collision was the range input's intrinsic min-width in a viewport(lg)/container(672px) mismatch → sliders became dots. Fix: dev console `max-w-2xl`→`max-w-4xl`. Evidence: `devlog/evidence/knob-grid-before-after.png` (real broadcast, exact markup, 1440px) + committed generator.
- Verified: 212 py (+11) / 28 node / lint clean / typecheck 60 baseline (0 mine) / build green. RVC+VAD green.
- **Next:** push, open PR → CodeRabbit → **CTO merges**. Live E2E: loudness on/off A/B, cap-slider + over-ceiling raw-set drill, two-room test.

## 30 July 2026 — LOCK IN the tuning-session profile (branch chore/lock-tts-profile, PR pending, HOLD FOR CTO)

- Replaced `agent/tts_profile.json` with the CEO's tuning-session **export** (verbatim) and opened a lock-in PR off main (#18+#19 both merged, so the voice/comfort/continuity knobs exist on base).
- **Verified before overwriting:** the export shape (metadata keys; `request_continuity`/`speed` nested in `voice_settings`) round-trips through the real loader — `load_profile` (dict-only check) → `flatten_profile` (hoists nested keys, `model`→`tts_model`, picks up top-level `voice`) → `clamp_params`. Ran it: **0 rejected, 0 clamped**; continuity is live because multilingual_v2 supports stitching (not v3).
- **Deltas locked in** (all CEO ear-found): model flash_v2_5 → **multilingual_v2**; `voice` pinned to `kG0YavHsOC38yeSB7O1t` ("Celebrity lilcrush linda", was unset→ELEVENLABS_VOICE_ID); `voice_settings` `{}`→explicit (=registry defaults, now pinned not deferred); `vad_hangover_ms` 200→300. `_comment` block dropped (export doesn't carry it; was partly stale).
- No code change, no secrets (`voice_id` is not a credential).
- **Next:** CodeRabbit → **CTO presses merge**. Acceptance = connect and confirm the CEO's voice + multilingual_v2 resolve at startup (check the resolved-config log line).

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
- **Remaining floor:** ~400ms of the ~950ms p50 is Starlink RTT (measured: 200ms TCP, 433ms TLS to api.elevenlabs.io). **VPS deploy should reach p50 ~550-650ms with zero code change** — the biggest lever left. ~~Needs ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID hand-typed into the VPS secrets.env by Amy~~ **[CORRECTED 31 Jul 2026 — done 29 Jul; drill measured p50 648ms, inside the predicted band. See the top entry.]**; deploy sequence + preflight in agent/README.md.
- **p95 in live conversation (1920ms) is structural, not a defect:** synthesized audio plays for about as long as the speech took to say, so continuous talking accumulates backlog that drains at pauses. Video-sync budget for the avatar leg must be ELASTIC, not fixed.
- Merged origin/main (workers/api + server-mint frontend) — only conflict was SESSIONS.md ordering, both histories kept. All suites green: 136 py + 21 src/lib + 35 workers/api. Positive preflight added (STT READY / TTS READY / PREFLIGHT OK; failures are plain sentences, never tracebacks). CodeRabbit round complete (10 findings, all addressed — see PR #15). **CTO has since approved for merge; the merge itself is still the CTO's to press.**

## 28 July 2026 — Optimization sprint: tail latency HALVED, target met (full record: devlog/SESSIONS.md)

- **p50 1938 → 932ms, p95 2511 → 949ms** on the same drill, quality untouched (transcripts byte-identical, WER unchanged 0.1458, 5/5 utterances). Default config is `--tts-hangover-ms 200`; one launch command in SPIKE.md.
- Wins: streaming STT while the gate is open (STT 1121→315ms; test contract amended deliberately to "nothing COMMITTED while open"), and connection keepalive — the first-utterance ~1040ms TTFB was aiohttp's pool reaping the idle connection (default timeout 15s, my ping was 20s, so it always arrived too late). Rejected: `optimize_streaming_latency` + text normalization, both pure noise.
- **~400ms of the remaining 954ms is Starlink RTT** (measured: 200ms TCP, 433ms TLS). VPS topology is the biggest lever left — should reach p50 ~550-650ms with no code change. ~~**Needs ELEVENLABS_API_KEY in the VPS secrets.env — Amy to place it, I did not copy it.**~~ **[CORRECTED 31 Jul 2026 — Amy placed `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` into the VPS `secrets.env` by hand on 29 Jul 2026 (`read -rs` piped append; values never on screen). The VPS deploy HAPPENED and was measured the same night: p50 648ms. The prediction above was correct and is now history, not a to-do. See the top entry.]**
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