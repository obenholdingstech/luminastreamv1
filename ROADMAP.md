# LuminaStream — Roadmap & Canon

**v2.6 · 6 August 2026**

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

Stage 1 — the voice engine — is **done and running in production**. On top of
it, the session layer (P1), video (P2), and A/V sync & fidelity (P3) have all
shipped: the browser lens at `/` runs the full transformed person — avatar face
through Decart Lucy 2.5, cloned voice, upscaled to 1080p, dual-mode
lip-sync — spend-walled end to end. The CEO scored the overall live experience
**8.5/10 on 4 Aug 2026 and locked it in**.

| | |
|---|---|
| Engine | ElevenLabs Scribe v2 Realtime (STT) → ElevenLabs TTS, over LiveKit Cloud |
| Runtime | Python agent on a Verpex VPS, systemd user service, pull-based self-deploy |
| Latency | **p50 648 ms** end-to-end, measured on VPS topology 29 Jul 2026 |
| Quality | CEO scorecard **8.7 overall** — clean 8, latency-feel 8.3, "is it ME?" 8.5 |
| Frontend | Cloudflare Pages (`studio.luminastream.live`) + Worker (`luminastream-api`) |
| Verified | CEO ran the lens against the live agent, 1 Aug 2026 — it works |
| Video | Decart Lucy 2.5, white-label topology (Worker control plane, direct media), `SpendLedger`-walled, **3 DO requests per session of any length** |
| Fidelity | Lucy's fixed 720p upscaled client-side to **1080p** (Catmull-Rom + CAS, WebGL2); readout claims only what it delivers |
| Sync | Measured at the ear (mouth→ear meter); dual-mode alignment — the laggard is the master clock; drill-calibrated with a live trim knob |
| Score | **8.5/10 overall, CEO, 4 Aug 2026 — locked in** (voice drill 9/10 on 3 Aug; clarity 8.4 and sync 6.6 mid-arc, then the 6.6 was decoded and rebuilt) |
| Apple enrolment | **Started 2 Aug 2026.** P6's critical path; the lead time was the risk, and it is now running down. |
| Cloudflare plan | **Workers Free** (2 Aug 2026), which includes SQLite-backed Durable Objects within daily quotas. P1's **O(1) invariant** protects both: on Free it keeps us under a quota whose breach *fails operations*, and on Paid it keeps cost proportional to sessions **served** rather than to hours **streamed**. It does not make usage free — cost still grows with session count, and both quotas can still be exceeded at volume. |

**648 ms is the baseline.** All remaining latency work is optimisation *from*
that number. The VPS migration people sometimes still propose already happened.

What does **not** exist yet: any database, any billing, and the native app.
Concurrency exists but is small: pool of two rooms, held ≤ 6 until the
concurrent-CPU drill. Frame synthesis EXISTS and is locked: adaptive tiers at
a 30fps target (see P3).

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

### P1 — The session layer — **CLOSED 2 Aug 2026** *(planned ~1½ weeks; done in one day — see devlog for what that cost)* — **audio became multi-user here**

Today one agent serves one speaker in one fixed room. A second person is ignored
and told so. That is the single largest functional limit in the product.

P1 ships in three parts. **P1a is done** (PR #32): `POST /api/session/create`,
`/api/session/end`, `/api/session/capacity`, the `SessionRegistry` Durable
Object, and the O(1) oracle below. **P1b** wires the lens to it and retires the
admin-password gate. **P1c** puts an agent behind each session on the VPS and
measures the capacity constant.

- `POST /api/session/create` in the Worker: allocates a room, an identity, and an
  agent, and returns a scoped LiveKit grant. **Shipped in P1a**; the agent half
  landed with P1c on 2 Aug 2026 — two agents (systemd template
  `lumina-agent@<room>`), pool of two rooms, capacity **2**.
- A Durable Object ledger — the Worker previously had **zero** storage bindings.
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

  **Cost.** The account is on Workers **Free** (CEO, 2 Aug 2026), where
  SQLite-backed Durable Objects are included — **within daily quotas of 100,000
  DO requests and 13,000 GB-s, reset at 00:00 UTC.** Exceeding either does not
  produce a bill; **further operations of that type fail with an error**. On the
  free tier, a wasteful DO is an availability problem before it is ever a cost
  problem.

#### The O(1) invariant — a P1 requirement

**DO requests per session must be a constant, independent of how long the
session lasts.** Never O(session duration).

Written here, before the code, because the DO's *shape* is the expensive thing
to change later — not its implementation. Raised by the CEO on 2 Aug 2026 as a
future paid-plan cost risk. It is that — but the arithmetic says it bites on the
plan we are on **today**, and harder: on Free the failure mode is refused
operations, not an invoice. The invariant protects both plans, which is why it
is a requirement now rather than a migration task later.

A DO is billed for its allocated **128 MB** whenever awake, and hibernates after
**10 s** with no request or event. That single fact drives everything below.

**On Workers Free — where we are now.** 13,000 GB-s/day is 28.9 awake-hours/day.

| Design | Per session | Sessions/day before operations start failing |
|---|---|---|
| Browser polls the DO once a second | 1800 req, 1800 s awake | **55** |
| Create + capacity read + end | 3 req, ~30 ms **billable** | **33,333** |

**Fifty-five against thirty-three thousand.** For polling, the request quota
binds first (100,000 ÷ 1800 = 55.5, floored — a partial session is not a
session); duration would allow 57. For the O(1) design, requests bind at 33,333
and duration allows millions.

The asymmetry comes from *what is actually billable*. **A DO eligible for
hibernation accrues no duration charge at all** — not even during the ten
seconds before the runtime hibernates it. So an O(1) session bills only its
active execution: three requests of single-digit-to-tens of milliseconds. A
polled session bills 128 MB of continuous wall clock, because it never becomes
eligible.

And the consequence on Free is not a surprising invoice. It is a product that
**stops creating sessions**, at a scale we would pass in the first week of
having real users.

**On Workers Paid — where we are going.** Requests $0.15/M (1M included),
duration $12.50/M GB-s (400,000 included). At 100,000 sessions/month of 30
minutes:

| Design | Requests | GB-s | Incremental DO charge |
|---|---|---|---|
| Polling once a second | 180,000,000 | 22,500,000 | **~$303** |
| Create + capacity read + end | 300,000 | **~375** | **$0** |

That column is **incremental Durable Object usage only**. Workers Paid carries a
**$5/month minimum** either way; the difference between the rows is what the
coordination layer adds on top of it.

~375 GB-s is three requests × ~10 ms of active execution × 128 MB × 100,000
sessions. Only active time counts, because a hibernation-eligible object is not
billed for the window before it hibernates.

The conclusion is robust to that estimate being wrong. Even under the
deliberately pessimistic reading — every request somehow holding the object
awake for a full 10-second window, none overlapping — it comes to 375,000 GB-s,
which is *still* inside the 400,000 included. Three orders of magnitude of
modelling error, same answer.

**Duration is ~90% of the paid-plan bill, not requests.** A DO polled every
second never reaches the 10-second threshold, so it bills 128 MB of wall clock
for the entire session — which makes cost track **how long people stream**,
precisely the axis this product intends to grow along. The lesson is not "don't
call it too much". It is **"don't keep it awake"**.

Five rules follow, all cheap now and all expensive to retrofit:

1. **No polling.** The browser is told its room once, at create. Everything after
   — agent ready, mode confirmed, session ending — travels over the LiveKit data
   channel we already pay for and which is the right transport for it anyway.
2. **No heartbeats through the DO.** Agent liveness is not the DO's business.
   Routing a 10-second health check through it converts liveness monitoring into
   a permanently-awake object.
3. **No non-hibernating WebSocket to the DO.** A standard WebSocket bills
   duration for its entire connected life. The **Hibernation API** is the only
   acceptable form, and Cloudflare's own worked example takes a case from $138.65
   to $10.00.
4. **No `setTimeout`/`setInterval` inside a DO.** The subtle one: a pending timer
   makes the object **ineligible for hibernation altogether**, so a single stray
   line silently bills full wall clock with no other symptom. Deferred work uses
   `alarm()`.
5. **The reaper alarm is demand-driven, never fixed-interval.** A reaper that
   wakes every N minutes while any session is open makes alarm invocations —
   which bill as requests — scale with session duration, **breaking the very
   invariant this section exists to state**. Instead the DO keeps **one** alarm,
   always set to the *earliest pending expiry*; on wake it reaps what expired and
   re-arms to the next one, or to nothing. A session that ends cleanly costs zero
   alarm wakeups; an abandoned one costs **at most one** — no matter how far
   into its lease it was abandoned, and no matter how long the registry then
   sits idle before anything touches it again.

   *At most*, not *exactly*: **one wakeup reaps everything that has expired**, so
   abandoned sessions sharing an expiry instant cost one alarm between them
   rather than one each. The bound is the number of **distinct pending
   expiries** — at most one per session, and often exactly that, since a lease
   runs from creation and sessions started at different moments expire at
   different moments. The saving applies only when creates coincide.

   The half that carries the invariant is the other one: **the bound does not
   grow with elapsed time.** Alarm count is bounded by how many sessions were
   abandoned, never by how long anything ran or how long the registry then sat
   idle. "Exactly one" is what the isolated single-session oracle row asserts —
   the tightest case, not the general rule.

   (A session cannot be abandoned "after a day" either: it cannot outlive its
   lease. What can run for a day is the *silence afterwards*, and that silence is
   precisely what a fixed-interval reaper would charge for.)

#### The test oracle

"Constant" is not a test. P1 ships `SessionRegistry` with a lifecycle test that
counts **every `fetch()` into the DO stub plus every `alarm()` invocation**, and
asserts:

| Case | Budget |
|---|---|
| Clean session: create → capacity read → end | **≤ 3** requests, **0** alarms |
| Abandoned session: create → reaped | **≤ 2** requests, **exactly 1** alarm |
| **Short vs long session** | counts **identical** — a 30-second and a full-lease session must cost the same |
| N concurrent sessions | **≤ N × budget** — linear in sessions is expected and fine |

**What "long" means, precisely.** A session cannot outlive its **lease**
(`SESSION_LEASE_SECONDS`, 2h by default), because the LiveKit grant is minted
for exactly that span — slot and credential expire together, which is what
removes the need for a heartbeat. So the shipped guarantee is not "duration is
free forever"; it is **no request is made as a function of elapsed time within a
lease**, and a lease is hours, not seconds. Supporting longer sessions later
means renewal, which is O(duration ÷ 2h) — bounded, and emphatically not
O(seconds). Stated here rather than left implied, because an invariant with an
unstated boundary is one someone will later find out about the hard way.

The rows do different jobs, and it matters which. The first two **bound the
constant** — a poll heavy enough to push past 3 requests trips them. The third
is the **duration-scaling detector**, and it is the one that survives a poll
being added *within* the budget: a request that fires twice in a short session
and two hundred times in a long one keeps every per-case count plausible while
breaking the invariant outright. Only comparing a short session against a long
one convicts that.

Discrimination-tested like everything else: adding a poll to the session path,
or converting the reaper to a fixed interval, must turn that row red.

**Shipped, and it does** (PR #32, `workers/api/test/sessionOracle.test.js`).
Two mutations were run against the suite. **A**: a capacity read added to the
create path — an extra request per session. **B**: `#rearm` converted to a fixed
60-second sweep — wakeups that scale with duration.

| Row | A: extra request | B: fixed sweep |
|---|---|---|
| 1 · Clean (≤ 3 req, 0 alarms) | **red** | green |
| 2 · Abandoned (≤ 2 req, 1 alarm) | green | **red** |
| 3 · Short vs long | **red** | **red** |
| 4 · N concurrent | **red** | green |

Rows 1, 2 and 4 each have a blind spot. Row 1 never advances the clock far
enough to wake a fixed-interval reaper. Row 2 makes only one request, so its
≤ 2 budget absorbs an extra one without complaint. Row 4 shares row 1's
blindness. **Row 3 is the only row red under both** — which is what earns it its
place, and it is not the claim an earlier draft of this section made (that row 3
alone convicted the sweep; row 2 convicted it too).

The two assertions inside row 3 also do different jobs, and the mutations
separate them cleanly. Under **A** it fails on the absolute pin
(`requests === 3`): both sessions gain the same extra request, so the comparison
stays equal and sees nothing. Under **B** it fails on the `deepEqual` comparison
itself. The pin bounds the constant; the comparison is the duration detector.
Neither is redundant, and only the comparison catches cost that tracks elapsed
time.

- Agent-per-room on the VPS, supervised — **done 2 Aug 2026**: systemd template
  unit `lumina-agent@<room>`, deploys restart and health-gate every instance,
  pool of two rooms live. And the **capacity constant, measured for the first
  time** (7.8 GiB / 4-core box): **~350 MiB RSS per agent** (325–338 MiB
  observed, Silero dominating), ~3 % lifetime-average CPU each ⇒ **⌊6963/350⌋ =
  19 agents RAM-bound**. Caveat recorded, not glossed: `ps %cpu` is a lifetime
  average, so CPU under several *simultaneous conversations* is unmeasured —
  **hold the pool at ≤ 6** until that is measured with `top` during a
  two-conversation drill. Floored, never rounded.
- Rate limiting and caching on every new endpoint.
- Retires: the shared `luminastream-test` room, the `agent_busy` state, and the
  admin-password gate on the lens.

### P2 — Video ✅ *(closed 3 Aug 2026 — planned ~1 week, done in two days)*

Decart Lucy 2.5 in the browser studio, spend-walled. **Shipped in full**, in
the order this section demanded — the wall merged before the key existed:

- **P2a** — the `SpendLedger` DO live and production-drilled before any vendor
  key existed (#43): reserve→settle, debit-on-reserve, dev ceilings
  180 s / 3000 s, five money mutations each convicting its guard.
- **P2b** — the probe verdict (#46): `maxSessionDuration` is **enforced at
  runtime against generation** — wall #2 is real, browser-direct topology
  confirmed. First metered vendor spend: $0.60, through our own ledger.
- **P2c** — the white-label topology implemented: Worker control plane with the
  raw key never leaving the server, stateless session control (ICE/prompts cost
  zero DO requests), vendor-truth settle, the executioner alarm with bounded
  retries. 3 DO requests per video session, any length, verified in production.
- **P2d** — video in the lens (#49), behind the composable frame pipeline
  (receive → align → upscale → present) that made P3 a slot-fill, not a
  retrofit.
- Then the product on top: reference avatar + live restyle prompt + voice
  dropdown (#50–52), the blank-render root cause found and fixed with a render
  probe that bills 0 s (#55–57), Clean View (#58), and the one-button unified
  lens with cinematic mode (#60).

The design text below is retained as built — it is now description, not plan.

**The `SpendLedger` is the prepaid wallet enforcer from day one, temporarily
wearing dev-cap clothes** (CEO, 3 Aug 2026). LuminaStream's business model is
strictly prepaid: a funded wallet dictates stream time, margins baked into
credit pricing, plus a subscription tier (see P5). Today the ledger enforces
development caps against a runaway loop; later the same object, same code
paths, enforces user wallets. Every design decision must therefore survive
contact with real money — nothing here is throwaway.

- **The wall merges before the key exists.** A `SpendLedger` Durable Object,
  server-side and authoritative, because Decart connects browser↔vendor directly.
- **Spoof-proof by construction:** the client is never the authority on what
  was spent. Grants are minted server-side against the ledger balance; a
  zero-balance ledger refuses the grant; no request the browser can make
  increases what it is allowed to burn.
- **The ledger obeys the O(1) invariant** (§P1) — a meter that ticks once per
  second of video is a Durable Object awake for the whole stream, breaking the
  very cost rule this project measured. Design: **reserve → settle**. One
  request reserves a bounded window (≤ session cap, ≤ remaining total); one
  request settles actual usage at session end. Two DO requests per video
  session, independent of its length.
- **The reservation lifecycle is idempotent and self-cleaning.** Reservation
  ids are server-generated; reserve and settle are idempotent transitions
  (a retried settle is a no-op, a settle can never exceed its reserve, a
  guessed id buys nothing — the settle credential is random and hashed at
  rest). A reservation debits the balance ON RESERVE; an unsettled one is
  reclaimed by a **demand-driven alarm at the earliest expiry** (the registry's
  reaper pattern, same O(1) discipline), resolving **conservatively as fully
  spent** — dev caps protect the company's card, and in wallet mode a
  too-cautious hold is correctable against vendor-reported usage at P5
  reconciliation (support path via P8), while a too-generous release is money
  gone. Abandonment can therefore never wedge the ledger into false
  zero-balance: expired holds resolve, they do not linger.
- **Vendor-token honesty** (verified against Decart's docs, 3 Aug): short-lived
  client tokens support origin/model restriction and `maxSessionDuration`, but
  **token expiry does not terminate an already-running session**, and one-use
  binding is not documented. So the enforcement chain is: each token is minted
  **bound to exactly one reservation** (duplicate or concurrent issuance for
  the same reservation refused, atomically, in the ledger); `maxSessionDuration`
  is set from the granted seconds **if P2's verify-before-code step confirms it
  caps a running session**; the client-side hard stop is UX, never authority.
  **If verification shows a running session can outlive every server-side
  bound, video authorization moves behind the Worker (proxy), and the
  browser-direct path is abandoned** — the wall does not get weakened to fit
  the vendor; the topology changes instead.
- Two-layer control, mirroring the audio governor exactly: a console-adjustable
  session cap clamped by an **env-only ceiling the client can never breach**;
  malformed configuration is fatal, never a silent default.
- Dev ceilings: `MAX_VIDEO_SECONDS_PER_SESSION=180`,
  `MAX_VIDEO_SECONDS_TOTAL=3000` (~$60 at verified pricing).
- Verified pricing: **$0.02/sec at 720p** ($1.20/min).
- The raw vendor key never reaches the browser. The dead Base44 backend did
  exactly that, and it is the named anti-pattern.
- For video, a wall-clock hard stop **is** correct behaviour (unlike TTS, where
  an utterance is never truncated): stop cleanly with a visible reason, never a
  silent freeze.

#### The committed topology *(verified against Decart's docs and CEO-approved, 3 Aug 2026)*

**Control plane through the Worker; media plane direct.** Decart's white-label
signaling path: our Worker creates and controls every session with the real
key — which therefore never leaves the server in ANY form, not even ephemeral
— while WebRTC media flows browser↔Decart directly ("media quality identical",
control-only latency).

**Status: implemented and live** (P2c, 3 Aug 2026). The three consequences
below are built, each closing a previously-flagged hole:

1. **The ledger's reaper becomes the executioner** *(P2c)* — **server-
   authoritative, vendor-executed**, and honest about the difference: the
   Worker orders the kill, but only Decart can sever a direct media stream,
   so a failed DELETE means media may keep flowing until a backstop bites.
   Mechanics: reservations gain the Decart session id; the expiry alarm
   issues an idempotent DELETE with a timeout and **bounded retries** (a
   small constant R, each via alarm re-arm — so an overrun costs **at most
   1+R alarms**, a constant, never a function of anything). If all retries
   fail: the overrun is flagged for reconciliation, and exposure is BOUNDED
   by the remaining walls — the token's `maxSessionDuration` (wall #2, the
   probe calibrates it) and Decart's own inactivity/timeout auto-end. P2c
   ships the bounded-exposure arithmetic alongside the code.

   **The orphan seam, named:** Decart's create succeeds, and OUR write of the
   session id fails — a live media session no alarm can name. P2c's required
   ordering: mark the reservation `pending-create` durably **before** calling
   Decart; write the id **before** the event token is released to the
   browser; on a failed id-write, issue a **compensating DELETE immediately**
   with the id still in hand. If even that fails, the expired `pending-create`
   marker makes the orphan *visible* (the alarm flags what it cannot kill),
   and a quota cross-check (`GET /v1/realtime/quota` showing more live vendor
   sessions than id-bearing reservations) alerts on anything that slipped
   every net. Exposure stays bounded by wall #2 and vendor auto-end; the
   orphan can be silent about its bill, never about its existence.
2. **Settle becomes vendor-truth** *(P2c)* — with the trust boundary explicit:
   **the billing summary is only ever read by the Worker from Decart's own
   response** (the Worker issues the DELETE, the summary arrives in that
   server-to-server exchange). No browser-submitted `billingSummary`, usage
   count, or raw-vendor field is EVER an accounting input — a client that
   could report its own bill would report a small one. The browser may at most
   say "end session X"; the Worker verifies X belongs to that session's
   reservation, performs the vendor call itself, and accounts from what the
   vendor returned. Client-reported usage survives only in dev-cap mode, as
   today: a hint, clamped to the grant.
3. **The spoofing surface collapses** *(P2c)*: the browser holds only
   Decart's own session-scoped event token, designed to be browser-safe.

`constraints.realtime.maxSessionDuration` remains a SECOND wall (defense in
depth on any token we mint) — **and the probe has calibrated it (3 Aug 2026,
verdict in `devlog/SESSIONS.md`): ENFORCED at runtime, against generation.**
At the constraint the vendor stops generating and emits `"Session duration
limit reached"` (~2–3 s of granularity past the limit — reserve accounting
must tolerate that margin until vendor-truth settle reconciles it). Two
traps the probe surfaced for P2c's client: the SDK **auto-reconnects into a
connected-but-not-generating zombie** after the limit — precisely the silent
freeze this section forbids, so the limit error is TERMINAL and the client
hard-stops with a visible reason; and enforcement announces itself in the
error stream, not by connection death, so that error event is the signal to
listen for. Lucy 2.5 is **720p fixed** (1280×720, WebRTC) — which
makes the upscaling mandate below real rather than optional.

### P3 — A/V sync & fidelity ✅ *(locked: 8.5/10 on 4 Aug; synthesis shipped and rate-locked at 30fps on 6 Aug — CLOSED)*

Built, scored mid-arc (clarity 8.4 / sync 6.6), the 6.6 decoded and rebuilt,
then **locked at 8.5 overall by the CEO on 4 Aug 2026**. What the arc proved
changed the doctrine itself:

- **Measurement moved to the ear.** The first controller consumed the agent's
  `tail_latency_ms` and scored 5/10 — that number is blind to utterance
  duration (dominant), backlog, and network. The shipped meter measures
  **mouth→ear**: local mic onset → remote track onset, both on one browser
  clock, so everything in between is captured by construction (#66–67).
- **The master-clock rule generalised — the laggard is the master clock.** The
  original "audio is the pacing leg" was converted-mode truth wearing a
  universal costume. In converted mode audio lags, so video holds (elastic
  buffer, bounded queue). In passthrough/Direct mode **video** is the laggard,
  so audio takes the hold — a WebAudio delay line targeting
  videoPath − mouth→ear, with an absolute voice-safety contract: engage only
  while the delayed path is verifiably running, and every failure gives the
  voice back. Degraded sync is possible; silence is not (#71).
- **Calibration is a knob, not a deploy.** Video-path estimate drill-calibrated
  to 700 ms from the CEO's measured 400 ms lead; a live "lips earlier / lips
  later" trim (100 ms steps, persisted) puts final calibration in her hands
  (#70).
- **The upscaling mandate, delivered** (design below): Catmull-Rom + CAS in
  WebGL2, 720p → 1080p, honesty structural — the readout claims 1080p only
  when the upscaler actually produced it (#68–69). Clarity moved 7 → 8.4.
- **Instrument before tuning, again:** a delivered-fps meter now sits in the
  fidelity readout (#72). First measurement: 18fps under the probe's headless
  software rendering; the CEO's hardware number decides the 50fps approach.

**Frame synthesis: shipped, then rate-locked (CEO verdicts, 5–6 Aug 2026).**
The GPU drill priced the alternatives first — RIFE-class synthesis costs
7–15 ms of GPU while a network hop to reach a rented one costs ~50–80× that,
so the stage is client-side by measurement, not just doctrine. What shipped
(#78): a three-tier adaptive ladder — WebGPU motion-compensated interpolation,
WebGL2 midpoint blending, or native untouched — granted per device by a
session-start BENCHMARK (proof, not API presence) and revoked at runtime by a
strike-counting governor. Sync outranks synthesis, mechanically.

Two verdicts then closed the phase (6 Aug):

- **The 50fps target is retired as OVERSHOOT, not failure.** At ~57fps the
  motion read uncanny — buttery smoothness on an avatar whose detail does not
  fill every pixel outruns the image. The shipped standard is a **30fps
  TARGET RATE**: frames are synthesized onto a fixed 30fps grid (native ~19
  has no integer multiple at 30, and the grid holds 30 even if the vendor's
  rate drifts).
- **Direct/passthrough mode is RAW, by design.** The vendor's stream reaches
  the screen exactly as it arrives — no elastic delay, no synthesis, no
  upscale, no audio hold. The audio-side delay line (built and tested for the
  laggard doctrine) stays in the codebase unengaged; zero added latency IS
  passthrough's product truth, and the readout says `raw passthrough` so the
  claim matches the pixels. The laggard-is-master-clock rule governs
  Converted mode only.

**Upscaling mandate (CEO, 3 Aug 2026): enterprise-grade fidelity to FHD/2K,
client-side, staged.** Lucy outputs 720p, period; crispness beyond that is our
pipeline's job. Backend/edge GPU upscaling is **rejected** — it reintroduces a
GPU server per stream (the architecture is deliberately GPU-free and
stateless), inserts a network hop inside the video path directly against
lip-sync, and at scale rivals the vendor's own fee. Client-side, the two goals
stop competing: **WebGL spatial upscaling (FSR-class, <2 ms/frame) in the
browser studio with this phase; Apple MetalFX spatial in the native lens
(P6)**, publishing a crisp 1080p/1440p virtual camera while Decart bills 720p;
WebGPU ML super-resolution kept open as a later upgrade.

**The constraint that makes "day one" true:** the video render path is a
composable frame pipeline — receive → align (this phase's elastic buffer) →
upscale → present/publish — never a raw `<video>` element bolted to the
screen. Costs nothing now; skipping it makes FHD a retrofit later.

### P4 — Identity & persistence *(~1½ weeks)* ⟵ **OPENED 6 Aug 2026**

**This is the database phase.** Accounts, voice clones, reference images,
session history — the first storage whose job is to remember a person between
sessions, as opposed to P1's coordination state, which exists to keep concurrent
requests honest and is deleted when the session it describes ends. Voice cloning becomes a user-facing
flow rather than a step someone performs in a vendor dashboard.

Everything downstream waits on this: billing needs an account to charge, and the
admin system needs a person to look up.

**Sign-in surface (CEO decision, 6 Aug 2026): email + password, Google,
Apple — that's it.** Password ships first (self-contained); Google and Apple
follow behind CEO-minted OAuth credentials (Google Cloud console; Apple
Services ID once the P6 enrolment completes — the two workstreams converge).
The schema holds all three from day one: sign-in methods are ROWS
(`auth_identities`), not columns, so adding a provider is an insert, never a
migration.

The build, four PRs:

- **P4a — the system of record**: Cloudflare D1 (SQLite; the DOs stay
  coordination-only per §P1). `migrations/0001_identity.sql` — `users`,
  `auth_identities` (provider+subject unique; OAuth stores the provider's
  stable subject, never the email), `lens_profiles` (what the lens loads at
  Start: voice, avatar key, style prompt, the dialed sync trim — what today
  lives in localStorage graduates here), `session_history` (machine-written,
  vendor summaries VERBATIM — the COGS record P5 debits and P8 reconciles).
  Provisioning is a manual workflow (create + print ids); **the binding is
  committed only after the databases exist** — a deploy never references a
  binding before the thing behind it does.
- **P4b — auth**: sign-up/sign-in/sign-out, server-side sessions,
  rate-limited before auth and fail-closed like every other endpoint;
  suspended users resolve like missing ones (no suspension oracle). Replaces
  the admin-password gate for users; the admin gate stays ours.
- **The realignment (CEO, 7 Aug 2026)** — identity carries authority:
  `users.role` with the env-only `ADMIN_EMAILS` bootstrap (the admin
  password's successor); the session gate takes a signed-in user (admin, or
  any verified identity) FIRST, with the admin token surviving for ops
  tooling only (probes, drills — non-browser clients that hold no cookies);
  **every user must verify their email** — one-shot hashed tokens
  (migration 0003), sent via ZeptoMail the moment the CEO's token lands;
  unverified users get `verification_required`, never a bare 401. Routing:
  apex = public hero, `account.` = auth, `studio.` = signed-in only —
  hostname-routed in the one Pages app; the visual pass on those
  transitions belongs to **P7**, which now owns domain remapping and
  public→studio flow polish explicitly.
- **P4c — the identity vault**: reference image → R2; voice sample →
  ElevenLabs instant clone → `voice_id` on the profile. (CEO check at this
  door: the ElevenLabs plan tier must include instant voice cloning.)
- **P4d — session history live**: written at session end from the paths that
  already know the numbers (the agent's meters, the video settle).

### P5 — Billing *(~1½ weeks)*

**Monthly subscription (access) + prepaid wallet (usage).** Both enforced
**server-side and validated** — no client-side limit is ever the authority.

Two subscription tiers (CEO, 3 Aug 2026): working names **standard** and
**pro** (illustrative pricing only — e.g. $10/$18 per month; real prices are
set only after running costs are known, margins baked into credit pricing).
The tier gates *features*; the wallet gates *usage*. Tier scope is a
discussion for when this phase opens. The enforcement machinery is P2's
`SpendLedger`, graduated from dev caps to wallets — same object, same paths.

**Retail decoupling (CEO mandate, 3 Aug 2026): the ledger must inherently
decouple raw vendor cost from the retail price deducted from the user — we
never sell compute at cost by accident.** The design:

- **The wallet's unit of account is retail** — Lumina Credits, whose fiat
  purchase price bakes in margin — never a vendor unit. Vendor units (Decart
  seconds, ElevenLabs characters/seconds, compute overhead) convert to
  credits **at reserve**, through a configurable **rate table**, per meter.
  Settlement converts nothing: it uses vendor-reported usage only to compute
  the refund of unused reserved credits at the reservation's pinned rate, and
  to store the raw summary for reconciliation. One conversion per unit of
  usage, ever.
- **The margin floor is an enforced invariant, not a hope:** configuration
  declares both the estimated vendor COGS per unit and the retail rate per
  unit, and the ledger REFUSES TO BOOT with any retail rate below the COGS
  floor — fatal, never silent, exactly like every other malformed-config rule
  in this codebase. Selling at cost requires a deliberate, reviewed config
  change, not an oversight.
- **Raw vendor billing summaries are stored verbatim alongside the retail
  deduction** — reconciliation and audit (P8) read the vendor's number; the
  user's wallet only ever sees retail.
- **P2c builds the interface; P5 turns the rate table on.** Today's shipped
  settle (P2a) carries `usedSeconds` only. P2c extends the payload, storage
  schema, and tests to consume the vendor billing summary and carry raw-vendor
  fields distinct from the deducted amount — so that P5 is a rate-table
  change, not a refactor. Dev caps run at rate 1:1 (a second is a second)
  until wallets exist.
- **Rate-table mechanics, defined before anyone builds against them.** The
  single unit of account is **credit-cents** (integer; no floats near money).
  COGS floors and retail rates are both declared in credit-cents per vendor
  unit, so the boot-time floor check compares like with like. **Conversion
  happens at RESERVE** — the wallet is debited `grant × rate` up front, in
  credits, consistent with P2a's debit-on-reserve — and the reservation
  record **pins the rate-table version it converted under**. Settle refunds
  `(granted − used) × the PINNED rate`, never the current one: the same usage
  can never convert twice or under two prices, and a mid-session rate change
  affects only reservations created after it. Rounding is house-favouring and
  fixed: **ceil at debit, floor at refund.** Reconciliation (P8) re-derives
  the deduction from the stored raw vendor summary and the pinned version;
  any mismatch is an alert, not an adjustment.

The 180 s / ~$60 caps that appear in older notes are **development** caps: a wall
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

### PL — Pre-launch gate: elastic capacity *(blocks any public MVP launch — CEO mandate, 3 Aug 2026)*

**A funded user refused at the door is a broken promise, not a capacity
policy.** The business is prepaid: if 10,000 users burst the system, those are
10,000 *funded* sessions — revenue-covered demand that must be served. "The
lens is busy" is acceptable for development and closed testing; it is
unacceptable for anyone holding a paid wallet. Before the MVP is public, the
stateless agents move to an **auto-scaling container orchestrator** — Fly.io,
AWS Fargate, or Kubernetes, chosen *then* by ops reality, not now by fashion.

The doctrine is **scale first, refuse last, never degrade.** Elasticity is the
front line; the honest refusal stays as the final backstop behind it, because
every platform has a ceiling somewhere and the alternative to a door is every
live call degrading at once. What launch changes is that a funded user should
never actually reach the door.

**Why this is a migration, not a rewrite** — the P1 architecture was built for
exactly this:

| stays identical | changes |
|---|---|
| stateless agents (parameters in, nothing local that matters) | where they run |
| the room-pool registry (rooms in, sessions out) | rooms become **registered by the orchestrator** on agent start/exit, instead of static config |
| the O(1) session lifecycle | an orchestrator watches demand and spawns/kills agents |

Registration survives crashes and partitions by putting **liveness where it
already lives**: the orchestrator health-checks containers as its core job, so
the orchestrator — not the agent — registers and deregisters rooms, on its own
lifecycle events. Registration is idempotent (re-registering an existing room
is a no-op); a crashed agent is deregistered by the same supervisor that
noticed the crash; and orchestrator-registered rooms carry a coarse safety
TTL that **the orchestrator itself refreshes** on its scale events — one
owner for registration, refresh, and deregistration alike, so cleanup can
never fall between two components. Never per-second heartbeats through the
Durable Object (§P1 rule 2 forbids exactly that): a partitioned
orchestrator's stale rooms simply age out instead of advertising capacity
that no longer exists. Final mechanics are decided at this gate with the
orchestrator in hand — the constraint that survives any choice: **stale
capacity must expire without anything polling.**

**How capacity grows, canonised** (the CEO's questions of 2 Aug, answered in
order of execution):

1. **Now:** one VPS, hand-started `lumina-agent@<room>` units. Capacity 2 live,
   **held ≤ 6** until the concurrent-load CPU drill (`top` during two
   simultaneous conversations) converts the cap into a measured number;
   **~19** is the RAM-bound max on the current box (~350 MiB/agent, measured
   2 Aug).
2. **More boxes (no code change):** additional VPSes run the same units; their
   rooms join the same pool. ~$40/box per ~19 concurrent — linear and boring.
3. **This gate:** containers + orchestrator + agent self-registration +
   a load test at several multiples of expected launch concurrency, with the
   wallet ledger enforcing spend throughout.

**The cost truth that makes this safe to want:** at scale the boxes are a
rounding error — vendor COGS (ElevenLabs per second, Decart at $1.20/min)
dominate, and under the prepaid model every vendor-dollar is spent against a
funded wallet with margin already priced in. Elastic infrastructure without
the wallet enforcer would be an unbounded liability; **with** it (P2), scaling
up is scaling revenue. That is why P2 precedes this gate in dependency order.

Prerequisites, in order: the CPU drill (turns 6 into a number) → P2's ledger
proven → P4 accounts (a wallet needs an owner) → this migration → load test →
launch.

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

**23. The laggard is the master clock.** *(amended 4 Aug 2026 — was "audio is
the pacing leg")*
The original rule was converted-mode truth stated as universal law: in
converted mode audio lags, so video buffers to match it. In passthrough the
video path is the laggard, and holding video there widens the gap. The general
rule: whichever leg arrives last is the clock; the other leg takes the elastic
hold — and when audio takes it, the voice-safety contract is absolute (every
failure gives the voice back). Any sync budget must be elastic, not fixed.
*(structural, carried forward; generalised in #71)*

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

### Earned since v2.4

**30. A mock you invented is a mirror, not a wall.**
The white-label adapter spoke field names I made up, and the test stub spoke
them back — every test green, the CEO's first drill 502. Vendor stubs must cite
the doc or live exchange their shapes came from. *(3 Aug, #50)*

**31. UI state with a lifecycle is a lib with a test, from the first draft.**
Lifecycle logic written inside a component three separate times; each
extraction (`sessionHolder`, `videoNegotiator`, `voiceSelection`) immediately
exposed real bugs the component version was hiding. The tell: the extracted
libs had tests, the hooks did not. *(3 Aug — P1b, P2d, voice dropdown)*

**32. Measure the experience, not the component.**
The sync controller consumed the agent's own tail-latency number and scored
5/10: that number cannot see utterance duration, backlog, or network — the
three things that dominated. The shipped meter measures mouth→ear, the thing
the user actually experiences, and captures everything in between by
construction. *(4 Aug, #66)*

**33. An asserted claim must match delivered pixels.**
The render probe demanded "720p" after the upscaler made the output 1080p —
stale twice in one day. A probe asserts the honesty *rule* (claim ==
delivered), never a frozen value; and it asserts it against the element that
carries the product, not the first `<video>` it finds. *(4 Aug, #69)*

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
| Confirm Decart's billing basis | Specifically: what "per second of active generation" meters — reconciles our ledger against their invoice. |
| Agree the **P8 admin scope** | Not yet — at the door. Listed there as a starting point, not a decision. |
| **Google credentials → `secrets.env` + `scripts/put-worker-secrets.sh production`** | She has the console set up (7 Aug). Add `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` to secrets.env, add the redirect URI `https://api.luminastream.live/api/auth/google/callback` in the Google console, run the script — the wiring code activates on the secrets' presence. |
| **`ZEPTOMAIL_TOKEN` → secrets.env + the same script** | Email verification's sender (she has a ZeptoMail account). Every user must verify (CEO, 7 Aug); the flow ships as soon as the token lands. |
| **`ADMIN_EMAILS` → secrets.env + the same script** | The retired admin password's successor: sign-in on a listed email bootstraps the admin role. Env-only — the public repo never names an admin. |
| **DNS: apex `luminastream.live` + `account.luminastream.live` → the Pages project** | The routing realignment (public hero at the apex, auth on account., studio locked to signed-in users). Two custom-domain attaches on the Pages project. |
| **Apple Services ID** (after enrolment completes) | The Apple sign-in half — converges with the P6 enrolment already running. |

Done since v2.5: `api.luminastream.live` attached (7 Aug) — first-party auth
cookies, Safari sign-in works.

Done since v2.4: `DECART_API_KEY` placed (3 Aug — after the wall merged, as
required); Decart account topped up with auto-top-up enabled (4 Aug).

---

## 7. How to read this document

Phases are ordered by dependency, not by preference — P1 before P2 because
per-session rooms are what make a second user possible at all, and video without
that is a demo. Time estimates are working estimates, not commitments.

When this document and the code disagree, **the code is right and this document
is a bug**. Fix it in the same PR that caused the drift.
