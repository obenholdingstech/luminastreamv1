# Base44 Project

Use this repository to run and edit the app locally, then publish changes back through Base44.

Any change pushed to the repo will also be reflected in the Base44 Builder.

## Prerequisites

1. Clone the repository using the project's Git URL.
2. Navigate to the project directory.
3. Install dependencies: `npm install`.
4. Install the Base44 CLI: `npm install -g base44@latest`.

See the [Base44 CLI docs](https://docs.base44.com/developers/references/cli/get-started/overview) if you want to run Base44 commands directly.

## Run Locally

Run the full local development environment from the project root:

```bash
base44 dev
```

`base44 dev` starts the local Base44 development backend and, when this app is configured for it, also starts the frontend dev server for you. Use the frontend URL printed by the command.

For example, when the Base44 project config includes a `serveCommand`, `base44 dev` can launch the frontend too:

```json5
{
  "site": {
    "serveCommand": "npm run dev"
  }
}
```

In a Base44 project this lives in `base44/config.jsonc`.

## Run Only The Frontend

If you only want to work on the frontend against the hosted Base44 backend, run:

```bash
npm run dev
```

Open the local URL printed by Vite.

## Deploy — Cloudflare Pages (studio.luminastream.live)

The frontend is a static Vite build (`npm run build` → `dist/`) served by
Cloudflare Pages via **Git integration**: Cloudflare builds and deploys on
every push to `main`, entirely from its dashboard. We deliberately do NOT use
`wrangler pages deploy` (direct upload) — it needs a Cloudflare API token, and
this repo is public, so no Cloudflare config or credentials live in the repo
at all. Everything below happens in the Cloudflare dashboard.

### One-time setup (exact clicks)

1. Log in at `dash.cloudflare.com` → in the left sidebar open
   **Workers & Pages**.
2. Click **Create application** → select the **Pages** tab →
   **Connect to Git**.
3. Sign in with GitHub when prompted and click **Install & Authorize**
   (grant access to the `obenholdingstech` org — you can restrict the
   install to just this repository).
4. Pick the **luminastreamv1** repository → **Begin setup**.
5. On **Set up builds and deployments**:
   - **Project name**: `luminastream-studio` (this becomes
     `luminastream-studio.pages.dev`)
   - **Production branch**: `main`
   - **Framework preset**: `Vite`
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
   - Leave **Root directory** empty; add no environment variables for now
     (see `VITE_API_BASE` below).
6. Click **Save and Deploy** and wait for the first build to go green.
   The site is now live at `luminastream-studio.pages.dev`.

### Custom domain (studio.luminastream.live)

Do this from the Pages project, not from DNS — adding a bare CNAME without
registering the custom domain on the project first fails with a 522.

1. Open the project under **Workers & Pages** → **Custom domains** tab →
   **Set up a domain**.
2. Enter `studio.luminastream.live` → **Continue**.
3. If the `luminastream.live` zone is in this Cloudflare account, confirm
   the DNS record when prompted — Cloudflare adds the CNAME automatically.
   If DNS is hosted elsewhere, create this record at that DNS provider:
   `CNAME  studio  luminastream-studio.pages.dev`.

### API base URL (`VITE_API_BASE`)

The old Base44 backend proxy is dead. The frontend reads one build-time
variable, `VITE_API_BASE` (see `src/lib/apiBase.js`):

- **Unset (the default)** — the site, including `/livekit-test`, works fully
  without it. Legacy Base44 calls go to same-origin `/api/...` paths and fail
  soft, though the shape differs by host: the local dev server returns a
  plain 404, while the deployed site's SPA fallback answers `/api/...` with
  the app document (`index.html`, HTTP 200). Neither has a backend behind it;
  the frontend tolerates both.
- **When a real API backend exists**: project → **Settings** →
  **Environment variables** → **Add variable** → name `VITE_API_BASE`,
  value e.g. `https://api.luminastream.live` (no trailing slash needed —
  it is normalized) → save, then re-deploy (**Deployments** → latest →
  **Retry deployment**, or push a commit). Vite bakes the value in at build
  time; editing the variable alone changes nothing until a rebuild.

### Why /livekit-test works deployed

The build emits no top-level `404.html`, so Pages serves the app in SPA
mode: every unmatched path (e.g. a hard refresh on
`studio.luminastream.live/livekit-test`) returns `index.html` and React
Router takes over — identical to the Vite dev server. No `_redirects` file
or Pages Function is needed. The page itself stays serverless: generate a
token locally with `node scripts/generate-livekit-token.js` and paste it in,
same as on localhost. No secret is ever part of the deployment. Once the API
Worker below is deployed and `VITE_API_BASE` is set, `/livekit-test` also
gains a **Mint via server** button (password → server-minted token), the
production path — see the next section.

## API Worker (Cloudflare)

`workers/api/` is our first owned backend: a single Cloudflare Worker with an
**admin gate** and **server-side LiveKit token minting**, so real users get a
LiveKit token without the API secret ever touching the browser. It replaces
the DEV-ONLY `scripts/generate-livekit-token.js`.

| Method | Path                 | Auth              | Purpose                                            |
| ------ | -------------------- | ----------------- | -------------------------------------------------- |
| GET    | `/api/health`        | none              | `{ ok, version }`                                  |
| POST   | `/api/admin/verify`  | none (hard limit) | `{ password }` → `{ ok, token, expiresAt }` (~12h) |
| POST   | `/api/livekit/token` | `X-Admin-Token`   | `{ room, identity }` → LiveKit token (≤6h)         |

The token is minted by hand with Web Crypto (HS256), so the Worker has **zero
dependencies**; its claims are verified against `livekit-server-sdk` in the
tests and were validated against the live LiveKit Cloud project. Rate limiting
uses the native Workers binding (per-colo): **5/60s** on verify, **30/60s** on
mint. CORS is limited to `studio.luminastream.live`, our
`*.luminastream-studio.pages.dev` previews, and `localhost:5173`.

### Deploy — automated production, manual staging

**Production deploys are automated.** A push to `main` that touches
`workers/**` triggers [`.github/workflows/deploy-worker.yml`](.github/workflows/deploy-worker.yml),
which runs the Worker tests and then deploys the top-level (production) Worker
`luminastream-api` via the official `cloudflare/wrangler-action`. Nobody
deploys production by hand.

**Staging** (`luminastream-api-staging`) is the default target for manual and
agent deploys:

```bash
cd workers/api && npm install
npm run deploy            # → wrangler deploy --env staging
```

#### One-time setup (Amy): mint a narrow token, paste into GitHub

1. **Mint a scoped Cloudflare API token.** Dash → **My Profile → API Tokens →
   Create Token → Create Custom Token**. Grant only the two scopes wrangler
   needs to deploy a Worker — nothing more:
   - **Account · Workers Scripts · Edit**
   - **Account · Account Settings · Read**

   Under **Account Resources**, restrict it to the single LuminaStream account
   (not "all accounts"). Add **no Zone / DNS / Routes / KV / R2** permissions —
   we deploy to `*.workers.dev`, so the token needs zero DNS reach. Set a
   bounded **expiry** (e.g. 1 year) and put a rotation reminder on the calendar.
2. **Find the Account ID** — Dash → **Workers & Pages** → right sidebar
   **Account ID** (also printed by `npx wrangler whoami`).
3. **Store both in GitHub** — repo → **Settings → Secrets and variables →
   Actions → New repository secret**:
   - `CLOUDFLARE_API_TOKEN` = the token from step 1
   - `CLOUDFLARE_ACCOUNT_ID` = the Account ID from step 2

   (Optional hardening: scope these to a `production` GitHub **Environment** and
   add required reviewers to gate each deploy behind a human approval.)

The LiveKit and admin secrets are **not** stored in GitHub — CI only ships
code. They live in Cloudflare's per-Worker secret store, set once by the script
below.

#### Inject the Worker's runtime secrets (Amy, once per environment)

Put the values in the gitignored `secrets.env` at the repo root
(`ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET` = output of `openssl rand -hex 32`,
`LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_URL`), then:

```bash
npx wrangler login                          # or: export CLOUDFLARE_API_TOKEN=<token>
scripts/put-worker-secrets.sh staging       # set them on the staging Worker
scripts/put-worker-secrets.sh production     # and on the production Worker
```

The script pipes each value straight from `secrets.env` into
`wrangler secret put` over stdin — **no value is ever printed** or written to a
tracked file. Re-run it to rotate. Live logs: `npm run tail` (staging) or
`npx wrangler tail` (production), from `workers/api`.

Verify a deploy:

```bash
curl https://luminastream-api-staging.<account>.workers.dev/api/health
curl https://luminastream-api.<account>.workers.dev/api/health
# → {"ok":true,"version":"0.1.0"}
```

### Point the frontend at the Worker

In the Cloudflare **Pages** project (`luminastream-studio`) → **Settings** →
**Environment variables**, set `VITE_API_BASE` to the production Worker URL (no
trailing slash), then redeploy the Pages project (Vite bakes it in at build
time). `/livekit-test` will then show the **Mint via server** path. Leaving
`VITE_API_BASE` unset keeps the manual-paste dev fallback and changes nothing.

### Custom domain (`api.luminastream.live`) — a deliberate human step

DNS is **not** automated and the CI token intentionally has **no DNS scope**.
Pointing a custom domain changes public DNS — rare and sensitive — so it stays
a manual act: in the dashboard open the Worker → **Settings → Domains & Routes →
Add** → `api.luminastream.live`, then set
`VITE_API_BASE=https://api.luminastream.live` on the Pages project. CORS keys
off the browser's Origin (the studio site), not the API host, so either the
`workers.dev` URL or the custom domain works.

### Local development

```bash
cd workers/api
cp .dev.vars.example .dev.vars   # fill in real values — .dev.vars is gitignored
npx wrangler dev                 # → http://localhost:8787
npm test                         # node --test (offline, no secrets)
```

## Use The Hosted Backend

For frontend-only development, create or update `.env.local` in the project root:

```bash
VITE_BASE44_APP_ID=your_app_id
VITE_BASE44_APP_BASE_URL=https://your-app.base44.app
```

`VITE_BASE44_APP_ID` identifies the Base44 app.

`VITE_BASE44_APP_BASE_URL` tells the Base44 Vite plugin where to send local `/api` requests. Point it at your deployed Base44 app URL when you want the local frontend to use the hosted backend.

When you use `base44 dev`, the command injects the local Base44 values for you, so `.env.local` is mainly needed for frontend-only workflows.

## Publish Your Changes

After pushing your changes to git, open the Base44 dashboard and publish the app:

```bash
base44 dashboard open
```

## Docs & Support

Documentation: [https://docs.base44.com/Integrations/Using-GitHub](https://docs.base44.com/Integrations/Using-GitHub)

Base44 CLI command reference: [https://docs.base44.com/developers/references/cli/commands/introduction](https://docs.base44.com/developers/references/cli/commands/introduction)

Support: [https://app.base44.com/support](https://app.base44.com/support)
