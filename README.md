# LuminaStream

LuminaStream is a **lens, not a venue.** A person installs it, presses Start, and
LuminaStream presents itself to the operating system as a **Virtual Camera and
Virtual Microphone**. They then open WhatsApp, Zoom, TikTok Live or Discord,
select LuminaStream as their camera and mic, and the other platform receives the
transformed person. Viewers live on those platforms and never know this project
exists.

The browser app in this repo is the workshop, not the product. It has two
surfaces, both driving the same voice engine through the same hook:

| Route | What it is |
|---|---|
| `/` | **The lens.** One decision (Direct or Converted), one action. What the product does. |
| `/livekit-test` | **The console.** Every knob the agent broadcasts, in the agent's own vocabulary. Dev-only, permanently useful, never the product. |

The engine itself runs off-browser: a Python agent on a VPS (`agent/`), a
Cloudflare Worker for session authority (`workers/api/`), and LiveKit Cloud for
transport.

**[`ROADMAP.md`](ROADMAP.md) is the canon** — the full product definition, the
real state of the system, the phase order, and the doctrine. Start there.

## Prerequisites

1. Clone the repository and `cd` into it.
2. `npm install`.

Node 20+. The agent has its own toolchain — see `agent/README.md`.

## Run Locally

```bash
npm run dev
```

Open the URL Vite prints. Without `VITE_API_BASE` set there is no session
authority to mint a LiveKit token from, so the lens says so and points at the
console, which accepts a hand-pasted token from
`node scripts/generate-livekit-token.js`.

To run against a deployed Worker:

```bash
VITE_API_BASE=https://<your-worker-host> npm run dev
```

**The lens no longer chooses its room.** `POST /api/session/create` allocates
one from a pool of rooms an agent is actually serving (`SESSION_ROOMS` in
`workers/api/wrangler.jsonc`), together with a non-colliding identity and a
grant scoped to both — and refuses with a reason when nothing is free, rather
than admitting a second speaker into a room where the agent is already busy.
`VITE_LIVEKIT_ROOM` is gone with it.

The slot is held from **Start** to **Stop**, not from unlock, and is released on
Stop, on unmount, and on `pagehide`. A slot nobody releases stays held until its
lease expires (2h), which on a one-agent system means one closed tab locks
everyone else out for the afternoon.

`/livekit-test` still picks its own room and identity by hand — it is the
instrument panel, and a drill must not depend on the session layer being up.

## Verification

Everything below is the release gate. All of it runs before a PR is opened; CI
runs the frontend half on push.

```bash
npm run lint
npm run typecheck                  # tsc over src/ with checkJs
node --test src/lib/*.test.js      # includes a real `vite build` guard
npm run build

(cd workers/api && node --test)    # the Worker's own suite
(cd agent && pytest -q)            # the voice agent's suite
```

## Deploy — Cloudflare Pages (studio.luminastream.live)

The frontend is a static Vite build (`npm run build` → `dist/`) served by the
Cloudflare **Pages** project `luminastream-studio` (`luminastream-studio.pages.dev`).
**Production deploys are automated and are a property of the merge** — exactly
like the Worker. Nobody deploys the frontend by hand.

A push to `main` that touches the frontend build inputs triggers
[`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml),
which runs `npm ci`, **fails the job if `VITE_API_BASE` is empty or unset**,
builds with that value baked in, and uploads `dist/` to the `luminastream-studio`
project via the official `cloudflare/wrangler-action` (direct upload, pinned
wrangler — no Pages Git integration, no dashboard build). The workflow watches
`src/**`, `public/**`, `index.html`, `package*.json`, the `vite`/`tailwind`/`postcss`
configs, and the workflow file itself.

`VITE_API_BASE` is a GitHub Actions **repository variable** (not a secret — it
is public config: the production Worker URL). Vite bakes it into the bundle at
build time, so editing the variable changes nothing until the next build; a push
to `main` — or a **Re-run** of the latest workflow — rebuilds and redeploys. The
build guard exists because an empty base silently ships a frontend that talks to
same-origin `/api` with no backend behind it — the same regression the
`src/lib/apiBase.build.test.js` sentinel catches at the unit level.

### First deploy (bootstrap — done once, by hand)

The Pages project is created and seeded once with wrangler; every deploy after
that is the merge workflow above. To reproduce from scratch (auth first with
`npx wrangler login`, or `export CLOUDFLARE_API_TOKEN=<token>`):

```bash
npx wrangler pages project create luminastream-studio --production-branch main
# Build with the API base from an env var — never commit the literal:
VITE_API_BASE="$(gh variable get VITE_API_BASE)" npm run build
npx wrangler pages deploy dist --project-name=luminastream-studio --branch=main
```

The project name is **load-bearing**: the Worker's CORS allowlist hardcodes
`PAGES_PROJECT = 'luminastream-studio'` (see `workers/api/src/cors.js`), so any
other name silently breaks preview-deploy CORS.

### Verify a deploy

```bash
scripts/check-live.sh
```

One PASS/FAIL line per layer — Worker `/api/health`, the Pages root, and
`/livekit-test` (which must serve the app shell via SPA fallback, **not** JSON) —
with a nonzero exit if any layer is down. This is the instrument the original
incident lacked: a "frontend deployed anywhere?" answer in one command. Override
the targets with `WORKER_URL=` / `PAGES_URL=` to smoke-test the custom domain or
staging.

### Why /livekit-test works deployed

The build emits no top-level `404.html`, so Pages serves the app in SPA mode:
every unmatched path (e.g. a hard refresh on `/livekit-test`) returns
`index.html` and React Router takes over — identical to the Vite dev server. No
`_redirects` file or Pages Function is needed. The page itself stays serverless:
generate a token locally with `node scripts/generate-livekit-token.js` and paste
it in, same as on localhost. No secret is ever part of the deployment. Because
`VITE_API_BASE` points at the Worker, `/livekit-test` also gains a **Mint via
server** button (password → server-minted token), the production path.

### Remaining human steps (deliberate walls)

Two things stay manual on purpose — each changes account-level permissions or
public DNS, which are human acts, never a merge side effect.

**1. Token permission (one-time — already done).** The Cloudflare API token in
GitHub Actions (`CLOUDFLARE_API_TOKEN`) needs **Account · Cloudflare Pages ·
Edit** on top of the Workers scopes it already carried. Dash → **My Profile →
API Tokens →** edit the token → **Add** the **Cloudflare Pages : Edit**
permission → **Continue** → **Save**. CI never edits its own permissions.

**2. Move the custom domain from the Worker to Pages (one-time).**
`studio.luminastream.live` is currently attached to the **Worker**
(`luminastream-api`) and serves API JSON at its root. Move it to the Pages
project:

- **Detach from the Worker:** Dash → **Workers & Pages** → `luminastream-api` →
  **Settings → Domains & Routes** → the `studio.luminastream.live` row →
  **Remove**.
- **Attach to Pages:** open the `luminastream-studio` project → **Custom
  domains** → **Set up a domain** → enter `studio.luminastream.live` →
  **Continue** → **Activate domain**. If the `luminastream.live` zone lives in
  this account, Cloudflare updates the CNAME for you; otherwise create
  `CNAME  studio  luminastream-studio.pages.dev` at your DNS provider.

Until this move, the site is live and fully functional at
`luminastream-studio.pages.dev`, and `studio.luminastream.live` keeps serving
the Worker. Verify the cutover with
`PAGES_URL=https://studio.luminastream.live scripts/check-live.sh`. DNS stays a
human act by doctrine — the CI token intentionally has no DNS scope.

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

Put the values in the gitignored `secrets.env` at the repo root:
`ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`, `LIVEKIT_API_KEY`,
`LIVEKIT_API_SECRET`, `LIVEKIT_URL`. Generate the session secret with:

```bash
openssl rand -base64 32
```

and set it in `secrets.env` as `ADMIN_SESSION_SECRET=<that output>` (create the
line for first setup; replace it to rotate). Then push the secrets to
Cloudflare:

```bash
npx wrangler login                          # or: export CLOUDFLARE_API_TOKEN=<token>
scripts/put-worker-secrets.sh staging       # set them on the staging Worker
scripts/put-worker-secrets.sh production     # and on the production Worker
```

The script pipes each value straight from `secrets.env` into
`wrangler secret put` over stdin — **no value is ever printed** or written to a
tracked file. Re-run it to rotate. Live logs: `npm run tail` (staging) or
`npx wrangler tail` (production), from `workers/api`.

> **Kill switch.** Rotating `ADMIN_SESSION_SECRET` (put a fresh
> `openssl rand -base64 32` value in `secrets.env`, replacing the old line, and
> re-run the script) **instantly invalidates every outstanding admin session**:
> the Worker verifies each session token's HMAC against this secret, so changing
> it makes all previously issued tokens fail closed and forces re-login. Wrangler
> applies the new secret on the next request — no redeploy needed.

Verify a deploy:

```bash
curl https://luminastream-api-staging.<account>.workers.dev/api/health
curl https://luminastream-api.<account>.workers.dev/api/health
# → {"ok":true,"version":"0.1.0"}
```

### Point the frontend at the Worker

`VITE_API_BASE` is a GitHub Actions **repository variable** (repo → **Settings →
Secrets and variables → Actions → Variables**), set to the production Worker URL
(no trailing slash — it is normalized). The Pages workflow bakes it into the
bundle at build time, so a push to `main` — or a **Re-run** of the latest run —
applies a change. With it set, `/livekit-test` shows the **Mint via server**
path; unsetting it now *fails the Pages deploy guard* rather than silently
shipping a frontend with a blank API base.

### Custom domain (`api.luminastream.live`) — a deliberate human step

DNS is **not** automated and the CI token intentionally has **no DNS scope**.
Pointing a custom domain changes public DNS — rare and sensitive — so it stays
a manual act: in the dashboard open the Worker → **Settings → Domains & Routes →
Add** → `api.luminastream.live`, then update the `VITE_API_BASE` GitHub Actions
variable to `https://api.luminastream.live` and re-run the Pages workflow. CORS
keys off the browser's Origin (the studio site), not the API host, so either the
`workers.dev` URL or the custom domain works.

### Local development

```bash
cd workers/api
cp .dev.vars.example .dev.vars   # fill in real values — .dev.vars is gitignored
npx wrangler dev                 # → http://localhost:8787
npm test                         # node --test (offline, no secrets)
```

## Voice Agent (VPS) — pull-based deploy

The VPS was the last hand-driven surface. Every merge touching `agent/` needed
someone to remember to SSH in and pull, and the failure mode was **silent**: the
box quietly ran stale code while a fix appeared to have shipped. That cost a
full session of wrong conclusions once.

### Why pull and not push

The box checks the repo itself on a timer. GitHub never reaches in.

| | Push (CI opens a shell) | **Pull (box checks)** |
| --- | --- | --- |
| Credential | private SSH key **with login as `lumina`**, held by CI | **none** — the repo is public, so `git fetch` is anonymous |
| Blast radius if leaked | total: that key owns `secrets.env` | no key exists to leak |
| Inbound access | CI can open a shell on production | nothing reaches in |
| If GitHub is down | no deploys | deploys still work |

If the repo ever goes private this needs a **read-only** deploy key on the box —
still outbound-only, still unable to log in. A push key can always log in.

### The procedure

[`scripts/deploy-agent.sh`](scripts/deploy-agent.sh), run identically by the
timer, by a human, or by hand. **The ordering is the safety property:**

1. `git fetch`; stop immediately if `origin/main` has not moved.
2. `git pull --ff-only` — a diverged checkout stops the deploy, never merges on production.
3. **Build a *new* venv for this release.** The live agent's venv is never touched, so a half-finished `pip install` cannot poison a running process.
4. **Preflight the new build in a throwaway LiveKit room** (`--room preflight-$$ --identity echo-preflight-$$`). The default room and identity would collide with the live agent — LiveKit evicts on duplicate identity, so a careless preflight would kick the very agent it exists to protect.
5. Only if `STT READY` / `TTS READY` / `PREFLIGHT OK` all appear: swap the venv symlink (atomic rename) and `systemctl --user restart`.
6. Verify the new agent cleared the same gates in the journal; report loudly if not.

The live agent serves untouched through steps 1–4. A failure before step 5
leaves it running on the old code **and** the old venv.

### Freeze, and deploy on demand

```bash
touch ~/luminastreamv1/agent/.deploy-hold      # block swaps during a drill
rm    ~/luminastreamv1/agent/.deploy-hold      # unblock
bash  ~/luminastreamv1/scripts/deploy-agent.sh # deploy now
cat   ~/luminastreamv1/agent/.deploy-state     # what happened, and when
```

With the hold file present, code and the new venv are still built **and
verified** — only the swap is skipped, and the deploy says so rather than
pretending it succeeded.

### One-time setup on the box

```bash
mkdir -p ~/.config/systemd/user
cp ~/luminastreamv1/scripts/systemd/lumina-agent.service   ~/.config/systemd/user/
cp ~/luminastreamv1/scripts/systemd/lumina-deploy.service  ~/.config/systemd/user/
cp ~/luminastreamv1/scripts/systemd/lumina-deploy.timer    ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now lumina-agent.service
systemctl --user enable --now lumina-deploy.timer

# Survive logout and start at boot (the one command needing sudo):
sudo loginctl enable-linger lumina
```

User services, so no root and no sudoers rule for the restart. `enable-linger`
is what makes them start at boot rather than at login.

### Tests

```bash
bash scripts/test-deploy-agent.sh
```

Runs the real deploy script against a throwaway repo and a stub python — no
VPS, no network, no systemd. It pins the properties that matter: a failed
preflight swaps nothing, the hold file blocks the swap, `--poll` is silent when
nothing changed, a legacy `.venv` directory is migrated rather than deleted, and
statically that no restart can precede the gates.
