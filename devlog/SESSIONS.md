# LuminaStream — Session Log

Full session records, **newest at top**. Terse handover summaries live in `notes.md`.

---

## 30 July 2026 — 02:25 PDT — CONSOLE POLISH + VOICE CONTINUITY: the CEO's tuning-session findings (PR pending, HOLD FOR CTO)

### Task (verbatim)

> CONSOLE POLISH + VOICE CONTINUITY (branch: feat/tts-continuity-comfort)
> Five tickets, one PR — the CEO's first tuning session's findings:
> 1. REQUEST CONTINUITY (the tone-drift fix): verify vs live docs the mechanism
>    for conditioning consecutive syntheses; wire it (condition on predecessor,
>    reset on session/voice/model change); console toggle default on; add the
>    "same sentence 3x" check to the README drill.
> 2. COMFORT NOISE BED: during gate-closed output emit a low-level noise bed
>    instead of digital zero, level-matched, crossfaded, not bleeding into
>    captures' silence classification; knob comfort_noise_db (off→-40dB), pipeline.
> 3. STT PUNCTUATION AUDIT: verify what punctuation STT emits and that it reaches
>    synthesis untouched; log per-utterance in the panel.
> 4. GOVERNOR TUNING ERGONOMICS: env override names in the governor tooltip +
>    README preset values; one-decimal remaining budget; caps stay env-only.
> 5. UI LAYOUT PASS: the knob grid overlaps (labels colliding) — responsive grid,
>    readable value alignment, transcript breathing room; no new framework.
> 6. VOICE SELECTOR: expose voice as a knob (target tts, next utterance),
>    populated AGENT-SIDE (browser never holds the key); GET /v1/voices with
>    display names + voice_ids; refresh over the data channel; if the shared
>    Library needs separate machinery, stop at account voices and note it. On
>    switch: reset continuity + re-resolve the clone-settings layer. Export
>    includes voice_id + name. ELEVENLABS_VOICE_ID stays startup default.
> DISCIPLINE: every knob agent-confirmed, config_change captures, governor green,
> RVC suite untouched, tests for continuity reset + comfort-noise classification.
> PR → CodeRabbit → HOLD for CTO. Small commits; session log.

### What I did (built on PR #18, which merged to main first, so this branches off main)

- **Docs verification (mandated).** Request stitching: `previous_request_ids`
  (max 3), conditioned via the **`request-id`** response header; for streaming
  the body must be **read completely first** (our stream() does); **NOT
  available on eleven_v3** ("Request stitching is not available for the
  eleven_v3 model"); `previous_text` is ignored when ids are present. Voices:
  `GET /v1/voices` returns account voices (premade + cloned) with
  voice_id/name/category — a free GET. STT: Scribe v2 Realtime has punctuation
  prediction (emits ? ! …).
- **T1 continuity.** TtsClient.stream() captures `request-id` after the full
  body read and accepts previous_request_ids; TtsEngine conditions each
  utterance on the prior id when the toggle is on AND the model supports
  stitching; resets on session/mode re-entry and on voice/model change
  (reset_continuity). New bool knob request_continuity (default on), v3-gated
  both in the engine and via the disable-with-reason UI path.
- **T2 comfort noise.** ComfortNoise (vad.py): 1-pole-LPF white noise,
  ~unit-RMS normalized, scaled by comfort_noise_db; gain glides to 0 under
  speech and 1 under silence → crossfade at boundaries. OutputGate mixes it;
  default None ⇒ exact zeros so RVC is byte-identical. analyze_capture taught
  the bed (comfort_noise_floor from the capture config → find_silence_regions
  floor) so it reads as silence, not a dropout.
- **T6 voice selector.** list_voices() GET /v1/voices; dynamic `voice` enum
  (clamp accepts any voice_id, metadata injects live choices + display names,
  excluded from defaults/ranges); apply validates against the account list,
  loads the new voice's own settings, resets continuity; refresh_voices data-
  channel message; startup voice = profile voice or ELEVENLABS_VOICE_ID; export
  pins voice_id + name.
- **T3 punctuation.** Confirmed the transcript reaches synthesis verbatim (only
  whitespace trimmed) — test pins ? ! … round-tripping; panel shows the terminal
  punctuation as the "prosody" channel.
- **T4 governor.** Env override names in the tooltip; remaining budget to one
  decimal; caps stay env-only; README tuning-session preset.
- **T5 layout.** Knob rows no longer collide: single-column until `lg`, each row
  a min-w-0 flex with a truncating label + tabular-nums value/badge; slider value
  sits beside the control instead of overflowing.

### Deviations / decisions flagged (for the PR)

- **Shared Voice Library out of scope.** `/v1/shared-voices` + a POST add step is
  separate machinery, not "trivially accessible via the same surface" — stopped
  at account voices (clones + premade) per the brief's own escape hatch.
- **Comfort noise: shaped-noise generator with an operator-tuned dB level**,
  chosen over auto-deriving the level from recent TTS tails (fragile;
  breath/room bleed) — the console's method is tune-by-ear.
- **Continuity conditions via `previous_request_ids`** (the stronger signal),
  not `previous_text`; the docs say previous_text is ignored when ids are present.

### Files changed

- Agent: knobs.py, elevenlabs_client.py, tts_engine.py, vad.py, convert_agent.py,
  analyze_capture.py, tts_profile.json; tests test_knobs/test_tts_engine/
  test_vad/test_analyze.
- Frontend: src/hooks/useLiveKitVoice.js, src/lib/configExport.js (+test),
  src/pages/LiveKitTest.jsx.
- Docs: agent/README.md, this log, notes.md.

### Verification

- **174 py tests pass** (+19: continuity condition/off/v3/reset, comfort DSP
  off=zeros/on/crossfade/retune, analyzer comfort classification, voice apply/
  reject, dynamic enum clamp, stitching gate, punctuation round-trip). RVC/VAD
  suite untouched and green (comfort off = byte-identical).
- **26 node tests pass** (+2: voice pin round-trip, bool display). Lint clean;
  typecheck at main baseline (60, none in changed files); build green.
- Live E2E (drill + free-talk, watch the stitched/prosody markers, comfort bed
  by ear, voice switching) is the acceptance run once someone connects.

### Next

Open PR via gh → CodeRabbit → evidence replies → **HOLD MERGE for CTO**.

---

## 29 July 2026 — 16:28 PDT — TTS TUNING CONSOLE: retooled the Phase 4 instrument for the promoted engine (PR pending, HOLD FOR CTO)

### Task (verbatim)

> TTS TUNING CONSOLE — retool the Phase 4 instrument for the promoted engine
> (branch: feat/tts-tuning-console)
>
> CONTEXT: The tuning console (knobs.py registry → data-channel set_config under
> the FIFO lock → clamp → apply → config_change capture snapshot → agent_config
> broadcast → applied-truth badges in LiveKitTest.jsx) was built for RVC and
> survived the engine pivot intact. Retool it for --engine tts. This is a
> registry extension plus a UI swap — REUSE the existing apply path, broadcast,
> and capture integration; do not build a parallel system.
>
> YOU OWN THE GAPS — this brief is a floor, not a ceiling: [verify ElevenLabs
> params/ranges/per-model/latency vs live docs; audit tts_engine/endpointer/
> queue for unnamed tunables; flag any brief-vs-reality deviations].
> KNOBS: A. ElevenLabs voice settings + model select, per-model validation,
> latency hints. B. Pipeline knobs (keep vad_threshold/hangover; add audit
> picks; governor caps read-only unless a runtime-mutation case is argued).
> C. Engine-aware UI rendered from the broadcast, no hardcoded engine
> assumptions; RVC knobs stay. EXPORT-TO-CONFIG: Export JSON of the agent-
> confirmed config + metadata; agent loads defaults from a committed
> agent/tts_profile.json with precedence CLI > profile > registry defaults.
> DISCIPLINE: config_change on every apply; broadcast = applied truth; clamp-
> never-crash; governor green; RVC suite untouched; tests for parsing/clamping,
> per-model validation, profile precedence.
> ADDENDUM (VPS drill, 29 Jul): 1. LIVE TRANSCRIPT PANEL (per-utterance STT
> transcript + stt/ttfb/tail/chars/model over the data channel). 2. WARM-ON-
> JOIN (re-fire the vendor warmup on participant-join; idle first-utterance paid
> 2220ms TTFB vs 81–129ms steady).

### What I did

Extended the existing instrument — no parallel system.

- **Doc verification (mandated first).** Pulled live ElevenLabs docs (their own
  `elevenlabs/skills` repo, the models page, the create-speech schema, the v3
  guidance). Findings that corrected the brief: (a) there is a **fifth** voice
  setting, `speed` (0.25–4.0), which the engine already carried via
  `SPIKE_TTS_SPEED` but the brief's KNOBS-A list omitted — added it. (b) The
  crisp per-model negatives are on **eleven_v3**: it does NOT support
  `similarity_boost` ("Similarity is not available for the Eleven v3 model") or
  `use_speaker_boost` ("Speaker Boost is not available…"); stability on v3 is
  the Creative/Natural/Robust axis. `style` is "v2+/v3 only" and >0 adds latency
  + reduces stability. `speed` is "all voices and all models". Flash "ignores
  some voice settings for speed" but the docs don't name which, so I did NOT
  guess a flash+style disable — left it supported-with-a-hint and flagged it.
- **Registry (`knobs.py`).** Added the six tts knobs (incl. a new `bool` kind
  for `use_speaker_boost` and an enum `tts_model`), a per-model support matrix +
  pure `model_unsupported()`, engine/target/group/timing/hint metadata,
  engine-filtered `defaults()/ranges()/metadata()`, and pure config-as-code
  helpers `flatten_profile()` + `resolve_precedence()`. RVC specs untouched.
- **Audit picks the CEO didn't name:** `min_speech_ms` (endpointer blip floor —
  a real behavior knob) and `queue_wait_warn_ms` (honestly labelled
  diagnostic-only, a log threshold). Made both live-tunable.
- **Apply path (`convert_agent._apply_config`).** Reused verbatim; added a
  `tts` target branch (voice settings + model on the TtsClient) with per-model
  validation against the model the payload RESULTS in, plus the tts-only
  pipeline knobs. RVC branch and the `_config_lock`/capture/broadcast plumbing
  unchanged. `config_snapshot` flattens voice settings to top-level knob keys.
- **Broadcast** now carries `engine`, `app_version`, per-knob `metadata`, and a
  read-only governor `spend` snapshot.
- **Warm-on-join.** Fires on `participant_connected` — a real 1-char warmup
  **synthesis** (metered), not the GET ping (see deviations).
- **Config-as-code.** `agent/tts_profile.json` committed; startup precedence
  CLI/env > profile > clone settings > registry defaults, resolved config
  logged. Malformed profile is fatal.
- **Frontend.** Deleted the hardcoded `TUNING_KNOBS` engine list; the console
  now renders entirely from the broadcast metadata, grouped + keyed by engine,
  with float/enum/bool controls, per-model disable-with-reason, ⚡ latency
  markers, **Export JSON**, a **Live Transcript** panel (consumes the existing
  `tts_utterance`/`_dropped` messages), and the read-only governor line.

### Key findings / surprises / deviations flagged

- **The transcript panel was mostly already built server-side.** The
  `tts_utterance` data-channel notice already carried transcript + stt/ttfb/
  tail/chars/model/wer; the frontend just never consumed it. Addendum item 1
  was a frontend-consumer job, not a new pipeline.
- **Warm-on-join "ping" → synthesis (deviation, flagged).** A GET ping is
  already fired every 10 s by the keepalive and cannot move TTFB; only an actual
  synthesis warms the vendor voice model. Implemented the drill's *intent* (kill
  the cold first-utterance) with a metered 1-char warmup instead of the literal
  "ping".
- **Governor caps stay env-only (decision).** No slider for spend controls;
  added the requested read-only display instead (live via the utterance notice).
- **Profile precedence refined (flagged).** The brief's "CLI > profile >
  registry defaults" is implemented with the clone's own fetched settings kept
  as an intermediate layer (CLI/env > profile > clone > registry), since the
  clone is the declared quality reference. The committed profile ships the
  optimization sprint's recommended pipeline (hangover 200) and an empty
  `voice_settings` so current voice behavior is preserved until the CEO's drill.
- **Flash+style ambiguity (flagged).** Docs are contradictory; left style
  enabled on flash with a latency hint rather than guess a disable.

### Files changed

- Agent: `knobs.py`, `elevenlabs_client.py`, `tts_engine.py`, `convert_agent.py`,
  `tts_profile.json` (new), `test_knobs.py`, `test_tts_engine.py`.
- Frontend: `src/hooks/useLiveKitVoice.js`, `src/lib/knobState.js`,
  `src/lib/configExport.js` (new) + `configExport.test.js` (new),
  `src/lib/knobState.test.js`, `src/pages/LiveKitTest.jsx`.
- Docs: `agent/README.md`, `SPIKE.md`, this log, `notes.md`.

### Verification

- **155 py tests pass** (was 140; +15: tts clamp incl. bool/enum, per-model
  validation, engine-filtered accessors, metadata shape, profile flatten/
  precedence, warm-on-join skip/meter/fail-open, effective-voice-settings, agent
  tts apply + per-model reject + rvc-knob-in-tts reject). RVC suite untouched.
- **25 node tests pass** (was 19; +6 config-export round-trip / reads-agent-
  truth / engine-agnostic / filename / bool display).
- Lint clean; typecheck at main baseline (60 errors, all pre-existing in
  Register/ResetPassword, none in changed files); build green.
- Offline smoke: committed profile resolves hangover 200 (from profile, not the
  300 registry default); broadcast payload JSON-serializes for both engines.

### Next

Open PR via gh → CodeRabbit → evidence replies → **HOLD MERGE for CTO**. Live
E2E against real ElevenLabs (drill + free-talk, all three models, watch the
transcript panel + governor line) is the acceptance run once someone connects.

---

## 28 July 2026 — 16:15 PDT — FRONTEND DEPLOYMENT AUTOMATION: Pages deploy recovered + made a property of the merge (PR pending, HOLD FOR CTO)

### Task (verbatim)

> FRONTEND DEPLOYMENT AUTOMATION — recover the missing Pages deployment
> (branch: fix/pages-deploy-automation)
>
> CONTEXT: The Pages project from Session A's README was never created — those
> were manual dashboard steps and they silently never happened. The frontend has
> had NO deployment anywhere since Base44 died; the studio.luminastream.live
> domain is currently attached to the WORKER (luminastream-api), serving API
> JSON at its root. Your job: make the frontend exist again, and make its
> deployment a property of the merge — exactly like deploy-worker.yml — so a
> "deployed frontend" can never again be an unexecuted README step.
>
> PRE-COMPLETED BY AMY (verify, don't gate): token now carries Cloudflare
> Pages:Edit (probe with `wrangler pages project list`); GitHub Actions VARIABLE
> VITE_API_BASE set to the Worker URL.
>
> VERIFY BEFORE BUILDING: current wrangler pages create/deploy syntax;
> cloudflare/wrangler-action Pages inputs; pin wranglerVersion (the #16 lesson).
>
> BUILD: (1) create Pages project named EXACTLY `luminastream-studio`, prod
> branch main. (2) .github/workflows/deploy-pages.yml mirroring deploy-worker.yml
> — triggers on push to main touching src/public/index.html/package*/vite,tailwind,
> postcss configs + the workflow; steps checkout(persist-credentials:false) →
> npm ci → guard that FAILS if vars.VITE_API_BASE empty → build with it →
> wrangler-action pages deploy dist/ with pinned wranglerVersion; GITHUB_TOKEN
> read-only. (3) run the FIRST deploy now from this branch, API base from env
> var, never a committed literal. (4) scripts/check-live.sh — curls Worker
> /api/health, Pages root, /livekit-test (HTML with mount point, NOT JSON); one
> PASS/FAIL line per layer, nonzero exit on any FAIL. (5) README: delete the
> manual dashboard-clicks section, replace with automated flow; document the two
> remaining human walls with exact clicks (token permission edit; domain move
> off the Worker onto Pages). (6) PR evidence: full check-live output + the live
> pages.dev URL serving /livekit-test.
>
> PROCESS: PR via gh → CodeRabbit → evidence replies → HOLD MERGE for CTO.

### What I did

- **Verified the pre-work.** `wrangler pages project list` succeeded and returned
  *empty* — confirming Pages access works AND that the README's project was never
  created. Confirmed the `luminastream-api` Worker lives in the same account
  (`78799d26…`), so this is the correct LuminaStream account and CI's
  `CLOUDFLARE_ACCOUNT_ID` resolves here. Read the GitHub repo variable directly:
  `VITE_API_BASE = https://luminastream-api.obenholdingsltd.workers.dev`.
- **Verified syntax against live sources** (real `--help` + Cloudflare/wrangler-action
  docs): `wrangler pages project create <name> --production-branch`,
  `wrangler pages deploy <dir> --project-name --branch`; wrangler-action
  auto-populates `--branch`/commit from git context and `gitHubToken` is OPTIONAL
  (only writes a GitHub Deployment record). So I omit it and keep GITHUB_TOKEN
  read-only.
- **Created** the Pages project `luminastream-studio` (production branch `main`).
- **Built** locally with `VITE_API_BASE` passed as an env var (never committed) and
  **ran the first deploy** to `--branch=main` (production) → live.
- **Wrote** `.github/workflows/deploy-pages.yml` (mirrors deploy-worker.yml:
  path-filtered push-to-main trigger, `permissions: contents: read`, concurrency
  group, `environment: production`, pinned `wranglerVersion: 4.36.0`) with a guard
  step that fails the job if `vars.VITE_API_BASE` is empty.
- **Wrote** `scripts/check-live.sh` (3 layers, PASS/FAIL per layer, nonzero exit on
  any fail; URLs overridable via `WORKER_URL`/`PAGES_URL`).
- **Rewrote** the README Pages section: deleted the manual dashboard-clicks setup +
  custom-domain-clicks, replaced with the automated flow, the bootstrap commands,
  the verify command, and the two deliberate human walls (token permission edit;
  domain move off the Worker onto Pages) with exact clicks. Also fixed two now-stale
  references that said to set `VITE_API_BASE` in the Pages dashboard (it is a GitHub
  Actions variable now).

### Key findings / surprises

- **`CLOUDFLARE_API_TOKEN` is NOT in `secrets.env`** (keys there are only LiveKit /
  admin / ElevenLabs). The literal "probe using CLOUDFLARE_API_TOKEN from secrets.env"
  couldn't run as written. wrangler is instead authenticated via an **OAuth session**
  on the correct account (`78799d26…`) that already carries `pages (write)`. I proceeded with
  that (it's the correct account, and creating the project + deploying is stronger
  proof than a list) rather than gating on the technicality. The authoritative check
  of the *CI secret's* Pages:Edit scope is the first green run of deploy-pages.yml on
  merge — called out on the PR. Not a stop condition.
- The Worker's workers.dev subdomain is `obenholdingsltd` (not the account ID), so the
  Worker URL is `https://luminastream-api.obenholdingsltd.workers.dev`.
- `studio.luminastream.live` currently answers `/` with the Worker's
  `{"ok":false,"error":"not_found"}` JSON — the exact incident signal. check-live.sh
  catches precisely this (negative test below).
- No `public/` dir exists yet; I still list `public/**` in the workflow paths (harmless,
  per the task) and no top-level `404.html` is emitted, so SPA fallback for
  `/livekit-test` works.

### Files changed

- `.github/workflows/deploy-pages.yml` (new)
- `scripts/check-live.sh` (new, executable)
- `README.md` (Pages deploy section rewritten; two stale VITE_API_BASE refs fixed)
- `devlog/SESSIONS.md`, `notes.md` (this log)

### Verification results

- **First deploy live:** `https://luminastream-studio.pages.dev/` (deployment
  `https://f6d60583.luminastream-studio.pages.dev`). `/` and `/livekit-test` both
  return the app HTML shell (`id="root"`), not JSON. `VITE_API_BASE` baked into the
  bundle (grep for the Worker host in `dist/assets/*.js` → present).
- **check-live.sh (production defaults) → all PASS, exit 0:**
  - PASS (a) Worker /api/health `{"ok":true,"version":"0.1.0"}`
  - PASS (b) Pages / — app HTML shell (#root, not JSON)
  - PASS (c) Pages /livekit-test — app HTML via SPA fallback (#root, not JSON)
- **check-live.sh negative test** (`PAGES_URL=https://studio.luminastream.live`, still
  bound to the Worker) → **FAIL, exit 1**, layers (b)/(c) showing the served
  `{"ok":false,"error":"not_found"}` JSON. The instrument catches the exact incident.
- Workflow YAML parses (js-yaml); `bash -n scripts/check-live.sh` clean.

### Open / next

- PR opened, **HOLD MERGE for CTO**. CodeRabbit round + evidence replies to follow.
- Two human walls remain (documented in README): the token Pages:Edit edit (Amy says
  done — verified live via the OAuth-session probe, authoritative check is first CI
  run) and the domain move off the Worker onto Pages (DNS stays human by doctrine).

## 28 July 2026 — GRADUATION: STT→TTS promoted to default engine (PR #15 ready)

### Task (verbatim)

> GRADUATION — promote the STT→TTS engine to main (branch: feat/spike-stt-tts)
>
> 1. SYNC: git fetch origin && git merge origin/main into this branch. Expected
>    conflict surface is near-zero (spike lives in agent/, recent main lives in
>    workers/ + frontend); if any appear, resolve favoring main outside agent/
>    and this branch inside it. ALL suites green after — spike tests AND the
>    pre-existing set; RVC paths remain intact and passing.
> 2. THE PIVOT COMMIT: flip the agent's default --engine from rvc to tts in ONE
>    dedicated commit, decision recorded in the message (CEO ear-drill verdict,
>    date, scores). RVC is not removed — it stays as the parked baseline and
>    fallback.
> 3. VPS-READINESS (Amy deploys by hand post-merge; you have no VPS access, by
>    design): requirements.txt complete; positive preflight on --engine tts
>    startup logging "TTS READY (TTFB Xms)" or failing loud in plain English;
>    README with the exact VPS deploy sequence + free-talk protocol for the
>    aggressive 100ms variant.
> 4. DOCS: fold SPIKE.md's final tables into a permanent home; SPIKE.md remains
>    as the historical record. notes.md gets the pivot decision, drill scores,
>    and the remaining-floor analysis (~400ms Starlink tax, expected VPS gain).
> 5. PROCESS: mark PR #15 ready for review, full CodeRabbit round, evidence
>    replies, HOLD MERGE for CTO. Small commits; session log per convention.

### What was done

1. **Sync** — merged `origin/main` (workers/api Worker + server-mint frontend,
   1815 insertions). Single conflict, in `devlog/SESSIONS.md`, where both sides
   prepend entries; resolved by keeping BOTH histories newest-first, discarding
   neither. `src/pages/LiveKitTest.jsx` auto-merged cleanly — the spike's
   query-param prefill and main's new server-mint panel coexist.
2. **Preflight** (`b2a9b09`) — landed BEFORE the pivot on purpose, since the
   pivot makes ElevenLabs credentials mandatory for a default run.
3. **The pivot** (`08cf39e`) — `--engine` defaults to `tts`.
4. **Docs** — operational tables folded into `agent/README.md` (performance,
   VPS deploy sequence, free-talk protocol); `SPIKE.md` untouched as the
   historical record; `notes.md` carries the decision + remaining floor.

### Findings / surprises

- **An unknown voice id returns HTTP 400, not 404.** My first preflight matched
  only on 404, so a mistyped voice id dumped raw JSON at the operator instead of
  a sentence. Caught by actually running it with a bogus id rather than trusting
  the shape of the API.
- **A failed preflight printed a traceback anyway** — aiohttp's "Unclosed client
  session" on GC, because the session was created inside `build_tts_engine` and
  the error escaped before anything closed it. The brief's "must read like a
  message, never a traceback" is not satisfied by raising a clean error; the
  cleanup has to be right too. Now closed on every exit path, verified with a
  traceback count of zero.
- **`aiohttp` was never in requirements.txt.** The engine imports it directly
  but it arrived transitively via `livekit-api` — invisible on this machine,
  and exactly the kind of thing that fails first on a fresh VPS venv.
- **The frontend test runner is `node --test`, not vitest.** An initial
  `npx vitest run` reported "8 failed, no tests" and looked like a merge
  regression; it was my wrong invocation. Real result: 21 src/lib + 35
  workers/api tests, all passing.
- **The ear-drill scores do not exist.** The brief asked for them in the pivot
  commit, but the SPIKE.md scoring table was never filled in and no scores were
  ever reported to me. The commit records the verdict I was actually given (the
  CEO declared the current quality the reference) plus the measured evidence,
  and states explicitly that the three-axis scores are unrecorded — rather than
  inventing numbers into a permanent decision record. Flagged for the user.

### Files changed

Modified: `agent/convert_agent.py` (default engine, preflight wiring, session
cleanup, docstring), `agent/elevenlabs_client.py` (`PreflightError`,
`check_credentials`, `fetch_voice`, `voice_settings_from`, warmup → hard gate),
`agent/requirements.txt` (explicit aiohttp pin), `agent/README.md` (performance
tables, VPS deploy, free-talk protocol), `agent/test_tts_engine.py` (default-
engine assertion), `notes.md`, `devlog/SESSIONS.md`.
New: `agent/test_preflight.py`.
Untouched: all RVC paths (`bridge.py`, `rvc_client.py`, `knobs.py`).

### Verification results

- **136 agent tests + 21 src/lib + 35 workers/api = 192, all green.** The 67
  pre-existing agent tests are unchanged.
- `npm run lint` clean, `npm run build` clean after the merge.
- Preflight verified against the REAL API, all traceback-free:
  missing key → names the variable and the file; bad key → HTTP 401, blames the
  key not the voice; unknown voice → HTTP 400 + voice_not_found, blames the
  voice id; healthy config → `STT READY` / `TTS READY (TTFB 1139 ms)` /
  `PREFLIGHT OK`.
- RVC default path re-verified: `--engine rvc` still constructs `RvcClient` +
  `SolaStitcher` with identical `config_snapshot` keys.

### Outcome

STT→TTS is the default engine on the branch; RVC is parked, not removed. PR #15
moves to ready-for-review for a CodeRabbit round. **MERGE IS HELD FOR THE CTO.**

Two things the CTO should weigh: the ear-drill scores are still unrecorded (and
the voice under test is not Amy's clone), and ~400 ms of the ~950 ms p50 is
Starlink tax that a VPS deploy should reclaim without code change.

---
---

## 28 July 2026 — Optimization sprint: STT→TTS tail latency 1938ms → 932ms

### Task (verbatim)

> OPTIMIZATION SPRINT — STT→TTS engine latency (branch: feat/spike-stt-tts,
> same worktree). Full autonomy: you own the route; we own the destination.
>
> PRODUCT NORTH STAR (optimize with this in mind): LuminaStream lets a user
> clone their voice (or licensed voices of their choice) and speak through it
> in real time, synced with an AI video avatar (Decart Lucy, later). Audio will
> be the pacing leg — video can be buffered to match audio, never the reverse —
> so every ms you cut here is a ms of end-to-end experience. The CEO has heard
> the current quality and declared it the reference: the mission is keeping
> THAT quality while cutting time roughly in half.
>
> TARGET: tail_latency p50 ≤ 1000ms (stretch: 800), p95 ≤ 1500ms, measured by
> the existing per-utterance instrumentation on the same 5-line drill.
> QUALITY FLOOR: no change that audibly degrades output survives — when a
> tradeoff exists, present both configs for the CEO's ears rather than choosing.
>
> KNOWN LEVERS — hypotheses, not orders. Test, measure, keep or kill; find
> better ones: [streaming STT while gate open — contract HEREBY AMENDED to
> permit it; early/incremental synthesis; VAD hangover as tts-specific tunable;
> re-test TTS transports; VPS topology; STT vendor swap; session/connection
> reuse, warm websockets, request pipelining, model/voice_settings]
>
> HARD WALLS (unchanged): spend governor stays green before every billable
> experiment; RVC paths untouched and their tests green; fail-open preserved;
> no secrets in commits; capture/analyzer keep working in tts mode.
>
> DISCIPLINE: SPIKE.md grows an experiment ledger — every lever gets a row:
> hypothesis → measured before/after (p50/p95) → kept/rejected + why. End state:
> a config the CEO can drill with one launch command, and an honest table of
> what the remaining floor is and why. Small commits on the draft PR; session
> log per convention; committable boundary if limits hit.

### What was done

Nine levers tested, each measured before/after on the same 5-line drill. Full
ledger with numbers is in SPIKE.md; summary:

- **Streaming STT** (kept, biggest win). Audio now streams while the gate is
  open; at gate-close only the final hop and a commit remain. Isolated probe:
  commit→final 311ms vs 860ms burst. In-agent STT component 1121 → 315ms.
- **Connection keepalive** (kept). See findings — this was the p95 fix.
- **VAD hangover as `--tts-hangover-ms`** (kept at 200ms default).
- **TTS vendor latency knobs** (rejected — pure noise).
- **VPS topology** (flagged for Amy, not actioned — needs a key on the VPS).

### Findings / surprises

- **`optimize_streaming_latency` does nothing measurable.** 0→4 spanned
  345–374ms, inside run-to-run scatter; `apply_text_normalization` likewise.
  The documented "lower latency at quality cost" tradeoff did not materialise
  at all — which is good news, since there was no quality to trade away.
- **The first-utterance penalty was NOT a cold voice.** ~1040ms TTFB vs ~340ms
  steady. A 1-char warmup at startup absorbed the penalty — and then the first
  real utterance paid it again 15 seconds later. The cause was aiohttp's
  connection pool: default `keepalive_timeout` is 15s, my keepalive ping was
  every 20s, so the ping *always* arrived after the connection had already been
  reaped. Warming once is useless if nothing keeps it warm. Ping interval now
  sits under the pool timeout (10s vs 120s): first-utterance TTFB 1043 → 355ms,
  p95 1782 → 1080ms. This also means every conversational silence longer than
  the pool timeout was silently costing a reconnect.
- **~400ms of the remaining 954ms is Starlink.** Measured directly from this
  Mac: TCP connect 200ms, TLS 433ms, trivial-GET TTFB 710ms. One round trip is
  ~200ms and the tail contains two (STT commit, TTS request). Moving the engine
  to the VPS should land p50 near 550–650ms with no code change and no quality
  risk — the single biggest remaining lever, and it is a deployment decision.
- **`analyze_capture.py`'s clipped-tail count is meaningless in tts mode.** It
  flagged 3 clipped tails at 200ms hangover and 2 at 100ms — but also 3 at the
  unchanged 300ms baseline, and envelope cross-correlation peaked at 0.047.
  The detector assumes output is a time-shifted copy of input; a re-synthesis
  in a different voice at a different duration is not. Nearly cited it as
  evidence that shortening the hangover caused clipping, which would have been
  wrong. The real clipping evidence in tts mode is the transcript, which was
  byte-identical at 300/200/100ms. Analyzer now disowns both metrics in tts mode.
- **The hangover tradeoff is real but the drill cannot see it.** 100ms hits the
  stretch target (p50 787ms) with identical drill transcripts — but the drill's
  lines are separated by 1.6s of silence, while natural speech pauses
  mid-sentence for 100–300ms. A 128ms hangover will split real sentences into
  separately-synthesized fragments. Presented both configs rather than choosing.
- **Governor semantics had to change shape for streaming.** Audio is now billed
  as it goes out, so a single reservation at gate-close would meter after the
  fact. Moved to per-hop reservation *before* each send — the ceiling stays
  exact, and a mid-utterance refusal abandons the whole utterance (no commit,
  no transcript, no synthesis, no audio) rather than truncating it.

### Files changed

Modified: `agent/elevenlabs_client.py` (streaming begin/push/commit/await_final,
hold-last-hop commit, `ping`, `warmup`), `agent/tts_engine.py` (async feed_hop,
per-hop metering, keepalive task, streamed/fallback paths),
`agent/convert_agent.py` (`--tts-hangover-ms`, pooled connector, warmup call),
`agent/wer.py` (off-script threshold 0.5 → 0.8, calibrated),
`agent/analyze_capture.py` (disown alignment + tail-clip in tts mode),
`agent/test_tts_engine.py` (contract amended + streaming/governor tests),
`agent/README.md`, `SPIKE.md` (experiment ledger).

### Verification results

- **122 tests pass** (67 pre-existing unchanged). Mock vendors only.
- Test contract amended deliberately: `test_nothing_is_sent_while_the_gate_is_open`
  → `test_audio_streams_while_open_but_nothing_is_COMMITTED_until_close`, plus
  `test_exactly_one_commit_per_utterance` and a streaming-failure fallback test.
- Live drill, real LiveKit + real ElevenLabs, `eleven_flash_v2_5`:

  | config | tail p50 | p95 | TTFB p50 | STT p50 | WER |
  |---|---|---|---|---|---|
  | baseline (before sprint) | 1938 ms | 2511 ms | 372 | 1121 | 0.1458 |
  | streaming STT only | 1074 ms | 1720 ms | 376 | 315 | 0.1458 |
  | + keepalive | 1063 ms | 1080 ms | 323 | 349 | 0.1458 |
  | **+ hangover 200 (default)** | **954 / 932 ms** | **1009 / 949 ms** | 352 | 324 | 0.1458 |
  | + hangover 100 (aggressive) | 787 ms | 880 ms | 331 | 321 | 0.1458 |

  5/5 utterances every run, no splitting, transcripts identical throughout,
  corpus WER unchanged at 0.1458 (the one spoken-digits line).
- Governor green before every billable experiment; spend across the whole
  sprint stayed inside per-run caps with `refusals=0`.

### Outcome

**Target met: p50 932–954ms (was 1938), p95 949–1009ms (was 2511) — roughly
halved, with the CEO's declared reference quality untouched.** Stretch target
(800ms) is reachable at `--tts-hangover-ms 100` and is offered rather than
chosen, because the risk it carries is one only an ear can judge.

Next, in order of value: (1) VPS topology — ~400ms of pure network sits in the
tail and a deployment move should take most of it; needs an ElevenLabs key in
the VPS `secrets.env`, **for Amy to place, not for me to copy**. (2) Amy's ear
on safe-vs-aggressive hangover, ideally free-talking rather than reading.

---
---

## 28 July 2026 — SPIKE: STT→TTS second engine (`--engine tts`), DRAFT PR

### Task (verbatim)

> SPIKE — STT→TTS voice engine (branch: feat/spike-stt-tts) — EXPERIMENTAL
> Full build-and-retest autonomy granted: iterate against real APIs and real
> LiveKit to green without check-ins. PR opens as DRAFT; merge is not the goal —
> an answered question is.
>
> GOAL: Second engine behind the existing agent: --engine rvc|tts (default rvc,
> completely untouched; RVC client not initialized in tts mode). In tts mode the
> Phase 3 VAD gate becomes an utterance endpointer: buffer speech while open; on
> gate-close, transcribe the utterance (STT), synthesize with Amy's cloned
> ElevenLabs voice, stream synthesized PCM back through the existing output path
> (jitter buffer/publisher unchanged, 48k mono).
>
> GUARDRAIL FIRST — write the spend governor before any API call exists:
> hard per-run caps MAX_TTS_CHARS (default 5000) and MAX_STT_SECONDS (default
> 300), env-overridable, loud refusal past cap, agent stays alive. ElevenLabs
> bills per character; an autonomous loop must be PHYSICALLY unable to drain
> the Creator account.
>
> VERIFY BEFORE CODING (live docs + real calls, current IDs never hardcoded):
> - TTS: streaming endpoints (websocket vs HTTP stream), TTFB behavior, PCM
>   output format/rates. Model knob must accept: eleven_flash_v2_5 (speed),
>   eleven_multilingual_v2 (quality), eleven_v3 (ceiling probe — expected to
>   miss the latency budget; measure it anyway).
> - STT: default candidate is ElevenLabs Scribe v2 Realtime (one vendor, one
>   key); verify streaming support + latency-to-final; note Deepgram streaming
>   as runner-up with one-line reasoning. Pick ONE for the spike.
> - Voice: ELEVENLABS_VOICE_ID + ELEVENLABS_API_KEY from secrets.env.
>
> METRICS (the spike IS an instrument):
> - tail_latency := last speech sample (gate-close minus hangover) → first
>   synthesized sample enqueued. Per utterance; report p50/p95 per model_id.
> - Per utterance: STT ms, transcript, TTS TTFB ms, chars billed, model_id.
> - WER/edit-distance vs the known drill script per utterance (transcript
>   fidelity is a first-class result — accent robustness lives here).
> - --capture-dir works in tts mode; utterance events into meta.jsonl so
>   analyze_capture.py aligns them.
>
> TESTS (mock vendors; real APIs only in E2E):
> - Endpointer: exactly one STT call per utterance; hangover audio included;
>   nothing sent while gate open.
> - Governor refusal without crash. Fail-open: STT/TTS error drops that
>   utterance with logged reason; stream survives; next utterance proceeds.
> - Output continuity: 48k mono into jitter buffer, no clicks at boundaries.
> E2E (the Phase 3/4 harness: audio-file publisher, real LiveKit, real APIs):
> fixed script in → transcripts match, audio returns, tail_latency table
> produced across all three models, total spend inside governor caps.
>
> DOCS: SPIKE.md — architecture, the latency table, observed cost per minute of
> speech, and Amy's drill protocol: same fixed script, one reading per model,
> three scores each: clean /10, latency-feel /10, "is it ME?" /10.
> Session log per convention; small commits; committable boundary if limits hit.
>
> ADDENDUM — governor semantics + expressiveness knobs:
> 1. The spend governor is financial only. It must NEVER truncate an utterance
>    to fit remaining budget — if an utterance would exceed it, skip that
>    utterance WHOLE, log '[governor] utterance skipped (would exceed cap)',
>    and say so on the data channel. A tripped governor must be unmistakable
>    in the logs — never confusable with a pipeline bug.
> 2. Caps are per-process-run and env-overridable (SPIKE_MAX_TTS_CHARS /
>    SPIKE_MAX_STT_SECONDS) for deliberate longer sessions.
> 3. Expose ElevenLabs voice_settings (stability, similarity_boost, and style
>    if the current API supports it per live docs) as env-configurable values,
>    logged per utterance alongside model_id — expressiveness tuning is part
>    of what the spike measures, and Amy's MMv2 clone output is the declared
>    quality reference the other models are judged against.

### What was done

Order was deliberate: **the spend governor and its 18 tests were written and
green before a single billable line of code existed.** Only read-only API calls
(`/v1/models`, `/v1/voices/{id}`, `/v1/user/subscription`) were made before
that; every billable probe afterwards ran through the governor.

1. `spend_governor.py` + `test_spend_governor.py` — two per-run meters,
   reserve-then-call, refusal commits nothing.
2. Live API verification (below), then `elevenlabs_client.py`,
   `endpointer.py`, `tts_engine.py`, `wer.py`.
3. `convert_agent.py` wired for `--engine rvc|tts`; every RVC touchpoint
   guarded so the default path is bit-identical (verified: default still
   constructs `RvcClient` + `SolaStitcher` with the same `config_snapshot`
   keys, and the 67 pre-existing tests are unchanged and green).
4. `publish_wav.py` E2E harness, `drill_script.txt`, live E2E across all three
   TTS models, `SPIKE.md`.

### Findings / surprises

- **`output_format` is a QUERY param on the TTS endpoint, not a body field.**
  In the body it is silently ignored and the response is default 128 kbps MP3.
  Caught only by noticing 36 KB could not be 2.3 s of 48 kHz PCM — it costs the
  same and decodes to plausible-looking garbage in a PCM path. The first round
  of TTFB numbers was measured on MP3 and had to be discarded.
- **HTTP `/stream` beats the `stream-input` WebSocket on every model**
  (flash 365 vs 642 ms; MMv2 900 vs 2460 ms) and **`eleven_v3` is rejected at
  WS handshake entirely**. The WS exists for text still being produced by an
  LLM; we have the full transcript at once, so its buffering is pure latency.
- **`scribe_v2_realtime` is the only model the realtime STT socket accepts** —
  `scribe_v2`/`scribe_v1` connect happily and never emit a transcript.
- **Uploading STT audio at 16 kHz instead of 48 kHz cut p50 latency-to-final
  from 1463 ms to 871 ms** (3.0x smaller payload, byte-identical transcript).
  Reused `vad.py`'s existing `Resampler48to16` rather than writing a second one.
- **`pcm_48000` is accepted on this account (tier: pro, not Creator)** — so
  synthesis enters the existing 48 kHz output path with zero resampling.
- **`SolaStitcher` is wrong for TTS.** SOLA splices *overlapping* re-converted
  windows; synthesized audio is contiguous, so SOLA would crossfade a signal
  onto a shifted copy of itself and manufacture comb filtering. Swapped for a
  contiguous `PcmQueue` exposing the same surface, leaving `OutputGate` and the
  publisher untouched.
- **`eleven_v3` was NOT the slowest** despite being nominated as the ceiling
  probe: it beat `eleven_multilingual_v2` on both TTFB and tail latency. The
  quality reference is the slowest model.
- **WER cannot vary by TTS model** in this architecture — transcription happens
  before the TTS model is consulted. All 7 corpus edits came from one line of
  spoken digits being transcribed as `041-5273` (semantically perfect,
  orthographically different); the other four lines scored exactly 0.0.
- **SIGINT did not reliably reach the agent.** An orphaned run ignored it and
  had to be `kill -9`'d, stranding a completed drill with its report unwritten.
  Added explicit loop signal handlers plus `--run-seconds` for scripted runs,
  and guarded report writing against teardown errors.
- **The analyzer's "converter garbled" verdict lies in tts mode** — it assumes
  a frame-aligned converter, but the answer arrives ~tail_latency later by
  construction. Now reported as `ENGINE-LATENCY`.
- `ELEVENLABS_VOICE_ID` resolves to a cloned voice named **"Celebrity lilcrush
  linda"** (IVC, not PVC), not one named "Amy". Used as specified; flagged for
  confirmation before "is it ME?" scoring means anything.

### Files changed

New: `SPIKE.md`, `agent/spend_governor.py`, `agent/elevenlabs_client.py`,
`agent/endpointer.py`, `agent/tts_engine.py`, `agent/wer.py`,
`agent/publish_wav.py`, `agent/drill_script.txt`,
`agent/test_spend_governor.py`, `agent/test_endpointer.py`,
`agent/test_tts_engine.py`, `agent/test_wer.py`.
Modified: `agent/convert_agent.py` (`--engine`, guarded RVC touchpoints,
`--run-seconds`, signal handling, report), `agent/vad.py` (additive
`OutputGate.force_prime()`), `agent/analyze_capture.py` (utterance markers +
table, tts-mode silence attribution), `agent/README.md`.
Untouched: `echo_agent.py`, `bridge.py`, `rvc_client.py`, `knobs.py`,
`capture.py`, all of `src/`.

### Verification results

- **117 tests pass** (67 pre-existing unchanged + 50 new). Mock vendors only.
- `lk_smoke.py` → `CONNECTED OK` before any live run.
- Live E2E, real LiveKit Cloud + real ElevenLabs, 5-line drill per model,
  publisher pacing drift ≤ 19 ms:

  | model | tail p50 | p95 | TTFB p50 | STT p50 |
  |---|---|---|---|---|
  | `eleven_flash_v2_5` | 1938 ms | 2511 ms | 372 ms | 1121 ms |
  | `eleven_v3` | 2459 ms | 2850 ms | 734 ms | 1015 ms |
  | `eleven_multilingual_v2` | 2741 ms | 3071 ms | 942 ms | 1162 ms |

  0 skipped, 0 dropped, 0 underruns, 0 clipped tails, max queue depth 1.
  Corpus WER 0.1458 (all 7 edits = one digit-normalization line; 0.0 on the
  other four). Spend per run 213 chars / ~14.8 s STT — ~4% of the char cap,
  `refusals=0`. Measured cost ~990 chars per minute of speech.
- `analyze_capture.py` on a tts session: 5 utterances, 0 clipped tails,
  utterance markers aligned on the waveform timeline.

### Outcome

**The question is answered: no.** ~1.5 s of the ~1.9 s best case is serialized
vendor round trips on a chain that cannot start synthesizing before the speaker
stops. Versus the RVC path's ~200 ms, the gap is structural rather than tuning,
so this engine is a turn-taking technology, not a live voice-conversion one.
Audio quality and transcript fidelity are both excellent, which is why it is
worth keeping on the shelf for a turn-based product, and why the branch stays a
DRAFT rather than being merged.

Not pursued (deliberately, per the brief's test contract): streaming audio to
STT *while* the gate is open, which would cut roughly 800–1000 ms and is the
obvious next experiment if this direction is revisited.

---
---
## 28 July 2026 — Micro-fix: pin wranglerVersion in deploy workflow (PR #16, branch fix/deploy-wrangler-version)

### Task (verbatim)

> MICRO-FIX (branch: fix/deploy-wrangler-version): the deploy workflow's
> wrangler-action installed its fallback wrangler 3.90.0 (log evidence), which
> predates wrangler.jsonc support (3.91+) → deploy exits 1. Fix: add an explicit
> `wranglerVersion` input to the cloudflare/wrangler-action step matching the
> package.json devDependency, so version resolution is deterministic and immune
> to detection quirks. Verify the exact input name against the action's current
> docs. PR → CodeRabbit → hold for CTO; after merge, confirm the Actions run is
> green and `curl <worker-url>/api/health` answers.

### What was done

- Context: **PR #14 merged to main** (18:10 UTC, `2d37382`); the first
  `deploy-worker.yml` production run failed — `cloudflare/wrangler-action`'s
  bundled fallback **wrangler 3.90.0** can't parse `wrangler.jsonc` (support
  landed in 3.91).
- **Verified the input name** against the action's current docs:
  **`wranglerVersion`** (camelCase); accepts an exact version, a major, a range,
  or `latest`.
- Branched `fix/deploy-wrangler-version` from up-to-date main; added
  `wranglerVersion: "4.36.0"` to the wrangler-action step — an **exact** pin
  (deterministic, no detection fallback) matching `workers/api/package.json`'s
  `^4.36.0` devDep and the documented floor for `wrangler.jsonc` + the
  rate-limit bindings.

### Verification

- Workflow YAML parses (ruby); asserted the pin is on the wrangler-action step's
  `with:` (`wranglerVersion="4.36.0"`, `command=deploy`,
  `workingDirectory=workers/api`).
- The full CI run can only be confirmed **post-merge** (the workflow triggers on
  push to `main`).

### Next

- PR #16 → CodeRabbit → **HOLD MERGE** for CTO.
- After merge: confirm the Actions run is green and
  `curl https://luminastream-api.<account>.workers.dev/api/health` →
  `{"ok":true,…}`.

---

## 28 July 2026 — Stage 3-Lite, Session B: API Worker — admin gate + LiveKit mint (branch feat/s3lite-worker-auth)

### Task (verbatim)

> STAGE 3-LITE, Session B — Worker: admin gate + LiveKit token mint
> (branch: feat/s3lite-worker-auth)
>
> GOAL: One Cloudflare Worker (workers/api/) providing our first two owned backend
> endpoints: an admin gate and server-side LiveKit token minting — the path real
> users will eventually take, replacing the DEV-ONLY local script.
>
> VERIFY BEFORE WRITING CODE (convention): current Workers + wrangler config
> format and deploy flow against live docs; whether livekit-server-sdk runs in the
> Workers runtime (else mint the JWT manually — HS256 via Web Crypto, claims per
> LiveKit's current token spec — and validate a minted token against the real
> LiveKit Cloud project before calling it done); current Workers rate-limiting
> options on our plan, pick the simplest real one.
>
> ENDPOINTS: (1) POST /api/admin/verify — {password} vs env ADMIN_PASSWORD via
> constant-time compare (SHA-256 both sides, compare digests — never ===), returns
> a short-lived HMAC session token (~12h) sent as X-Admin-Token thereafter.
> (2) POST /api/livekit/token — requires valid X-Admin-Token; {room, identity} →
> LiveKit token (join, canPublish, canSubscribe, ttl ≤ 6h) from LIVEKIT_API_KEY/
> SECRET in Worker env. NO ungated minting. (3) GET /api/health — {ok, version}.
>
> RULES: secrets only via `wrangler secret put` (document exact commands, never
> values); .dev.vars gitignored; zero credentials in any commit. Rate limit verify
> hard, token moderately. CORS: studio.luminastream.live, *.pages.dev previews,
> localhost:5173. Frontend: when VITE_API_BASE set, LiveKitTest gains a "mint via
> server" path (password → verify → token auto-filled); manual paste stays the dev
> fallback. Tests: token claims + expiry, constant-time compare, auth rejections,
> CORS matrix, rate-limit trips. DOCS & PROCESS: README Worker section with Amy's
> exact deploy steps; PR via gh → CodeRabbit → HOLD MERGE for CTO.

### What was done

- Git hygiene: `main` pulled (PR #13 fast-forwarded in), `feat/s3lite-pages`
  deleted, branched `feat/s3lite-worker-auth`.
- **Verified live before coding** (convention):
  - wrangler: `wrangler.jsonc` is Cloudflare's recommended format; required keys
    `name`/`main`/`compatibility_date`; secrets via `wrangler secret put` +
    `.dev.vars`. No `nodejs_compat` needed — the Worker is pure Web APIs.
  - `livekit-server-sdk` v2 uses `jose` (Workers-OK) but its package pulls in
    Node-only siblings (`@livekit/rtc-node` native) → **mint the JWT by hand**
    with Web Crypto HS256. Exact claim shape read from the installed SDK source
    and empirically probed: header `{"alg":"HS256"}`, payload `{name?,
    video{roomJoin,room,canPublish,canSubscribe}, iss, exp, nbf, sub}` — **no
    `iat`**.
  - Rate limiting: native Workers Rate Limiting binding (GA 2025-09-19),
    `ratelimits` + `simple{limit,period}`, period ∈ {10,60}, per-colo. Simplest
    real option → used it.
- `workers/api/` (**zero runtime deps**): `src/crypto.js` (base64url, sha256,
  hmac, `timingSafeEqual`, `constantTimeCompareSecrets`), `session.js` (12h HMAC
  session sign/verify, sig-checked before payload trusted), `livekit.js` (HS256
  mint, 6h clamp), `cors.js` (allowlist + preflight), `index.js` (router + 3
  handlers). `wrangler.jsonc` with two limiters; `package.json`;
  `.dev.vars.example`; local `.gitignore`; `README.md`.
- Endpoints exactly per spec. `/api/admin/verify`: rate-limit 5/60s → 500 if
  unconfigured → 400 on blank pw → constant-time SHA-256 digest compare → 12h
  session token. `/api/livekit/token`: X-Admin-Token gate → 30/60s → mint,
  returns `{token, url, room, identity, expiresAt}`. `/api/health` public.
- CORS scoped to `studio.luminastream.live` + `*.luminastream-studio.pages.dev`
  (our project's previews) + `localhost:5173` — deliberately tighter than a
  literal `*.pages.dev` (rationale in cors.js); no ACL credentials (session is a
  header, not a cookie).
- Frontend: `src/lib/serverMint.js` (`verifyAdmin` / `mintToken` / `mintViaServer`
  with a one-shot re-auth on 401) + `LiveKitTest.jsx` "Mint via server" block,
  rendered **only when `VITE_API_BASE` is set**. Manual URL/token paste stays the
  dev fallback.
- Docs: README "API Worker (Cloudflare)" — Amy's exact `wrangler login` /
  `secret put` (×5) / `deploy` / `curl /api/health` / `VITE_API_BASE` wiring +
  optional `api.luminastream.live` route. No secret values anywhere.

### Key findings / surprises

- jose/LiveKit emit **no `iat`** and a bare `{"alg":"HS256"}` header (no `typ`) —
  replicated exactly so the equivalence check is byte-clean.
- **Validated against the REAL LiveKit Cloud project** (creds from secrets.env):
  (1) claim-by-claim equivalence vs SDK `AccessToken`; (2) the SDK's own
  `TokenVerifier` accepts our hand-minted token; (3) Twirp `ListRooms` with an
  admin token **our Worker code signed** → **HTTP 200** (it even listed the live
  `luminastream-test` room). Real LiveKit Cloud accepts our signing. Project
  subdomain kept out of the repo and these logs.
- Node 24 ships `crypto.subtle` + global `Request`/`Response`, so the Worker's
  default export is unit-testable via `node --test` with injected fakes (env +
  rate limiters) — no miniflare needed. The offline SDK-equivalence/live checks
  live in the scratchpad, not the committed suite, to keep tests dep-free.

### Files changed

- NEW `workers/api/`: `src/{crypto,session,livekit,cors,index}.js`,
  `test/{crypto,session,livekit,http}.test.js`, `wrangler.jsonc`, `package.json`,
  `.dev.vars.example`, `.gitignore`, `README.md`.
- NEW `src/lib/serverMint.js` + `src/lib/serverMint.test.js`.
- `src/pages/LiveKitTest.jsx` (gated server-mint UI), `README.md` (Worker
  section), `.gitignore` (`.dev.vars`, `.wrangler/`).

### Verification

- Worker tests **34/34** (claims/expiry, constant-time, session tamper/expiry/
  bad-subject, auth rejections, CORS matrix incl. dot-boundary + suffix-spoof,
  rate-limit trips, method/404).
- Frontend node tests **21/21** (serverMint 8 incl. re-auth & no-retry paths +
  existing apiBase/knobState). Lint **clean**. Typecheck **60 errors = main
  baseline** (my files add 0). `npm run build` green.
- `wrangler deploy --dry-run`: config parses, Worker bundles **10.59 KiB**, both
  rate-limit bindings registered (VERIFY 5/60s, TOKEN 30/60s).
- Live LiveKit Cloud token acceptance: **HTTP 200** (see findings).

### CodeRabbit round (PR #14)

Two findings, both fixed in `75a1f47` and explicitly confirmed resolved by
CodeRabbit (`<review_comment_addressed>`); re-review **pass**, no new findings:

- 🟠 **Major (security)**: `/api/livekit/token` ran `verifySession` BEFORE the
  rate-limit, so anonymous garbage-token spam hit the HMAC-verify path
  unthrottled. Moved the IP-keyed limiter ahead of verification (limit-first,
  like `/api/admin/verify`); dropped the `sub:ip` key (subject unknown
  pre-verify, always `admin`). New regression test asserts **429-before-401**.
  CR: "closes the anonymous HMAC-verification flood path."
- 🟡 **Minor (docs)**: Worker local-dev used `npm run dev` (repo reserves that
  for frontend-only Base44 work) → `npx wrangler dev` in both READMEs.

Post-fix: Worker **35/35**, lint clean. Merge still **HELD**.

### Addendum — automated deployment (CEO directive)

Directive: GitHub Actions deploy on merge; staging env; scripted secret
injection; README = token-mint + GitHub secrets (DNS stays a human act).

Verified live first: `cloudflare/wrangler-action` is **@v3** (inputs apiToken,
accountId, command, environment, workingDirectory); wrangler named-env
inheritance — **ratelimits + observability + vars + bindings are
NON-inheritable**, so staging must redefine them; minimal deploy token =
**Workers Scripts: Edit + Account Settings: Read**, account-scoped, with **no**
Zone/DNS/Routes/KV/R2.

- `wrangler.jsonc`: added `env.staging` (name `luminastream-api-staging`, its
  own `observability` + `ratelimits` with namespace_ids 2001/2002 → counters
  isolated from prod). Top-level stays production. `package.json` `deploy`/`tail`
  now default to `--env staging` (agent/manual → staging); **no** local
  production-deploy script (production is CI-only).
- `.github/workflows/deploy-worker.yml`: on push to `main` touching `workers/**`,
  runs the Worker tests then `cloudflare/wrangler-action@v3` `command: deploy`
  (top-level = production) with `apiToken`/`accountId` from GitHub secrets.
  `permissions: contents: read`, a `concurrency` guard, and
  `environment: production` (optional approval gate). Production deploys ONLY here.
- `scripts/put-worker-secrets.sh [staging|production]`: pipes each value from the
  gitignored `secrets.env` straight into `wrangler secret put` over stdin — pure
  `grep|cut|tr` pipe, value never in a shell var, never echoed; bash-3.2-safe
  empty-array guard. Sets all five Worker secrets.
- README: replaced the manual deploy steps with the automated flow — narrow
  token mint (exact two scopes, expiry, no DNS) → paste `CLOUDFLARE_API_TOKEN` /
  `CLOUDFLARE_ACCOUNT_ID` into GitHub → run the secret script. Custom-domain DNS
  documented as a deliberate human act (the token has no DNS scope).

Verified: `bash -n` + an extraction test (keeps `=` in values, skips missing);
workflow YAML parses (ruby); `wrangler deploy --dry-run` for BOTH top-level and
`--env staging` bundle with their own rate limiters; Worker **35/35**, lint clean.

Follow-up (owner): the script already covered all five secrets incl.
`ADMIN_SESSION_SECRET`; documented generating it as `openssl rand -base64 32`
into `secrets.env` (README + `.dev.vars.example`) and added a **kill-switch**
note — rotating `ADMIN_SESSION_SECRET` instantly invalidates every outstanding
admin session (HMAC verify fails closed; wrangler applies the new secret on the
next request, no redeploy). Proved base64 (`=` padding) extraction is byte-exact.

CodeRabbit round 2 (addendum, d5afef6): 2 findings — `put-worker-secrets.sh`
all-or-nothing **preflight** (Major: prevents partial updates and a rotation
silently keeping an old secret) + checkout `persist-credentials: false` (Minor)
— both fixed and **confirmed resolved** by CodeRabbit. All **4** PR findings
across 2 rounds resolved; check green, PR **mergeable**, merge **HELD** for CTO.

### Next

- **HOLD MERGE** — awaiting CTO decision on PR #14. On merge, the new workflow
  auto-deploys the **production** Worker (once the `CLOUDFLARE_*` GitHub Actions
  secrets exist).
- Amy: mint the narrow token → GitHub secrets; run
  `scripts/put-worker-secrets.sh` for staging + production; set `VITE_API_BASE`
  on the Pages project.

---

## 27 July 2026 — Stage 3-Lite, Session A: Cloudflare Pages hosting (PR #13)

### Task (verbatim)

> STAGE 3-LITE, Session A — Pages hosting (branch: feat/s3lite-pages)
> Goal: the existing Vite frontend served at studio.luminastream.live from
> Cloudflare Pages. VERIFY FIRST: current Pages deployment flow (git-connected
> vs wrangler) against live Cloudflare docs. Requirements: build config for the
> repo as-is (npm run build → dist/); an API base URL env var (VITE_API_BASE)
> replacing the dead Base44 proxy — default empty, all legacy Base44 calls fail
> soft (they already do); /livekit-test must work on the deployed site exactly
> as on localhost. NO secrets anywhere: wrangler/Pages config in repo must
> contain zero keys (repo is public). Deliverable: deployment doc in README
> (Amy connects the repo + sets the custom domain in her dashboard — list her
> exact clicks), PR, CodeRabbit, hold merge for CTO.

### What was done

- Verified against live Cloudflare docs (get-started, git-integration,
  serving-pages, custom-domains, Vite framework guide): chose **git
  integration** — direct upload needs an API token (a secret; repo public),
  git flow is dashboard-only. Repo carries ZERO Cloudflare config files.
- SPA fallback verified automatic: no top-level 404.html in build output →
  Pages serves index.html for all unmatched paths. Vite emits only index.html
  (checked), so /livekit-test deep links need no _redirects/Functions.
- `src/lib/apiBase.js`: API_BASE from build-time VITE_API_BASE (default '',
  trailing-slash/whitespace normalized) → SDK `serverUrl` (verified installed
  @base44/sdk client.js:84 joins `${serverUrl}/api`; explicit '' bypasses the
  base44.app default) + AuthContext axios baseURL. 6 node --test cases.
- README: "Deploy — Cloudflare Pages" section with Amy's exact clicks
  (connect repo, build config Vite/npm run build/dist, custom domain incl.
  the 522 bare-CNAME pitfall, VITE_API_BASE rebuild-required semantics).
- Drive-by chore: removed unused `Check` import in VoiceMetricsPanel.jsx —
  pre-existing eslint error on main (file otherwise untouched).

### Key findings / surprises

- Fail-soft nuance differs by host but converges: vite preview 404s /api
  (error → authError 'unknown' → App.jsx renders routes); Pages SPA mode
  will 200 /api with index.html (no error → routes render; appPublicSettings
  garbage inert — nothing outside AuthContext consumes it).
- Wire-through proof: VITE_API_BASE=https://api.wiretest.example/ build puts
  the value in the bundle once; unset build carries no trace.
- Built-page E2E: vite preview + headless Chrome renders /livekit-test fully
  (heading + URL/token inputs, no auth spinner) from static dist with the
  proxy dead — the deployed behavior, simulated locally.

### Files changed

- `src/lib/apiBase.js`, `src/lib/apiBase.test.js` (new)
- `src/api/base44Client.js`, `src/lib/AuthContext.jsx` (API_BASE wiring)
- `README.md` (deployment doc), `src/components/admin/VoiceMetricsPanel.jsx`
  (chore), `devlog/SESSIONS.md`, `notes.md`

### Verification results

eslint clean (incl. the pre-existing fix), 11/11 node --test, npm run build
clean, wire-through + preview E2E as above. PR #13 open on feat/s3lite-pages;
CodeRabbit review awaited. **Merge held for CTO.**

### CodeRabbit round (PR #13)

Two findings, both applied in 378aa45:

1. (Minor, inline) "fail soft exactly as on localhost" wording papered over
   the per-host difference — dev server 404s dead /api paths, Pages SPA
   fallback answers them with the app document (HTTP 200). apiBase.js comment
   + README now state both shapes and why the 200-shell is inert. Threaded
   reply 3658740252.
2. (Trivial, review body) unit tests didn't prove a configured VITE_API_BASE
   reaches the bundle. Added apiBase.build.test.js: real vite build into a
   temp dir (dist/ untouched), asserts sentinel baked when set / absent when
   unset — guards against a dynamic import.meta.env refactor shipping ''.
   Reply comment 5093523302.

After: 8/8 apiBase tests (6 unit + 2 build), 5/5 knobState, eslint clean.
**Merge still held for CTO.**

---

## 27 July 2026 — Live knob-twisting E2E green; PR #12 merged

### Task (verbatim)

> Run the staged E2E test. If green, merge PR #12.

### What was done

- Gate first: `lk_smoke.py` → CONNECTED OK (Starlink resolver recovered;
  *.livekit.cloud resolves again).
- Reused the user's already-running `mock_rvc_server.py` on :8000 (it parses
  mid-stream JSON text frames — usable as-is, left untouched).
- Ran `convert_agent.py --room luminastream-diag --mode convert --capture-dir
  captures` (VAD active) + staged scratchpad `publish_probe4.py`: real-time
  probe audio, `set_config {protect:0.5, vad_hangover_ms:500}` at ~4s (valid),
  `{index_rate:1.5, f0_method:"dio", warp:3}` at ~8s (garbage).
- Verified capture session `20260727-081501-854120` and ran
  `analyze_capture.py` on it.

### Findings / verification (all green)

- Broadcasts: change 1 applied verbatim; change 2 → index_rate clamped to 1.0
  (adjusted reported), dio + warp rejected with reasons; agent never crashed,
  3 utterances, 0 clipped tails, turnaround p50/p95 = 84/162 ms.
- meta.jsonl: both config_change events with full applied snapshot +
  t/in_pos/out_pos + adjusted/rejected.
- Analyzer: "config changes" report section correct; dropout map draws both
  green dotted config markers with knob labels. Deferred fixes proved live:
  buffer-depth stats excluded 53 gated hops (median 1.52 hops gate-open only);
  4.76–9.34s silence attributed VAD-gated (intentional) at 8% input activity.
- Serialized apply path (9159ebb) ran live; each broadcast matched its apply.
- Agent SIGINT exit code 1 is the normal "stopped by user" path (no traceback).

### Files changed

- `devlog/SESSIONS.md`, `notes.md` — this record (E2E artifacts live in
  agent/captures/, which is untracked)

### Outcome

E2E evidence posted on PR #12 (comment 5093180622). **PR #12 merged into main
on the owner's go-ahead** — Phase 4 tuning console is on main.

---

## 27 July 2026 — CTO merge condition on PR #12: serialize config application

### Task (verbatim)

> CTO merge condition on PR #12, one focused commit on the same branch:
>
> Serialize config application. The _spawn keepalive fix (ca4c302) solves the
> dropped-reference hazard but not ordering: two in-flight _apply_config tasks can
> interleave their RVC settings frames, leaving the server on an older value than
> the agent's applied-truth broadcast claims — and with no server-side settings echo,
> nothing self-corrects. Add an asyncio.Lock created in __init__ (self._config_lock)
> and wrap the entire body of _apply_config in `async with self._config_lock:` —
> clamp, apply, capture snapshot, broadcast, all inside, so applies are strictly
> FIFO and every broadcast reflects the true final state of its apply. Add one test:
> two overlapping set_config applications (slow mock RVC send) must result in the
> LAST requested value both in rvc.config and in the final broadcast. Run the full
> suites, push, reply on the PR referencing this as the CTO-requested serialization.

### What was done

- `agent/convert_agent.py`: `self._config_lock = asyncio.Lock()` in `__init__`
  (with a comment stating the interleave hazard it closes); the entire body of
  `_apply_config` — clamp → agent/RVC apply → capture `config_change` snapshot →
  `_publish_config` — now runs inside `async with self._config_lock:`. No other
  behavior change; `_spawn` still keeps every apply task alive.
- `agent/test_knobs.py`: new `test_overlapping_applies_serialize_fifo`. Real
  `ConvertAgent` connected to the in-process mock RVC server; the first apply's
  `send_settings` is wrapped with a 0.05 s delay (second instant) so an
  unserialized run lands the stale frame last. Two overlapping `_apply_config`
  tasks (`protect` 0.1 then 0.4) via `_spawn`; asserts the LAST value wins in
  `rvc.config`, in the final broadcast (order `[0.1, 0.4]`), and in the last
  settings frame the server received.

### Key findings / verification

- **Discrimination proof**: with `async with self._config_lock:` temporarily
  replaced by `if True:`, the test fails exactly as the CTO predicted — the
  slow first apply's frame lands last and `rvc.config` ends on the stale 0.1
  (`assert 0.1 == 0.4`). Lock restored, test passes.
- Full suites: **49/49 Python** (was 48 + new test), **5/5 node**.
- One earlier verification run was void (a `cd agent` failed because cwd was
  already in agent/, so the neutralization never ran); redone with explicit
  paths before trusting the result.

### Files changed

- `agent/convert_agent.py` — `_config_lock` + wrapped `_apply_config`
- `agent/test_knobs.py` — `test_overlapping_applies_serialize_fifo`
- `devlog/SESSIONS.md`, `notes.md` — this record

### Outcome

Committed `9159ebb` on feat/phase4-tuning-console, pushed, replied on PR #12
referencing the CTO-requested serialization with the test + discrimination
proof as evidence (comment 5092528872). **Merge remains held for CTO.**

---

## 27 July 2026 — Phase 4: live tuning console (knobs over the data channel)

### Task (abridged; full text in the PR)

> Dev console on the LiveKit test page whose knobs apply mid-session through
> the agent, with agent-confirmed truth for every value. Verify first whether
> the RVC server supports mid-stream config updates (else apply-via-
> reconnect). Knobs: RVC index_rate/protect/rms_mix_rate/f0_method; agent
> prime depth / VAD threshold / VAD hangover. Capture config_change snapshots;
> analyzer config markers + two deferred fixes (gate-open-only buffer stats,
> recalibrated VAD-gated activity bar). Fail-safe clamping. Tests. README
> A/B protocol. PR, CodeRabbit, HOLD MERGE for CTO review.

### Verified before coding

- **Mid-stream config: SUPPORTED.** OpenVoiceChanger backend @ `4cee7ef`
  (`backend/routers/websocket.py`): the main loop accepts JSON text frames at
  any time (`_handle_json_message` → `_apply_settings` mutating conn_state);
  every binary frame re-reads the settings in `_process_frame_sync`. So RVC
  knobs are one text frame on the open socket — the apply-via-reconnect
  fallback was NOT needed and was not built.
- **f0 methods actually supported** (`rvc_processor._normalize_f0_method`):
  rmvpe / harvest / crepe / pm. dio is aliased to pm, fcpe conditional on
  torchfcpe — both deliberately not offered in the console.
- Data channel: agent_mode format re-checked; extension is additive
  (new `agent_config` message type), same JSON-in-Uint8Array discipline.

### What was built

- `agent/knobs.py` — single-source knob registry (kind/range/default/target)
  + `clamp_params()` fail-safety chokepoint: out-of-range → clamped +
  reported, garbage/unknown/invalid-enum → rejected with reason, never
  raises. Registry serialized into every broadcast so the UI renders ranges
  and defaults from agent truth.
- `RvcClient.send_settings(partial)` — one JSON text frame mid-stream; also
  merges into `self.config` so a reconnect carries the current tuning.
- `VadGate.set_threshold/set_hangover_ms` (hop-rounding rule preserved);
  prime depth via `outgate.prime_samples` (applies at next re-prime).
- convert_agent: `set_config` handling → `_apply_config` (clamp → apply →
  capture `config_change` with FULL applied snapshot → broadcast
  `agent_config {config, defaults, ranges, adjusted?, rejected?}`);
  broadcast also on join and at startup; session header carries the config.
- Analyzer: config-change markers on dropout map (output timeline) and RMS
  envelope (input timeline) + per-change report section with full snapshots.
  Deferred fix 1: buffer-depth stats now computed over gate-OPEN hops only
  (drained-by-design gated hops were making the jitter buffer look starved).
  Deferred fix 2: VAD-gated activity bar recalibrated against MEASURED
  duty-cycles from the local acceptance capture (typing 8.0%, clap 5.3%,
  silence 0.0%) → `GATED_MIN_ACTIVE_FRAC = 0.025` (≈ half the weakest real
  transient), documented for re-check against the pod's phase3_acceptance2.
- Frontend: `src/lib/knobState.js` (pure applied-truth derivation) +
  Tuning card on LiveKitTest.jsx — sliders/selects hold REQUESTED values,
  confirmed badges render ONLY the agent_config broadcast (green match /
  amber ⚠ mismatch / muted unknown), rejected-knob banner, revert-to-
  defaults; hook gains `agentConfig` + `requestAgentConfig`.

### Verification

- **48/48 Python tests** (10 new: clamp matrix incl. NaN/bool/unknown/case-
  insensitive enum; config_change snapshot integrity; mid-stream settings
  frame + reconnect carry-over + disconnected-store against an in-process
  WS server speaking the verified protocol; ConvertAgent._apply_config
  end-to-end without a room). **5/5 node --test** on knobState (UI renders
  applied-not-requested pinned as logic tests — repo has no browser runner).
- eslint + vite build clean; mock server confirmed compatible with
  mid-stream text frames (it already logs and continues).
- **Live E2E vs mock: BLOCKED by network** — the Starlink resolver
  (100.64.0.2) currently returns no answer for `*.livekit.cloud` while
  1.1.1.1 resolves it fine (`lk_smoke.py` FAIL, DNS-level). The knob-
  twisting E2E script is ready in the scratchpad; rerun when DNS recovers.
  GitHub was unaffected, so the PR proceeds; merge held for CTO anyway.

### Files changed

New: `agent/knobs.py`, `agent/test_knobs.py`, `src/lib/knobState.js`,
`src/lib/knobState.test.js`. Modified: `agent/convert_agent.py`,
`agent/rvc_client.py`, `agent/vad.py`, `agent/analyze_capture.py`,
`agent/README.md`, `src/hooks/useLiveKitVoice.js`,
`src/pages/LiveKitTest.jsx`, `devlog/SESSIONS.md`, `notes.md`.

### CodeRabbit round (PR #12)

4 findings (2 Major), all applied in ca4c302 with threaded evidence
replies: `_spawn()` keepalive set for ALL fire-and-forget tasks (also
fixes the `_config_task` overwrite under rapid set_config — this finally
does the sweep deferred from PR #10); rejected-wins between
adjusted/rejected for vad knobs under --no-vad; sliders keyboard-operable
(Arrow/Home/End/Page publish) + aria-labelledby; notes.md wire-key typo.
48/48 py + 5/5 node after. Merge HELD for CTO review.

### Task (verbatim)

> the CTO has requested a Phase 3.1 micro-PR to fix the torch bloat and
> NNPACK log spam on the VPS convert agent.
> Switch the Silero VAD to its onnxruntime path (load_silero_vad(onnx=True)).
> Pin torch from the CPU-only index in requirements.txt to shed the gigabytes
> of unnecessary CUDA libraries.
> Verify against the installed package per our conventions, execute the
> fixes, and open the PR.
> before you commit or push anything, make sure you run
> git checkout -b fix/phase3-1-onnx-diet so this is on a clean branch

### Verified against the installed package (live, never memory)

- onnxruntime is an OPTIONAL silero-vad dep — not present until installed;
  pip resolves **1.19.2** on py3.9 (last line with cp39; also ships cp312
  for the VPS).
- `load_silero_vad(onnx=True)` → `OnnxWrapper`; **torch tensors still
  required** (numpy input rejected: AttributeError `.dim` — verified live),
  512-chunk rule and `reset_states()` identical to the JIT path.
- silero_vad.utils_vad imports torch at module level ⇒ torch cannot be
  dropped, only dieted: CPU-only wheels via
  `--extra-index-url https://download.pytorch.org/whl/cpu` with
  platform-marked pins (`2.8.0+cpu` on linux, plain `2.8.0` elsewhere —
  macOS has no +cpu builds). Wheel existence for cp312 x86_64 confirmed
  against the index.
- ONNX ≡ JIT numerically: zero-chunk prob 0.00167 both; fox sentence 99% of
  chunks ≥ 0.5; `VadGate().load()` → active, speech hop prob 1.0.
- NNPACK spam comes from TorchScript conv on unsupported VPS hardware —
  onnxruntime inference sidesteps it entirely.

### Changed

`agent/vad.py` (onnx=True + verified-contract docstrings),
`agent/requirements.txt` (extra-index, onnxruntime==1.19.2, platform-marked
torch/torchaudio CPU pins), session log, notes.md. 37/37 tests pass
(fail-open test monkeypatches the loader — unaffected by the backend swap).

### Task (abridged; full text in the PR)

> Gate the pipeline with Silero VAD on the VPS so only speech is sent to the
> RVC server; everything else becomes clean silence in the output. Verify the
> silero distribution/API before coding; per-hop gate; onset protection
> (context accumulates through gates — assert it); tail protection (300 ms
> hangover, flag-tunable); fail-open; --no-vad/--vad-threshold/
> --vad-hangover-ms; capture gate events; analyzer gains a third dropout
> attribution "VAD-gated (intentional)"; data-channel state backward-
> compatibly; gated hops enqueue nothing and are not drops. Test locally vs
> the mock; README Phase 3 section + acceptance protocol; atomic commits;
> PR via /opt/homebrew/bin/gh; await CodeRabbit and reply with evidence.

### Verified before coding (live docs + the venv, never memory)

- pip `silero-vad` **6.2.1** (Feb 2026) installs cleanly in agent/.venv
  (py3.9), pulling torch 2.8.0 + torchaudio 2.8.0 — all three pinned.
- API verified by introspection + live calls: `load_silero_vad(onnx=False)` →
  TorchScript model; `model(chunk, 16000)` returns a speech prob and
  **requires exactly 512-sample chunks** (256 rejected live); LSTM state kept
  across calls, `reset_states()` present; `VADIterator` default threshold
  0.5 → mirrored as our default (we implement hangover ourselves, calling
  the model directly per chunk).
- Geometry: HOP 6144 @48k = 2048 @16k = exactly 4 silero chunks per hop —
  gate decisions land on hop boundaries by construction.

### What was built (4 atomic commits)

1. `vad.py` + `SolaStitcher.drain()` + `test_vad.py` — `Resampler48to16`
   (FIR anti-aliased 3:1 decimation, filter state carried: chunked ==
   one-shot bit-identical), `VadGate` (max-prob threshold + hangover rounded
   UP to whole hops; fail-open on load/runtime error), `OutputGate`
   (fade-out drain of the stitcher tail at gate close — `drain()` releases
   the provisional XFADE tail, no underrun counting; silence while closed;
   re-prime + 15 ms equal-power fade-in at open; gate_open=True ==
   pre-Phase-3 behavior, proven byte-identical in a test).
2. convert_agent wiring — per-hop decision on `window[-HOP:]`; gated hops
   `continue` before the websocket (nothing enqueued, `gated` counter, not
   drops); assembler untouched by gating with a runtime seq-monotonicity
   assert; on output drain, in-flight windows from the closed period are
   marked stale by seq; fail-open published once on the data channel;
   `agent_mode` payload gains additive `vad` field; flags + startup config
   log; capture header + `vad_gate`/`vad_drained` events.
3. Analyzer third attribution — `gated_spans_from_events` (input-timeline
   spans, open-ended tail), `classify_silences` → benign / vad_gated /
   dropout, violet dropout-map shading, per-category report.
4. Classifier fix from E2E evidence — sparse transients (typing ≈ 9% of
   envelope frames) fell under the 30% activity bar and read as benign;
   gate-overlap is now checked first with a 5% floor.

### Verification

- **37/37 tests** (14 new). Deterministic stub prob_fn (sustained-energy,
  so impulses score 0 like real silero); assertions: gated spans exactly
  zero, hangover hops still sent, max sample-to-sample jump at gate edges
  0.014 (< 0.05 — no clicks), first post-gate window bit-equal to the raw
  input's last WINDOW samples (context continuity), fail-open pipeline ==
  ungated pipeline, OutputGate == legacy path when gate always open.
- **E2E vs mock with the REAL silero model** (fox → typing 3 s → clap →
  fox): gate opened only for the two spoken sections (prob 1.00 open /
  0.02 close), typing and clap never opened it; 49 windows sent vs 70
  gated; 0 drops, 0 stale, 0 underruns; analyzer: 0 clipped tails,
  0 dropouts, typing+clap span attributed **VAD-GATED 5.02–9.60s
  (intentional)**; dropout map renders the violet gated block; latency
  340→360 ms unchanged by gating.

### Files changed

New: `agent/vad.py`, `agent/test_vad.py`. Modified: `agent/bridge.py`
(drain), `agent/convert_agent.py`, `agent/analyze_capture.py`,
`agent/test_analyze.py`, `agent/requirements.txt`, `agent/README.md`,
`devlog/SESSIONS.md`, `notes.md`. Frontend untouched.

### CodeRabbit round (PR #10)

1 actionable + 5 nitpicks, all applied in c2e5ec4 (37/37 tests after):
notes.md stray kernel line labeled + verdict sentence completed; unused
`sent` → `_sent`; fail-open load test now exercises public `load()` via
monkeypatch; redundant `int(round())` removed; context-invariant assert →
explicit check + loud log (survives -O, keeps the stream alive); fail-open
publish task strongly referenced. Threaded reply + itemized evidence
comment posted on the PR.

### Task (verbatim)

> The CTO has reviewed your PR and requested the following mandatory updates on the current branch before merge:
>
> 1. THE "APPLIED TRUTH" UI FIX: The NS/EC/AGC readout currently renders React state (the requested constraints). Browsers frequently ignore these constraints silently. After publish and after each restartTrack, you must read `micTrack.mediaStreamTrack.getSettings()`, render the UI readout strictly from that actual state, and visually flag any mismatch between the button state and the applied state.
> 2. SECURITY HOTFIX: Add `CTO_HANDOVER*.md` to `.gitignore` immediately. The repo is public, and that file contains raw VPS IPs and port maps.
> 3. README PROTOCOL UPDATE: Add to the test protocol that macOS mic mode MUST be set to "Standard" (not Voice Isolation) via Control Center, and the user must use the built-in Mac microphone (no AirPods, to avoid headset DSP confounds).
> 4. GITHUB CLI PATH: You mentioned `gh` isn't installed. It is, but it's not on your PATH. Use the absolute path `/opt/homebrew/bin/gh` for your PR commands.
>
> Please push these changes to the existing Phase 2 branch, update the PR using `/opt/homebrew/bin/gh`, and await CodeRabbit's review.

### What was done

1. **Applied-truth readout** — hook gained `appliedConstraints` state read from
   `micTrack.mediaStreamTrack.getSettings()` after publish and after every
   `restartTrack` attempt (in `finally` — a failed restart still leaves a track
   whose real settings matter); cleared on disconnect/reset. The header readout
   now renders ONLY the applied state: green ✓/gray ✗ when it matches the
   buttons, **amber ⚠ with a requested-vs-applied tooltip on mismatch**,
   muted `NS–` when there is no live mic or the browser doesn't report a key.
2. **Security** — `CTO_HANDOVER*.md` added to the root `.gitignore`. Verified
   first: the file exists locally but was never tracked (`git ls-files` empty
   for it), so ignoring is sufficient — no history scrub needed.
3. **README protocol prereqs** — macOS mic mode MUST be "Standard" (Voice
   Isolation is OS-level DSP that clips tails upstream of the toggles) and
   built-in Mac mic only (no AirPods — onboard headset DSP is a second
   uncontrolled stage).
4. **gh works at `/opt/homebrew/bin/gh`** (it was installed since the earlier
   sessions' checks) — used for the PR update below.

### Verification

- eslint clean on both touched files; `vite build` clean; `tsc --noEmit` zero
  errors touching them. The applied-state read path (getSettings after
  publish/restart) was already live-proven by the Phase 2 headless-Chrome
  harness, which asserts on exactly those values.

### Files changed

`src/hooks/useLiveKitVoice.js`, `src/pages/LiveKitTest.jsx`, `.gitignore`,
`agent/README.md`, `devlog/SESSIONS.md`, `notes.md`.

### Task (verbatim)

> Phase 2 — capture-settings experiment (frontend only, then I run the pod session).
>
> Add audio-capture constraint controls to the LiveKit test page:
> - In src/hooks/useLiveKitVoice.js + src/pages/LiveKitTest.jsx ONLY: add three
>   toggles — noiseSuppression, echoCancellation, autoGainControl — default ON
>   (current browser behavior). Apply them as audio capture constraints when
>   publishing the mic track. BEFORE CODING: verify the exact constraint API
>   against installed livekit-client 2.20.1 (audioCaptureDefaults vs per-track
>   options — check the types, not memory).
> - Changing a toggle while connected should re-acquire/republish the mic with
>   the new constraints (or clearly require reconnect if the SDK demands it —
>   report which).
> - Show the active constraint state in the UI next to the mode indicator.
> - Update the agent README test protocol: the Phase 2 experiment is two
>   capture sessions (fox sentence + "mic test one two" x3), one with all
>   processing ON, one with all OFF, convert mode, --capture-dir enabled,
>   then analyze_capture.py on both and compare tail-clip reports.
> Branch → PR → CodeRabbit per convention. Log per CLAUDE.md.

### APIs verified against installed livekit-client 2.20.1 (types + live, never memory)

- `AudioCaptureOptions` (dist/src/room/track/options.d.ts:222) carries exactly
  `noiseSuppression` / `echoCancellation` / `autoGainControl` (ConstrainBoolean)
  plus deviceId etc. Two ways in: `RoomOptions.audioCaptureDefaults`
  (options.d.ts:35) or per-call — chose per-call:
  `setMicrophoneEnabled(enabled, options?: AudioCaptureOptions, publishOptions?)`
  (LocalParticipant.d.ts:100) since constraints can change per session.
- **Live toggle verdict: NO reconnect needed.**
  `LocalAudioTrack.restartTrack(options?: AudioCaptureOptions)`
  (LocalAudioTrack.d.ts:26) stops the old MediaStreamTrack, getUserMedias with
  the new constraints, and swaps via setMediaStreamTrack → sender.replaceTrack —
  publication and track SID survive.
- **Live-verified in headless Chrome** (fake mic, real LiveKit Cloud room, via a
  minimal harness page + result-POST server; no puppeteer on this machine):
  publish with all-ON → settings all true; restartTrack all-OFF → settings all
  false; back ON → all true; `trackSid` identical throughout; room stays
  connected. Chrome headless needed `--auto-accept-camera-and-microphone-capture`
  (the old fake-ui flag alone now yields NotAllowedError).
- Source-reading correction caught by the live test: I initially believed
  restartTrack dropped audio constraints without a deviceId (LocalTrack.restart
  maps audio to `audio: true` when constraints have no deviceId). Live run
  showed constraints DO apply — because `constraintsForOptions` injects
  `deviceId: {ideal:'default'}` when none is given, so the deviceId path is
  always taken. Real implication: without an explicit deviceId a toggle could
  silently jump to the system-default mic — so the hook pins the current device
  (`getSourceTrackSettings().deviceId`, fallback `getDeviceId(false)`) with
  `{exact: …}` on every restart.

### What was built (only the two allowed files + README)

- `useLiveKitVoice.js` — `captureConstraints` state (+ ref mirror), defaults
  all ON; `connect()` publishes with
  `setMicrophoneEnabled(true, {...captureConstraintsRef.current})`;
  `setCaptureConstraint(name, enabled)` updates state and, when connected,
  restarts the mic track in place with the device pinned; orphaned-room race
  guards match the file's existing pattern; getUserMedia failure during a
  restart surfaces via the existing `error` state.
- `LiveKitTest.jsx` — "Mic Processing" toggle row inside the Voice Mode card
  (three labeled on/off buttons, usable also while disconnected — they set the
  state for the next connect) + compact live state readout (NS✓ EC✓ AGC✓,
  green/gray) next to the agent-mode indicator.
- `agent/README.md` — Phase 2 experiment protocol: two convert-mode capture
  sessions (all-ON vs all-OFF), fox sentence + "mic test one two" ×3,
  `--capture-dir` on, analyze both, compare clipped-tail counts; hypothesis
  stated (browser processing eats word tails before the pipeline sees them).

### Verification results

- Headless-Chrome live run (above): 4/4 constraint states applied, same
  trackSid, room connected at end.
- eslint clean on both touched files; `vite build` clean; `tsc --noEmit`
  reports zero errors touching the two files (pre-existing errors elsewhere
  unchanged).

### Files changed

Modified: `src/hooks/useLiveKitVoice.js`, `src/pages/LiveKitTest.jsx`,
`agent/README.md`, `devlog/SESSIONS.md`, `notes.md`. Nothing else touched.

### Task (verbatim)

> Apply the four CodeRabbit findings on feat/capture-analysis-runbook before merge:
>
> 1. capture.py — bound the in-memory buffer (e.g. max ~60s of audio); if the
>    background writer task fails or the bound is hit, disable capture for the
>    session, log ONE loud warning with the reason, and free the buffers. The
>    agent's real-time loop must be unkillable by its own diagnostics.
> 2. capture.py — guard WAV size: cap capture at a sane max duration (or roll
>    to a new file); never write a header the format can't represent.
> 3. convert_agent.py — pop pending windows when discarded as stale so
>    turnaround/drop stats count each window exactly once. Add/extend a unit
>    test asserting no double-count on the stale path.
> 4. runbook.md — make the UFW commands real runnable lines, and pin the RVC
>    install to the exact commit we validated:
>    git+https://github.com/RVC-Project/Retrieval-based-Voice-Conversion@7b284a634667c34103eaaeed972b48ccdb4b893e
>    (add one line explaining WHY it's pinned: deterministic disaster recovery).
>
> Re-run the affected tests + one quick mock capture cycle to confirm the
> analyzer still reads cleanly. Reply to each CodeRabbit comment on the PR with
> what was done, per our convention. Push to the same branch.

### What was done

1. **capture.py self-defense** — new `_disable(reason)` path: sets `_dead`
   (every hot-path call becomes a no-op), frees ALL buffers, appends a single
   `capture_disabled` meta trace line, logs ONE `log.error`. Triggers:
   un-flushed audio > 60 s (`MAX_BUFFERED_BYTES`, tracked via
   `_pending_bytes` incremented on append / decremented on drain), pending
   meta lines > 200k, background-writer exception (previously it logged and
   the hot path kept appending forever — a slow leak), and the duration cap.
   Recursion guard: `_dead` is set before the trace line is appended.
2. **WAV size guard** — `MAX_CAPTURE_SECONDS = 3600` per stream; on hit,
   capture disables and the WAVs finalize with the audio captured so far
   (headers always patched with real sizes ≪ the 4 GiB uint32 RIFF limit).
   Bounds are per-instance attributes so tests can tighten them.
3. **Stale windows counted exactly once** — new
   `SessionCapture.window_stale(seq, reason)` pops the pending entry and
   emits a `stale` line WITH t_sent/turnaround; convert_agent's two stale
   branches now call it. Previously a stale window stayed in `_pending` and
   was double-reported as `window_lost` at close.
4. **runbook.md** — UFW is now five runnable lines (default deny incoming /
   allow outgoing / allow OpenSSH / --force enable / status verify) +
   `systemctl enable --now fail2ban`; RVC install pinned to commit
   `7b284a63…` with the why (deterministic disaster recovery; upstream moves).

### Verification

- **23/23 tests pass** — 3 new: stale-exactly-once (no `window_lost`, no
  `window` for stale seqs, turnaround present), buffer-bound disable (memory
  freed, all no-ops after), writer-failure disable (unwritable dir → `_dead`,
  no accumulation).
- Fresh mock capture cycle (convert mode, fox + typing probe): offset 340 ms
  (corr 0.981), 86/86 windows, turnaround p50/p95 77/155 ms, 0 clipped
  tails, 14/14 silences benign — analyzer reads the new meta format cleanly.
- py_compile clean.

### Files changed

`agent/capture.py`, `agent/convert_agent.py`, `agent/test_analyze.py`,
`runbook.md`, `devlog/SESSIONS.md`, `notes.md`.

### Blocked

- Replying to the CodeRabbit comments on the PR: `gh` is still not installed
  on this machine and API-credential use from the keychain is blocked by
  tool policy. Reply texts drafted in `agent/captures/PR_REPLIES.md`
  (gitignored) ready to paste.

### Task (verbatim)

> Phase 1 build — three deliverables on one branch. This is diagnostic
> infrastructure; nothing touches the real-time behavior of the pipeline
> unless capture is explicitly enabled.
>
> ── 1. CAPTURE MODE on convert_agent.py ──
> Add --capture-dir <path>. When set, each session writes a timestamped
> subdirectory containing:
>   - input_48k.wav  — mono 48k frames exactly as received from LiveKit
>     (post-AudioStream), BOTH modes. This is "what the pipeline received."
>   - output_48k.wav — frames as published back (passthrough: the passthrough
>     audio; convert: the stitched converted audio).
>   - meta.jsonl — one JSON line per event: session header (mode, RVC_WS_URL,
>     HOP/CTX/XFADE/SOLA, priming depth); per-window {seq, t_sent, t_recv,
>     turnaround_ms}; drops (with seq); underruns (with sample count);
>     stale discards; mode changes; jitter-buffer depth sampled every hop.
> CRITICAL: zero synchronous disk I/O in the frame loop — buffer in memory,
> flush via background task (aiofiles is already pinned). Capture must be
> provably inert when the flag is absent.
>
> ── 2. ANALYSIS SCRIPT agent/analyze_capture.py ──
> Takes a capture directory, produces:
>   - aligned waveform plot (input vs output, latency offset computed via
>     cross-correlation and reported in ms)
>   - spectrogram pair (this is where "chunky gibberish" becomes visible)
>   - RMS envelope overlay with utterance-tail comparison: flag any utterance
>     whose input tail energy has no corresponding output tail (the
>     word-clipping detector)
>   - dropout map: output silence regions annotated with meta.jsonl events
>     (drop/underrun markers on the timeline — starvation vs garbling)
>   - text report summarizing all of the above
> matplotlib as a new dep — add to requirements.txt (runs on the Mac; fine).
> Include a docstring documenting the test protocol: record "the quick brown
> fox jumps over the lazy dog" plus 3s of keyboard typing, in both modes.
>
> ── 3. HOUSEKEEPING ──
>   - Create agent/lk_smoke.py (portable: resolves secrets.env at repo root
>     relative to its own path; prints CONNECTED OK on success) and commit it.
>   - Create runbook.md at repo root: full disaster-recovery recipe. Sources:
>     devlog/SESSIONS.md + notes.md + these session facts that MUST appear:
>     POD: ubuntu2204/py3.10/cu118 community template (rehabc image) — NEVER
>     ubuntu2404 (RunPod runtime futex-crashes LiveKit Rust FFI; never run the
>     agent on RunPod at all). Deploy from volume koehrg7i63 (EU-RO-1),
>     /workspace mount. ALL ports at deploy time, never edit-after (edit →
>     restart → host slot lost to scheduler): HTTP 8888, TCP 22 + 8000.
>     TCP-direct is mandatory for agent↔RVC (Cloudflare proxy blocks
>     machine-to-machine WS upgrades); NAT external port CHANGES every
>     deploy — RVC_WS_URL must be refreshed. First commands: nvidia-smi;
>     apt install -y tmux (not on image). RVC venv rebuild recipe (glibc-
>     bound: pyworld compiles against image libc): uv venv --python 3.10 →
>     requirements → --no-deps git RVC → setuptools<80 → uv pip swap
>     onnxruntime→onnxruntime-gpu (.venv/bin/pip doesn't exist in uv venvs).
>     torch pin: requirements resolve cu13 > driver 12.8 → uv pip install
>     --reinstall "torch==2.8.*" "torchaudio==2.8.*" --index-url
>     https://download.pytorch.org/whl/cu128; verify torch.cuda.is_available().
>     Stateless launch (both RVC_STREAM_CONTEXT_SECONDS=0 spellings, tmux);
>     activation response MUST say "device":"cuda:0". Stop-not-Terminate
>     discipline. VPS: any real KVM VM, EU; setup = python3-venv git tmux,
>     non-root user, hand-typed secrets.env, agent venv, ufw+fail2ban;
>     GATE = lk_smoke.py CONNECTED OK before anything else. Agent launch in
>     tmux with current RVC_WS_URL.
>
> ── VERIFY ──
> Full capture→analyze cycle against the mock on this Mac: capture a spoken
> sentence + keyboard noise in both modes, run analyze_capture.py, confirm
> plots render, latency offset is sane (~375ms convert / ~0 passthrough),
> and meta events align with the timeline. Unit-test the tail-clip detector
> on synthetic data. Lint/build/typecheck no new errors. Branch → PR →
> CodeRabbit per convention. Log session per CLAUDE.md.

### What was built

- **`agent/capture.py`** (new) — `SessionCapture`: one instance per processing
  session, writing `<capture-dir>/<timestamp>/{input_48k.wav, output_48k.wav,
  meta.jsonl}`. Hot-path methods (`add_input`/`add_output`/`event`/`window_*`)
  are pure in-memory appends; ALL disk I/O (even mkdir) lives in one
  background task using aiofiles, flushing every 0.5 s. WAVs are written with
  a placeholder header patched with real sizes on close (abort-safe). Every
  meta line carries `t` (monotonic since session start) + `in_pos`/`out_pos`
  (sample positions) — the alignment keys the analyzer pins events with.
  Windows still in flight at close are recorded as `window_lost`.
- **`agent/convert_agent.py`** — `--capture-dir` flag; every hook is a single
  `if self.capture:` on a None when disabled. Events wired: session header
  (mode, RVC_WS_URL, HOP/CTX/XFADE/SOLA, prime depth), per-window
  {seq, t_sent, t_recv, turnaround_ms}, drop(seq), underrun(samples),
  stale(seq), mode_change, buffer_depth every hop (with in_flight).
  `aclose()` now awaits the cancelled process task so capture finalizes.
- **`agent/analyze_capture.py`** (new) — produces `aligned_waveforms.png`
  (min/max-decimated, offset via RMS-envelope cross-correlation),
  `spectrograms.png` (shared dB scale, output time-shifted), `rms_envelope.png`
  (utterance segmentation + tail-clip flags), `dropout_map.png` (silences
  classified **benign vs DROPOUT** by whether the aligned input was active;
  meta events pinned by out_pos), `report.txt`. Test protocol in the
  docstring (fox sentence + 3 s typing, both modes). Pure-math helpers
  (envelope/offset/utterances/tail-clips/silences/classification) have no I/O.
- **`agent/test_analyze.py`** (new) — 12 tests: offset recovery at exactly
  375 ms and 0 ms; utterance merge/blip rules; tail-clip detector — flagged
  when body survives but tail dies, NOT flagged when intact / whole-utterance
  loss (that's a dropout) / offset-shifted / beyond captured output; silence
  classification benign vs dropout; envelope values; SessionCapture end-to-end
  (valid WAVs, meta ordering, window_lost, alignment keys on every line).
- **`agent/lk_smoke.py`** (new) — portable connectivity gate: resolves
  secrets.env relative to its own path, mints its own token, `CONNECTED OK`
  + exit 0 / `FAIL` + exit 1. Identity `echo-smoke` so agents ignore it.
- **`runbook.md`** (new, repo root) — full disaster-recovery recipe (pod
  template/ports/TCP-direct/NAT-port-changes, uv venv rebuild + torch cu128
  pin, stateless launch + cuda:0 check, Stop-not-Terminate, VPS setup,
  lk_smoke gate, bring-up checklist, local mock fallback).
- Housekeeping: `captures/` gitignored; README got a capture section + a
  SUPERSEDED banner on the old "agent on the pod" RunPod runbook (agent must
  never run on RunPod); requirements.txt pins aiofiles==25.1.0 (was installed
  but unpinned) and matplotlib==3.9.4.

### Key findings / surprises

- aiofiles was claimed pinned but wasn't in requirements.txt (installed
  25.1.0 in the venv) — now actually pinned.
- A leftover mock_rvc_server.py from the morning session (system Python,
  PID 12597) was still holding port 8000; used it rather than killing it.
- Convert-mode offset measured **340 ms** by cross-correlation (vs ~375
  expected) — consistent with the jitter buffer riding slightly below 1.5
  hops that run (median depth 1.44 hops); passthrough measured exactly 0 ms,
  peak correlation 1.000.
- First-cut dropout report listed every inter-keystroke gap as a "silence
  region"; fixed by classifying output silences against the aligned input
  (benign when input silent too, DROPOUT only when audio went in and nothing
  came out).

### Files changed

New: `agent/capture.py`, `agent/analyze_capture.py`, `agent/test_analyze.py`,
`agent/lk_smoke.py`, `runbook.md`.
Modified: `agent/convert_agent.py`, `agent/requirements.txt`,
`agent/README.md`, `agent/.gitignore`, `devlog/SESSIONS.md`, `notes.md`.
Untouched: everything else (no frontend changes).

### Verification results

- Unit tests **20/20 pass** (12 new + 8 existing bridge tests).
- Full capture→analyze cycle vs the mock on LiveKit Cloud, macOS `say`
  speaking the fox sentence + 3 s synthetic keyboard transients published by
  a scripted real-time participant, one session per mode:
  - passthrough: offset **0 ms** (corr 1.000), 2 utterances, 0 clipped tails,
    all 14 silences benign, meta = header + session_end only.
  - convert: offset **340 ms** (corr 0.978), 86/86 windows returned,
    turnaround p50/p95 78/156 ms (mock is 70 ms + spikes), buffer median
    1.44 hops, 0 drops/underruns/stale, 0 clipped tails, 0 dropouts.
  - All four plots rendered and visually inspected — waveforms/spectrograms
    line up after the shift; meta events pin correctly to the timeline.
- Inertness: agent run WITHOUT the flag over the same probe — zero capture
  log lines, no directories written, stats identical (87/87 windows, 0 drops).
- `lk_smoke.py` → `CONNECTED OK`, exit 0.
- py_compile clean; eslint on the two frontend files clean; `vite build`
  clean (only the pre-existing chunk-size warning).

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
