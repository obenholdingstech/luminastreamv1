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
| POST   | `/api/session/create`    | `X-Admin-Token`   | allocates a room + identity + grant, or `503 at_capacity` |
| POST   | `/api/session/end`       | `X-Admin-Token`   | `{ sessionId, endToken }` → releases the slot            |
| GET    | `/api/session/capacity`  | `X-Admin-Token`   | `{ live, capacity, available }`                          |

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
