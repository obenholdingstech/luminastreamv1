# LuminaStream API Worker

Our first owned backend: a single Cloudflare Worker providing an **admin gate**
and **server-side LiveKit token minting** — the path real users will eventually
take, replacing the DEV-ONLY `scripts/generate-livekit-token.js`.

## Endpoints

| Method | Path                  | Auth              | Purpose                                             |
| ------ | --------------------- | ----------------- | --------------------------------------------------- |
| GET    | `/api/health`         | none              | `{ ok, version }` liveness check                    |
| POST   | `/api/admin/verify`   | none (hard limit) | `{ password }` → `{ ok, token, expiresAt }` (~12h)  |
| POST   | `/api/livekit/token`  | `X-Admin-Token`   | `{ room, identity }` → LiveKit access token (≤6h)   |

- The admin password is checked with a **constant-time** comparison (SHA-256
  both sides via Web Crypto, digests compared — never `===`).
- `/api/admin/verify` returns a short-lived **HMAC-signed session token**; send
  it back as the `X-Admin-Token` header on `/api/livekit/token`.
- The LiveKit token is minted by hand with Web Crypto (HS256), so the Worker
  has **zero dependencies** and never ships the LiveKit secret to the browser.
  The claim shape is verified against `livekit-server-sdk` in the tests.
- Rate limiting uses the native Workers Rate Limiting binding (per-colo):
  **5/60s** on verify (password oracle), **30/60s** on the mint endpoint.
- CORS is limited to `studio.luminastream.live`, our `*.luminastream-studio.pages.dev`
  previews, and `localhost:5173`.

## Local development

```bash
cd workers/api
npm install
cp .dev.vars.example .dev.vars   # then fill in real values (gitignored)
npx wrangler dev                 # → http://localhost:8787
npm test                         # node --test (no network, no secrets)
```

## Deploy

Deployment and the exact `wrangler secret put` commands live in the repo root
**README → "API Worker (Cloudflare)"**. Never put secret values in any file
that gets committed.
