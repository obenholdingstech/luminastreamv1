# LuminaStream — Roadmap & Canon

**v2.2 · 1 August 2026**

This is the canonical description of what LuminaStream is, what state it is in,
and what order the remaining work happens in. It exists because the previous
version of this document lived only in a chat window and was lost when that
window closed — taking a 27-entry doctrine list with it. Nothing load-bearing
lives in chat any more.

---

## 1. The canon

> **LuminaStream is a lens, not a venue.** It is identity infrastructure: a user
> installs the app, uploads a reference image and a voice sample, presses Start —
> and LuminaStream presents itself to the operating system as a **Virtual Camera
> and Virtual Microphone**. The user then opens WhatsApp, Zoom, TikTok Live,
> Discord — any app — selects LuminaStream as their camera and mic, and the
> third-party platform receives the transformed person: avatar face, cloned
> voice, lip-synced. Viewers live on the other platforms and never know
> LuminaStream exists.

Four consequences follow, and they are the reason this paragraph is at the top:

1. **The native desktop app is on the MVP path**, not behind it. A browser tab
   cannot register a camera with the operating system.
2. **The Virtual Microphone is a first-class deliverable**, not a companion to
   the camera. Audio-only *is* a whole product mode — selecting the LuminaStream
   mic for a WhatsApp voice call, with no video anywhere.
3. **The browser app is the workshop and the demo stage.** `/` is the lens
   surface and `/livekit-test` is the instrument. Both are permanently valuable.
   Neither is the product.
4. **Mobile web is viewers-only.** Background tabs get throttled by the OS; a
   real-time capture pipeline cannot live there. Mobile arrives as native or not
   at all.

---

## 2. Where we actually are

Stage 1 — the voice engine — is **done and running in production**.

| | |
|---|---|
| Engine | ElevenLabs Scribe v2 Realtime (STT) → ElevenLabs TTS, over LiveKit Cloud |
| Runtime | Python agent on a Verpex VPS, systemd user service, pull-based self-deploy |
| Latency | **p50 648 ms** end-to-end, measured on VPS topology 29 Jul 2026 |
| Quality | CEO scorecard **8.7 overall** — clean 8, latency-feel 8.3, "is it ME?" 8.5 |
| Frontend | Cloudflare Pages (`studio.luminastream.live`) + Worker (`luminastream-api`) |
| Verified | CEO ran the lens against the live agent, 1 Aug 2026 — it works |

**648 ms is the baseline.** All remaining latency work is optimisation *from*
that number. The VPS migration people sometimes still propose already happened.

What does **not** exist yet: video of any kind, more than one concurrent
speaker, any database, any billing, and the native app.

---

## 3. The phases

Each phase is gated on the one before it. Where a phase has a hard external
dependency with lead time, that is called out — those start early or they become
the critical path.

### P0 — Foundations *(in progress, ~1 week)*

Clearing the debt that would otherwise be paid at a worse time.

- ✅ Pull-based blue/green agent deploy on systemd *(#24)*
- ✅ The lens on `/`, Base44 excised — 107 files, 33 dependencies *(#25)*
- ⬜ **This document**, and the doctrine below
- ⬜ **CI hardening.** The deploy workflow currently runs **no tests and no
  lint**. Nine rounds of external review on #25 found twenty-five issues that a
  pipeline should have been the first to see.
- ⬜ Owed micro-fixes: Mac venv → Python 3.10+, agent SIGINT exit code, and the
  **fail-open rate limiter** at `workers/api/src/index.js:47`.

### P1 — The session layer *(~1½ weeks)* — **this is where audio becomes multi-user**

Today one agent serves one speaker in one fixed room. A second person is ignored
and told so. That is the single largest functional limit in the product.

- `POST /api/session/create` in the Worker: allocates a room, an identity, and an
  agent, and returns a scoped LiveKit grant.
- A Durable Object ledger — the Worker currently has **zero** storage bindings.
- Agent-per-session on the VPS, supervised, with a measured **capacity constant**
  (concurrent rooms per box — never yet measured; each agent loads its own Silero
  ONNX model, which dominates per-session memory).
- Rate limiting and caching on every new endpoint.
- Retires: the shared `luminastream-test` room, the `agent_busy` state, and the
  admin-password gate on the lens.

### P2 — Video *(~1 week)*

Decart Lucy 2.5 in the browser studio, spend-walled.

- **The wall merges before the key exists.** A `SpendLedger` Durable Object,
  server-side and authoritative, because Decart connects browser↔vendor directly.
- Two-layer control, mirroring the audio governor exactly: a console-adjustable
  session cap clamped by an **env-only ceiling the client can never breach**.
- Verified pricing: **$0.02/sec at 720p** ($1.20/min).
- The raw vendor key never reaches the browser. The dead Base44 backend did
  exactly that, and it is the named anti-pattern.

### P3 — A/V sync *(~1 week)*

**Audio is the master clock.** Video buffers to match audio; audio never waits.

- Build the offset meter **first**, then tune what the numbers convict.
- The buffer must be **elastic**, subscribing to the agent's live per-utterance
  tail latency. p95 near 1900 ms in free conversation is *structural* — synthesised
  speech takes about as long to play as it took to say, so continuous talking
  accumulates a backlog that drains at pauses. A fixed delay either desyncs under
  load or adds permanent latency.

### P4 — Identity & persistence *(~1½ weeks)*

Accounts, voice clones, reference images, session history. The first real
database. Voice cloning becomes a user-facing flow rather than a dashboard step.

### P5 — Billing *(~1½ weeks)*

**Monthly subscription (access) + prepaid wallet (usage).** Both enforced
**server-side and validated** — no client-side limit is ever the authority.

The 180 s / £60 caps that appear in older notes are **development** caps: a wall
against a runaway loop burning the company's card during testing. They are not
the production model. A user with a funded wallet streams as long as the wallet
covers, and the wallet is debited against metered COGS.

### P6 — The Lens *(~3 weeks, gated on Apple enrolment)*

The native macOS app. This is the product claim becoming true.

- **Virtual Camera:** CoreMediaIO Camera Extension (ExtensionKit) — embedded in
  the app bundle, no installer, no reboot.
- **Virtual Microphone:** an **AudioServerPlugIn** (CoreAudio HAL) — a different
  technology from the camera, and Apple's explicit guidance for purely virtual
  audio devices. Precedents: BlackHole, Soundflower, BackgroundMusic.
- **Audio-only mode** ships here: the mic without the camera, for voice calls.
- A hidden `WKWebView` drives the existing pipeline, so P1–P3 are reused rather
  than reimplemented. Browser-throttling physics do not apply — this is our own
  always-foreground process.
- Windows (`MFCreateVirtualCamera`, user-mode COM) is designed for, post-Stage 2.

> **Hard external gate:** Apple Developer Program enrolment, Developer ID
> certificate, notarisation. Restricted entitlements fail signature validation
> without them. **Enrolment has lead time and is a human-wall action — it must
> start during P0 or it becomes the critical path.**

### P7 — Design & experience *(a dedicated session, CEO-requested)*

**Not polish squeezed between features — its own session, with its own brief.**

The current UI is functional and honest but generic. It also has real system
debt: the same hex values are hardcoded across files, all four `--font-*` tokens
fall back to system stacks, and `framer-motion` is now used in exactly one place.

The session covers: a real design system (tokens, type scale, actual typefaces),
motion used deliberately for state rather than decoration, and an end-to-end
experience pass on the flows a person actually walks through. Scheduled once the
product surface stops moving — which is after P1, because the session layer
changes what the lens page even shows.

### P8 — Scale & harden *(ongoing)*

Load balancing across boxes, orchestration, caching layers, observability, an
agent heartbeat and status surface, and per-session COGS metering. Some of this
lands earlier where it is cheap; the deliberate work happens here.

---

## 4. Doctrine

The previous roadmap's §5 held **27 entries**. It is gone — it lived in a chat
window, and no copy exists on any branch or in any commit.

**What follows is not that list.** It is a fresh reconstruction, earned from the
same source the original was earned from: the failure narratives in
`devlog/SESSIONS.md`. Every rule cites the session that paid for it. Where the
original said something these do not, that knowledge is lost, and pretending
otherwise would repeat the exact mistake that produced the loss.

### On evidence

**1. Absent record ≠ absent event.**
A missing log entry is not proof that nothing happened. Reading `notes.md` plus an
empty `devlog/`, a CTO reported that the engine had never run on the VPS and
proposed the migration as the biggest unclaimed win. It had run nine days
earlier and scored 8.7. *(31 Jul — "the record had a hole in it")*

**2. CEO-run drills are logged the same day.**
Chat is not a system of record. The 29 Jul drill lived only in a chat window,
which is exactly how rule 1 got broken. *(31 Jul)*

**3. Never invent numbers into a permanent record.**
When ear-drill scores were asked for and had never been taken, the commit
recorded the verdict actually given plus the measured evidence, and stated
explicitly that the scores were unrecorded. *(28 Jul — graduation)*

**4. Instrument before tuning.**
`optimize_streaming_latency` 0→4 moved nothing; the real first-utterance penalty
was aiohttp's connection pool being reaped between keepalives. Measurement found
it; reasoning about the documented knob would not have. *(28 Jul — optimisation)*

**5. A tool lies outside its assumptions.**
The capture analyser's "clipped tails" and "converter garbled" verdicts assume
the output is a time-shifted copy of the input. A re-synthesis in a different
voice is not, and both metrics were nearly cited as evidence for a conclusion
they could not support. *(28 Jul)*

**6. Verify the invocation before believing the verdict.**
`npx vitest run` reporting "8 failed, no tests" looked like a merge regression.
The runner is `node --test`. *(28 Jul)*

**7. A verification run in the wrong directory is void, not passed.**
A `cd agent` that failed because the shell was already there meant a
neutralisation never ran; the green result was meaningless and was redone.
*(27 Jul)*

**8. Screenshot it.**
A knob-grid collision was assumed to be label overflow and "fixed" twice. The
screenshot showed sliders rendering as dots — a container/viewport mismatch.
*(30 Jul)* The same session that wrote this rule shipped a status line at
`opacity: 0`, found only by rendering the page. *(1 Aug)*

### On tests

**9. A test that cannot fail is worse than no test.**
It manufactures exactly the confidence you should not have. Break the fix,
confirm the right test goes red, and report the mutation. *(27 Jul — the config
lock, proved by replacing it with `if True:`)*

**10. Six ways a test passes over something broken.**
All six were found in this project's own tests, most in a single PR: aging a
record to simulate an event that does not age it; committing inside the
repository under test; claiming coverage for a path the suite never reaches; a
matcher that also matches the failure case; data where the correct and broken
behaviours coincide; and hanging instead of failing. *(31 Jul – 1 Aug, #24/#25)*

**11. A test that fails for the wrong reason sends the next person to the wrong
file.** An unguarded `indexOf` returning −1 made a renamed field report as a
deleted one. *(1 Aug, #25)*

### On the machine

**12. `git pull` before `pip install`, always.**
`pip` alone is a silent no-op that once produced a fully green drill on stale
code. *(VPS doctrine)*

**13. `./.venv/bin/python -m pip`, never `.venv/bin/pip`.**
The `pip` shim is a `#!/bin/sh` trampoline holding an absolute path; a moved or
copied repo makes it install into a different site-packages entirely. *(27 Jul — "the venv trap")*

**14. Never mutate a venv a live process is using.**
A half-written package only explodes on a later lazy import, which looks like a
working service with a landmine in it. Build a new one, prove it, swap the
symlink. *(31 Jul, #24)*

**15. Transitive dependencies are invisible until a fresh machine.**
`aiohttp` was imported directly and never declared, arriving via `livekit-api`.
`aiofiles` was claimed pinned and was not. Both would have failed first on a new
VPS venv. *(28 Jul, 27 Jul)*

**16. Prove the new build before touching the running one.**
And prove it somewhere it cannot collide — a preflight that joins the live room
under the live identity evicts the agent it was meant to protect. *(31 Jul, #24)*

**17. A crash loop against a metered vendor is a spend leak, not just noise.**
Every agent start fires a real synthesis and the governor is per-process, so a
hundred restarts is a hundred fresh budgets. *(31 Jul, #24)*

### On the product

**18. The agent is the source of truth.**
Render what the agent has **confirmed**, never what the user requested. When
they differ, show both. A control that reports its own optimism is a bug.
*(27 Jul — Phase 4 console; re-earned across `/` in #25)*

**19. Clamp, never crash.**
An out-of-range value is adjusted and reported as adjusted; an unsupported one
is rejected with a reason. Neither takes the session down. *(27 Jul)*

**20. Say the silence out loud.**
A pipeline producing nothing must explain itself. An ignored second speaker
hearing silence reads as a broken product; the agent broadcasts `agent_busy` and
the UI ranks it above "live". *(31 Jul, #23)*

**21. Never truncate an utterance to save money.**
Spend is reserved per hop *before* each send, and a mid-utterance refusal
abandons the whole utterance — no commit, no transcript, no audio. Video is the
exception: a wall-clock hard stop is correct there, with a visible reason.
*(28 Jul — governor rework)*

**22. Two-layer spend control, and the ceiling defaults to the cap.**
A console-adjustable cap walled by an env-only ceiling. Defaulting the ceiling to
the starting cap means an un-overridden environment can only ever spend *less*.
A malformed override is fatal, never a silent default. *(30 Jul)*

**23. Audio is the pacing leg.**
Video can be buffered to match audio; never the reverse. Any sync budget must be
elastic, not fixed. *(structural, carried forward)*

**24. Present both, when only an ear can judge.**
A 100 ms hangover hit the latency target with identical drill transcripts — but
the drill's lines are separated by 1.6 s of silence while real speech pauses
mid-sentence. The drill could not see the tradeoff it appeared to settle. *(28 Jul)*

### On safety

**25. The browser never holds a vendor key.**
The dead Base44 `createSession` returned the raw Decart account key to the
client. Named permanently as the anti-pattern. *(31 Jul)*

**26. Fail closed.**
`isRateLimited` fails *open* when its binding is missing — so a deploy that drops
the `ratelimits` block turns the admin-password oracle unthrottled, and nothing
errors. Every guard must fail toward refusal. *(31 Jul, owed in P0)*

**27. A check whose precondition failed has not passed.**
The pre-merge parentage check ran `git log main..HEAD` against a possibly stale
local `main`, so the one check meant to catch a mis-parented branch failed open.
Chain preconditions with `&&` so they fail closed. *(31 Jul, #22)*

**28. The public repo carries no infrastructure literals.**
No VPS host, no port map, no LiveKit project subdomain. Placeholders pointing at
where the real value lives, always. *(31 Jul)*

**29. One PR at a time, branched off freshly-synced `main`.**
Branching off an unmerged branch puts the parent's commits inside the child's
diff, and the reviewer cannot tell the two changes apart. *(31 Jul)*

---

## 5. Human-only walls

Three things stay in the CEO's hands, and no automation reaches them:

1. **Credential minting and scoping.**
2. **DNS and custom domains.**
3. **Spend-authority keys** — `DECART_API_KEY`, `ELEVENLABS_API_KEY`.

Claude has **no SSH to the VPS by design**, because the box holds secrets. Every
command on it is executed by the CEO; Claude's job is to guide and to verify the
pasted output.

## 6. Open CEO actions

| | Why it matters |
|---|---|
| Start **Apple Developer Program** enrolment | P6's critical path. Lead time is the risk, not the paperwork. |
| `DECART_API_KEY` via `wrangler secret put` | **Only after** the P2 spend wall is merged and verified. |
| Confirm Decart's billing basis | Specifically: what "per second of active generation" meters. |

---

## 7. How to read this document

Phases are ordered by dependency, not by preference — P1 before P2 because
per-session rooms are what make a second user possible at all, and video without
that is a demo. Time estimates are working estimates, not commitments.

When this document and the code disagree, **the code is right and this document
is a bug**. Fix it in the same PR that caused the drift.
