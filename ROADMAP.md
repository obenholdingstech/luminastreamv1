# LuminaStream — Roadmap & Canon

**v2.3 · 2 August 2026**

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
| Apple enrolment | **Started 2 Aug 2026.** P6's critical path; the lead time was the risk, and it is now running down. |

**648 ms is the baseline.** All remaining latency work is optimisation *from*
that number. The VPS migration people sometimes still propose already happened.

What does **not** exist yet: video of any kind, more than one concurrent
speaker, any database, any billing, and the native app.

---

## 3. The phases

Each phase is gated on the one before it. Where a phase has a hard external
dependency with lead time, that is called out — those start early or they become
the critical path.

### P0 — Foundations ✅ *(closed 2 Aug 2026)*

Clearing the debt that would otherwise be paid at a worse time.

- ✅ Pull-based blue/green agent deploy on systemd *(#24)*
- ✅ The lens on `/`, Base44 excised — 107 files, 33 dependencies *(#25)*
- ✅ **This document**, and the doctrine below *(#26)*
- ✅ **CI hardening** *(#27)* — nothing ran on a pull request at all. Four jobs
  now do, and the first run caught a test that only passed on machines
  configured like mine.
- ✅ Owed micro-fixes *(#28)* — the rate limiter now **fails closed**, the agent
  venv floor is Python 3.10+ for a patched `aiohttp`, and shutdown has the
  regression test it never had.

### P1 — The session layer *(~1½ weeks)* ⟵ **NEXT** — **this is where audio becomes multi-user**

Today one agent serves one speaker in one fixed room. A second person is ignored
and told so. That is the single largest functional limit in the product.

- `POST /api/session/create` in the Worker: allocates a room, an identity, and an
  agent, and returns a scoped LiveKit grant.
- A Durable Object ledger — the Worker currently has **zero** storage bindings.
  This is the project's first server-side storage, but it is **not** the
  database: a Durable Object here holds coordination state — which rooms exist,
  who holds them, how many are live — that must be consistent across
  simultaneous requests.

  **Durable Object storage is genuinely durable**, and it is worth being precise
  because the opposite is easy to assume. It survives eviction and restart; the
  name is not marketing. What separates it from P4 is *purpose and lifetime*,
  not permanence: these are session records that `/api/session/create` writes
  and the session-end path deletes, so the store stays small by being cleaned
  up, not by expiring on its own. It is **not the system of record for user
  history** — nothing here should be the only copy of anything a person would
  miss. That is **P4**.

  **Cost, conditionally.** SQLite-backed Durable Objects are available on the
  Workers **Free** plan, so on Free and within its documented limits P1 adds no
  incremental Cloudflare charge. On Workers **Paid** they are metered — requests,
  duration and storage — on top of that plan's monthly minimum. Which plan this
  account is on has not been checked, so *"P1 is free"* is a claim this document
  is not entitled to make until it has been.
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

**This is the database phase.** Accounts, voice clones, reference images,
session history — the first storage whose job is to remember a person between
sessions, as opposed to P1's coordination state, which exists to keep concurrent
requests honest and is deleted when the session it describes ends. Voice cloning becomes a user-facing
flow rather than a step someone performs in a vendor dashboard.

Everything downstream waits on this: billing needs an account to charge, and the
admin system needs a person to look up.

### P5 — Billing *(~1½ weeks)*

**Monthly subscription (access) + prepaid wallet (usage).** Both enforced
**server-side and validated** — no client-side limit is ever the authority.

The 180 s / £60 caps that appear in older notes are **development** caps: a wall
against a runaway loop burning the company's card during testing. They are not
the production model. A user with a funded wallet streams as long as the wallet
covers, and the wallet is debited against metered COGS.

### P6 — The Lens *(~3–4 weeks of build, gated on Apple enrolment)*

The native macOS app. This is the product claim becoming true.

**The camera and the microphone are not one job done twice.** They are different
technologies with different install paths, different approval flows, and
different failure modes for the user. Planning them as a pair is the mistake this
section exists to prevent — and the microphone, which is a *first-class*
deliverable here because audio-only is a whole product mode, is the harder half.

**Virtual Camera — CoreMediaIO Camera Extension (`CMIOExtension`)**

- macOS **12.3+** for the API; the Xcode template and the full feature set want
  Ventura.
- Ships **inside the app bundle** at `Contents/Library/SystemExtensions`. No
  separate installer package — but "no installer" is not "no install flow".
- Activated at runtime via `OSSystemExtensionRequest.activationRequest` through
  `OSSystemExtensionManager`.
- **The container app must live in `/Applications`.** Activation fails anywhere
  else. That is a distribution constraint, not a detail — a user who runs it from
  `~/Downloads` gets a failure we have to explain.
- The user sees a **"System Extension Blocked"** alert and must approve it in
  **System Settings → Privacy & Security**. First-run onboarding has to walk them
  through this or the product simply does not appear in Zoom.
- Uninstalls when the user deletes the app from `/Applications`.
- The extension is **sandboxed** — `Process.run()` is unavailable, so anything
  the extension needs must arrive over IPC.
- **Entitlements, scoped by which target actually captures.** The *host app*
  needs `com.apple.developer.system-extension.install`, App Groups, and — because
  the host is what opens the user's real camera to feed the pipeline — camera
  permission with `NSCameraUsageDescription`. The *extension* needs App Groups
  and its own signature, and **not** camera permission: it generates frames from
  IPC rather than capturing them from hardware. Asking for a privacy permission a
  target does not use is a gratuitous scare in an install flow that is already
  asking the user for trust.

**Virtual Microphone — `AudioServerPlugIn`, and there is no second route**

This one is settled, and it is settled *against* the convenient answer.

`AudioDriverKit` would have let the microphone ship as an embedded system
extension with the same activation-and-approval flow as the camera — one install
story instead of two. **It is not available to us.** Apple's guidance is explicit
that AudioDriverKit supports *physical* audio devices only, that virtual devices
should continue to use the Audio Server plug-in model, and that **entitlements
will not be granted for virtual audio drivers**. It is not a riskier route; it is
a route that fails at the entitlement request. (Core Audio taps are also named for
loopback, which is not what we do — we inject synthesised audio as a source, not
observe existing output.)

So the microphone is an **`AudioServerPlugIn`** (CoreAudio HAL), as BlackHole,
Soundflower and BackgroundMusic all are, and it carries their install path:

- a `.driver` bundle into **`/Library/Audio/Plug-Ins/HAL`**, owned `root:wheel`
- therefore a **privileged installer package and an admin password prompt**
- and a `coreaudiod` restart
  (`sudo launchctl kickstart -kp system/com.apple.audio.coreaudiod`) before the
  device is discoverable at all

**That friction is a fixed product constraint, not an open decision.** It cannot
be engineered away, so it has to be designed for: the install flow asks for an
administrator password, and the onboarding has to earn that moment rather than
spring it. Budget design time for it in P7, not just build time here.

**The rest**

- **Audio-only mode** ships here: the microphone with no camera at all, for voice
  calls.
- A hidden `WKWebView` drives the existing pipeline, so P1–P3 are reused rather
  than reimplemented. Browser-throttling physics do not apply — this is our own
  always-foreground process, not a backgrounded tab.
- Windows (`MFCreateVirtualCamera`, user-mode COM) is designed for, post-Stage 2.

> **Hard external gate:** Apple Developer Program enrolment, Developer ID
> certificate, notarisation. Restricted entitlements fail signature validation
> without them, so nothing above can even be tested on another machine until
> enrolment completes. **It has lead time, it is a human-wall action, and it must
> start during P0 or it becomes the critical path.** The 3–4 week estimate is
> build time and excludes enrolment and notarisation latency entirely.

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

### P8 — Admin & operations *(scope to be agreed before it starts)*

Two different things wear the word "admin", they have different dependencies,
and conflating them is how an admin console becomes a six-week surprise.

**Operational visibility — earlier, and cheap.** Is the agent up? How many
sessions are live? Which box is near capacity? What did the last deploy do?
None of that needs accounts or billing, and all of it becomes necessary the
moment P1 makes more than one session possible. It rides along with P1 and P9
rather than waiting here. The agent heartbeat and status surface deferred out of
PR #24 is the first piece.

**The admin system proper — here, because it cannot exist sooner.** It reads
identity (P4) and money (P5), so it is genuinely gated on both. A business
system that cannot see who someone is or what they have paid is a dashboard, not
an admin system.

What that usually covers, offered as a starting point rather than a decision —
**scope gets agreed with the CEO before any of it is built:**

- **People:** find a user, see their sessions and their spend, suspend or
  reinstate, handle a "it stopped working" support message with evidence rather
  than guesswork.
- **Money:** wallet balances, top-ups, refunds, failed payments, and the
  subscription state that gates access at all. Every mutation attributable.
- **Truth:** COGS per session against what was charged. This is the number that
  tells you whether the business works, and nothing else in the system reports
  it.

  **The metering it reads is not P9's, and must not be.** Per-session cost is
  emitted at session end from **P2 onward** — the moment there is vendor spend
  worth attributing — and **P5 requires it anyway**, because a wallet cannot be
  debited correctly against a cost nobody recorded. P9's work is aggregating and
  reporting that stream at scale, not producing it. If the emission slipped to
  P9, P8 would depend on a phase that comes after it, which is the shape of
  dependency that gets discovered halfway through a build.
- **Safety:** an **audit log** — who did what, to whose account, when. An admin
  tool without one is a liability rather than a control, because the first time
  something is disputed there is no record of who changed it.
- **Access:** admin is not one role. "Support can read and refund" and "founder
  can change limits" are different powers, and the separation is far cheaper to
  build in than to retrofit.

Two things worth saying now rather than at the door. An admin system is the
**highest-value target in the product** — it can see everything and change
anything — so it gets the strictest auth of anything we build, and it is the one
surface where "fail closed" is not a preference. And it is real product work,
not a weekend: budget it like a feature.

### P9 — Scale & harden *(ongoing)*

Load balancing across boxes, orchestration, caching layers, and observability.

**COGS aggregation and reporting**, not COGS *emission* — the per-session cost
record is written from P2 onward and consumed by P5's wallet and P8's admin
system, both of which come first. What happens here is turning that stream into
something you can query across thousands of sessions.

Some of this lands earlier where it is cheap; the deliberate work happens here.

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
`isRateLimited` failed *open* when its binding was missing, so a deploy that
dropped the `ratelimits` block would have turned the admin-password oracle
unthrottled with nothing anywhere reporting an error. Every guard must fail
toward refusal — and a broken guard must be distinguishable in the logs from a
guard doing its job, which is why a missing binding answers 503 and a real
throttle answers 429. *(31 Jul, fixed in #28)*

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
| `DECART_API_KEY` via `wrangler secret put` | **Only after** the P2 spend wall is merged and verified. |
| Confirm Decart's billing basis | Specifically: what "per second of active generation" meters. |
| Agree the **P8 admin scope** | Not yet — at the door. Listed there as a starting point, not a decision. |
| Confirm the **Cloudflare Workers plan** | Free vs Paid decides whether P1's Durable Object is free or metered. See P1. |

---

## 7. How to read this document

Phases are ordered by dependency, not by preference — P1 before P2 because
per-session rooms are what make a second user possible at all, and video without
that is a demo. Time estimates are working estimates, not commitments.

When this document and the code disagree, **the code is right and this document
is a bug**. Fix it in the same PR that caused the drift.
