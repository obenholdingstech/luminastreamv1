# LuminaStream API Worker

Our first owned backend: a single Cloudflare Worker providing an **admin gate**
and **server-side LiveKit token minting** — the path real users will eventually
take, replacing the DEV-ONLY `scripts/generate-livekit-token.js`.

## Endpoints

| Method | Path                     | Auth              | Purpose                                                  |
| ------ | ------------------------ | ----------------- | -------------------------------------------------------- |
| GET    | `/api/health`            | none              | `{ ok, version }` liveness check                         |
| POST   | `/api/admin/verify`      | none (hard limit) | `{ password }` → `{ ok, token, expiresAt }` (~12h)       |
| POST   | `/api/livekit/token`     | `X-Admin-Token`   | `{ room, identity }` → LiveKit access token (≤6h)        |
| POST   | `/api/session/create`    | `X-Admin-Token`   | → `{ sessionId, endToken, room, identity, token, url, expiresAt }` |
| POST   | `/api/session/end`       | `X-Admin-Token`   | `{ sessionId, endToken }` → releases the slot            |
| GET    | `/api/session/capacity`  | `X-Admin-Token`   | `{ enabled, live, capacity, available, pool }`            |
| POST   | `/api/session/reset`     | `X-Admin-Token`   | releases **every** slot → `{ released }` (operator tool)  |
| POST   | `/api/video/reserve`     | `X-Admin-Token`   | holds video seconds → `{ reservationId, settleToken, grantedSeconds, remainingSeconds }` |
| POST   | `/api/video/settle`      | `X-Admin-Token`   | reports usage, credits the unused hold (idempotent)       |
| GET    | `/api/video/budget`      | `X-Admin-Token`   | `{ enabled, perSessionSeconds, totalSeconds, spentSeconds, remainingSeconds, openReservations }` |
| POST   | `/api/video/reset`       | `X-Admin-Token`   | zeroes the meter, drops every hold (dev-cap operator tool) |
| POST   | `/api/video/session`     | `X-Admin-Token`   | white-label create: reserve → constrained token → vendor session → bind → `{ sessionId, controlToken, vendor }` |
| POST   | `/api/video/session/:id/candidates` | `X-Admin-Token` + `controlToken` | ICE proxy (stateless auth, zero ledger cost) |
| POST   | `/api/video/session/:id/prompt`     | `X-Admin-Token` + `controlToken` | prompt update proxy |
| POST   | `/api/video/session/:id/end`        | `X-Admin-Token` + `controlToken` | Worker DELETEs at the vendor, settles **vendor-truth** |

`/api/session/create` refuses with **503** and one of two distinct errors:
`at_capacity` (every agent is busy — a queue that will clear) or
`sessions_disabled` (this environment serves no sessions at all — permanent, do
not retry). A client that cannot tell them apart retries the permanent one
forever, which is why they are separate codes rather than one.

- The admin password is checked with a **constant-time** comparison (SHA-256
  both sides via Web Crypto, digests compared — never `===`).
- `/api/admin/verify` returns a short-lived **HMAC-signed session token**; send
  it back as the `X-Admin-Token` header on `/api/livekit/token`.
- The LiveKit token is minted by hand with Web Crypto (HS256), so the Worker
  has **zero dependencies** and never ships the LiveKit secret to the browser.
  The claim shape is verified against `livekit-server-sdk` in the tests.
- Rate limiting uses the native Workers Rate Limiting binding (per-colo):
  **5/60s** on verify (password oracle), **30/60s** on the mint endpoint,
  **20/60s** on the session routes, **20/60s** on the video routes.
- CORS is limited to `studio.luminastream.live`, our `*.luminastream-studio.pages.dev`
  previews, and `localhost:5173`.

## The video spend wall

`/api/video/*` is backed by **`SpendLedger`** — the prepaid wallet enforcer from
day one, temporarily wearing dev-cap clothes (`ROADMAP.md` §P2). It merged
**before the Decart key exists**, per doctrine, and today meters against
`MAX_VIDEO_SECONDS_PER_SESSION=180` / `MAX_VIDEO_SECONDS_TOTAL=3000` (~$60).

The shape is **reserve → settle** (two DO requests per video session, whatever
its length — the §P1 O(1) invariant with money attached). The balance is
**debited at reserve**; settle credits back the unused hold. An unsettled
reservation is reaped by a demand-driven alarm and resolves **conservatively as
fully spent** — dev caps protect the card, and in wallet mode a too-cautious
hold is correctable at P5 reconciliation while a too-generous release is money
gone.

Spoof-proofing: the settle credential is random and hashed at rest; a settle
can never exceed its reserve (usage is clamped to the grant); a second settle
credits nothing; a wrong bearer moves no money in either direction; a zero
balance refuses the grant with `video_budget_exhausted` — which is the wall
*working*, not an outage. Fail-closed like everything else: a dropped
`VIDEO_LEDGER` binding refuses video rather than serving it unmetered.

## The session layer

`/api/session/*` is backed by **`SessionRegistry`**, a SQLite-backed Durable
Object — the project's first server-side storage. It holds coordination state
(which sessions are live, which room and identity each holds, when each claim
expires), **not** user data; that is P4.

**Create** returns everything the client needs in one response — `sessionId`,
`endToken`, `room`, `identity`, a LiveKit `token`, `url`, and `expiresAt` — so
nothing ever has to come back and ask. That is what makes the cost invariant
affordable rather than merely aspirational:

> **Durable Object requests per session must be a constant, independent of how
> long the session lasts.** Never O(session duration). — `ROADMAP.md` §P1

A DO bills for its allocated 128 MB whenever it is awake and hibernates after
10 s of silence, so the expensive mistake is not calling it too often — it is
never letting it sleep. Consequently there is **no polling, no heartbeat, no
WebSocket, and no `setTimeout`/`setInterval`** anywhere in `sessionRegistry.js`
(a pending timer blocks hibernation entirely). Cleanup runs on a **single
demand-driven `alarm()`**, always set to the earliest pending expiry and
re-armed on wake — never a fixed-interval sweep, which would make wakeups scale
with duration.

`test/sessionOracle.test.js` enforces that by counting every request into the DO
stub and every alarm: **≤ 3 requests / 0 alarms** for a clean session, **≤ 2 / 1**
for an abandoned one, and — the row that catches a poll hiding inside the budget
— **identical counts for a short and a long session**.

### The room pool — a slot is a room with an agent in it

`SESSION_ROOMS` is a comma-separated list of the rooms an **agent is actually
serving**, and `create` allocates from it. It never invents a room name.

That distinction is the whole point. An invented room (`lumina-<uuid>`) reads
fine and is wrong: no agent joins a name we made up a moment ago, so the browser
would connect, publish its microphone, and wait forever for a reply — while the
registry reported a perfectly healthy session. Capacity has to be a *fact about
how many agents are running*, not a number we assert.

So there are two limits, and they are different things:

| | meaning |
|---|---|
| `SESSION_ROOMS` | **physical** — how many rooms have an agent |
| `MAX_CONCURRENT_SESSIONS` | **policy** — how many we choose to admit |

Effective capacity is `min(pool size, MAX_CONCURRENT_SESSIONS)`, so the policy
knob can never admit **more** sessions than there are agents —
the same shape as the audio governor's adjustable cap under a hard ceiling. The
capacity endpoint reports both, so an operator can tell "we are holding capacity
down" apart from "we ran out of agents".

Growing capacity in P1c is therefore one operation on the box and one config
line: start another agent with `convert_agent.py --room <name>` (already a
first-class flag) and add that name here.

**An environment with no agent must say so.** `SESSIONS_ENABLED` (default
`true`) exists because a pool is a *promise that someone is listening*. Staging
runs no agent, so staging sets it `false` and refuses with `sessions_disabled`
rather than issuing valid credentials for silence — which would be this exact
bug reintroduced through configuration instead of code. A test asserts the
committed staging config keeps it off, so turning it on is a deliberate act with
a review attached rather than a one-character edit. It doubles as an operational
kill switch: sessions stop with one variable and no code deploy.

The pool is parsed strictly, and the **duplicate check earns its keep**: a room
listed twice would hand one room to two sessions, and LiveKit evicts on
duplicate identity — so the second speaker silently kicks the first out of a
call they are mid-sentence in. It presents as a flaky connection, never as a
configuration error. A test also parses `agent/convert_agent.py` and asserts the
default pool equals the agent's `DEFAULT_ROOM`, so a rename on one side cannot
quietly hand out a room nobody serves.

### Recovering a stuck slot

A slot is held from Start to Stop, and one nobody releases stays held until its
lease expires. The lease is a backstop for the paths where no client code can
run — a hard tab close, a dead laptop. **It is not an operation**, and the first
live drill proved why: a held slot with no client left to release it, and no
recovery available short of waiting two hours.

```bash
scripts/reset-sessions.sh production   # or staging
```

Reads `ADMIN_PASSWORD` from the gitignored `secrets.env` and pipes it straight
into the request — never echoed, never in argv, never in shell history. Prints
capacity before and after, so the output says what was actually stuck rather
than only what was cleared.

It is **blunt on purpose**: it cannot tell a stuck slot from a live one, because
from the server they are identical — a record with time left on it looks the
same whether someone is speaking into it or the tab closed an hour ago. It can
therefore cut off a real session. Use it when the lens refuses with "busy" and
nobody is using it.

`at_capacity` refusals now carry `live`, `capacity` and `pool`, so the next one
says which case it is instead of leaving it to be inferred.

### The white-label session (P2c)

The committed topology (ROADMAP §P2), implemented: the Worker creates every
Decart session — reserve → **constrained client token minted for the Worker's
own use** (wall #2 rides on the session; the token is never shown to anyone) →
vendor create → **bind the session id to the reservation BEFORE the browser
sees a byte** → only then the response. A failed bind compensates with an
immediate vendor DELETE, id in hand. Media flows browser↔Decart directly;
the browser's SSE uses Decart's own session-scoped event token.

Session control authenticates with a **stateless control token** (HMAC over
`{sid, rid, exp}`), so ICE candidates and prompt updates cost **zero** Durable
Object requests. The full O(1) budget: reserve + bind + settle = **3 DO
requests per video session**, whatever its length.

**End is vendor-truth:** the Worker performs the DELETE, reads Decart's
billing summary from that server-to-server exchange, and settles the ledger
with THAT — any browser-supplied summary is ignored (a client that could
report its own bill would report a small one). Overage past the grant (~2–3 s
of measured vendor granularity) is clamped for the dev meter and recorded on
the settlement row, raw summary verbatim, for reconciliation.

**A failed kill never settles.** Settling deletes the reservation, and the
reservation is the executioner's ammunition — so `end` returns
`vendor_delete_failed` and leaves the record for the alarm to retry. The
create-path compensation is the mirror image: it cannot defer (the record is
being destroyed either way), so an unkillable session settles **fully spent**
and logs the orphan — refunding a stream that may still be running would pay
for someone else's video.

**The executioner:** an expired reservation carrying a session id gets its
vendor session DELETEd by the reaper alarm — bounded retries
(`1 + KILL_RETRIES` alarms per overrun, a constant), 404 counts as success
(already dead), and a kill that exhausts its retries resolves the ledger
anyway with an **orphan flag**: silent about its bill, never about its
existence. Vendor calls happen ONLY in the alarm — a budget read never talks
to Decart.

### The lease

`SESSION_LEASE_SECONDS` (default **7200**, 2h) is deliberately two things at
once: the maximum length of a session, and the maximum time an **abandoned**
slot stays held before the reaper frees it. The LiveKit grant is minted for the
same span, so a slot and the credential that can occupy it expire together —
which is exactly why no heartbeat is needed to keep a session alive. It is
hard-capped by the 6h LiveKit ceiling in `livekit.js`.

`MAX_CONCURRENT_SESSIONS` (default **1** — the safe floor; production sets the
real number, **2** since 2 Aug 2026) is bounded by the measured constant:
~350 MiB per agent ⇒ ~19 RAM-bound on the current box, held at ≤6 until CPU
under concurrent load is measured (`ROADMAP.md` §P1). Both variables are
parsed **strictly** — a malformed value fails the request with a 500, never a
silent default, the same rule `agent/spend_governor.py` proves for audio spend.

Both are plain `vars` in `wrangler.jsonc`, not secrets: they are operational
limits, and a public repo is the right place for them.

## Local development

```bash
cd workers/api
npm install
cp .dev.vars.example .dev.vars   # then fill in real values (gitignored)
npx wrangler dev                 # → http://localhost:8787
npm test                         # node --test (no network, no secrets)
```

## Deploy

- **Production** — automated: a push to `main` touching `workers/**` runs
  `.github/workflows/deploy-worker.yml` (Worker tests → `wrangler deploy` via
  `cloudflare/wrangler-action`). Not deployed by hand.
- **Staging** — `npm run deploy` (→ `wrangler deploy --env staging`), the
  default target for manual / agent deploys.
- **Secrets** — set per environment with `scripts/put-worker-secrets.sh
  [staging|production]`, which pipes values from the gitignored `secrets.env`
  into `wrangler secret put` (never echoed). Never commit secret values.

Full one-time setup (narrow token scopes, GitHub Actions secrets, custom-domain
DNS) is in the repo root **README → "API Worker (Cloudflare)"**.
