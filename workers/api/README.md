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
  **20/60s** on the session routes.
- CORS is limited to `studio.luminastream.live`, our `*.luminastream-studio.pages.dev`
  previews, and `localhost:5173`.

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

### The lease

`SESSION_LEASE_SECONDS` (default **7200**, 2h) is deliberately two things at
once: the maximum length of a session, and the maximum time an **abandoned**
slot stays held before the reaper frees it. The LiveKit grant is minted for the
same span, so a slot and the credential that can occupy it expire together —
which is exactly why no heartbeat is needed to keep a session alive. It is
hard-capped by the 6h LiveKit ceiling in `livekit.js`.

`MAX_CONCURRENT_SESSIONS` (default **1**) is the truth today: one agent, one
room. P1c measures the real capacity constant on the VPS. Both variables are
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
