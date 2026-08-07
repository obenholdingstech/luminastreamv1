# LuminaStream — Session Log

Full session records, **newest at top**. Terse handover summaries live in `notes.md`.

---

## 7 August 2026 (night) — VERIFICATION + GOOGLE + THE THREE SURFACES

**Task (CEO, verbatim key parts):** "secrets.env is fully populated ... I hit a local terminal path error ... Please execute scripts/put-worker-secrets.sh production on your end ... push a basic visual flow: luminastream.live: A clean, basic 'Coming Soon' hero card with a 'Get Started' button. account.luminastream.live: ... the auth UI. studio.luminastream.live: Successfully signing in routes the user into the locked studio. ... ensure that no one can just type in accounts.lumina...., without passing through the arranged order ... the domain for zeptomail api is obenholding.org"

### The secrets handoff (and one gap)
Local wrangler cannot authenticate to her Cloudflare account (10000), so the four present secrets (ADMIN_EMAILS, GOOGLE_CLIENT_ID/SECRET, ZEPTOMAIL_TOKEN) were mirrored into GitHub encrypted secrets through pipes — values never printed — and a manual `push-auth-secrets` workflow puts them on the production Worker with the CI deploy token. Scope deliberately narrow: the five human-set secrets (LiveKit/admin) are NOT in CI, per the standing rule. **Gap for the CEO: TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY are NOT in secrets.env** despite the message — the Turnstile wall is built env-gated and switches on when they arrive.

### Server (env-gated, all dormant until the workflow runs)
- **Email verification**: ZeptoMail sender as `noreply@obenholding.org`; sign-up mints a one-shot 24h token (hashed at rest) and mails the link; `GET /api/auth/verify` is read-and-burn (the row deletes whether or not valid — no replay) and lands on `account./?verify=ok|expired|invalid`; `POST /api/auth/resend-verification` rate-limited. Mail failure never kills sign-up.
- **Turnstile at sign-up**: server-side siteverify, enforced only when the secret exists, FAIL-CLOSED when the challenge cannot be verified (a broken bot wall is not an open door).
- **Google OAuth**: `GET /api/auth/google` (state cookie, SameSite=Lax, 10min) → `callback`: confidential-client code exchange directly with Google over TLS (which is what makes payload iss/aud/exp/email_verified checks sufficient without JWKS), identity keyed on Google's stable `sub` never the email, **no auto-link to password accounts** (silent merges are how takeovers hide inside conveniences — linking is an explicit P8 operation), session cookie → 302 studio.
- `GET /api/auth/config` serves only by-design-public values (googleEnabled, emailEnabled, turnstileSiteKey). `videoGate` gains the same two doors as the session gate — a signed-in user must not have voice but no face.

### The three surfaces (one deploy, hostname-routed)
`surfaceForHost` (pure, tested): apex/www → **Landing** (coming-soon hero, Get Started → account.), account. → **Account** (AccountPanel + Google button + verification status/resend), everything else → **Studio**. The studio LOCKDOWN: on the canonical studio hostname a signed-out visitor is `location.replace`d to account. — the arranged order holds even for a typed URL — while previews/localhost keep the working surface and `?ops` preserves the probes' key flow (both e2e specs updated). Signed-in Start: one button, no password — the cookie is the authority (`openSession` grew the cookie path; `postJson` now sends credentials on every call).

### Verification
301 lib tests + 205 worker tests green; lint/typecheck/build clean. Post-merge: dispatch the secrets workflow, then live-verify the arranged order end-to-end on the real domains.

---

## 7 August 2026 (later) — THE REALIGNMENT: identity carries authority

**Task (CEO, verbatim key parts):** "studio.luminastream.live ... must not be open to unauthenticated users ... luminastream.live should be our public hero/marketing page, authentication/login should live on ... account.luminastream.live ... we are officially retiring and removing the old dev admin-password gate, that way i create an account as admin and that particular account gets admin priviledges. ... I will drop the required [Google] credentials into our secrets file ... Every user must verify their email. ... Confirm that our IP/pair-key rate limiters strictly protect account creation ... a dedicated phase (aligning with our P7 design scope) [for] UI/UX flow polishing, domain remapping ..."

### Server core shipped this arc (branch `feat/realignment-roles-user-sessions`)
- **Migration 0003**: `users.role` ('user'|'admin', CHECK-constrained) + `email_verifications` (one-shot tokens, HASHED at rest — a leaked table must never yield a clickable link; the subject column pins verification to the email it was SENT to).
- **`ADMIN_EMAILS` bootstrap**: sign-in/sign-up on a listed email promotes to admin. Env-only — the public repo never names an admin; empty/absent grants nobody (tested both ways, case-insensitive).
- **ONE user-session resolver** (`userSession.js`) shared by the auth routes and the session gate — two resolvers would eventually disagree about expiry or suspension, and an auth disagreement is a security bug wearing a race's clothes.
- **The session gate's two doors**: a signed-in user who may start (admin role OR any verified identity) passes FIRST; the admin token survives for OPS TOOLING ONLY (probes, drills — non-browser clients that hold no cookies). Signed-in-but-unverified gets its own refusal (`verification_required`, 403) so the UI says "verify your email", never "sign in". During the dev window (no mail sender yet) exactly the ADMIN_EMAILS accounts pass — the same wall the retired password provided, now attached to real identity.
- **`put-worker-secrets.sh`** learns the optional names (`ADMIN_EMAILS`, `GOOGLE_CLIENT_ID/SECRET`, `ZEPTOMAIL_TOKEN`) — present ⇒ set, absent ⇒ skipped loudly, and the required five stay all-or-nothing.
- 7 new tests (203 worker total): both doors, the verification wall, bootstrap promote/deny/empty, me() exposing role+verified.

### Scheduling answers given to the CEO
- **Email verification**: NOT tail-of-P4 — it ships in this arc, via ZeptoMail (her account; one `ZEPTOMAIL_TOKEN` in secrets.env + the script). Schema is already live; sender + verify endpoints + the sign-up email go in behind the token's presence. Cloudflare could send too, but her existing ZeptoMail account is one secret away.
- **Google OAuth**: code lands env-gated; activates the moment `GOOGLE_CLIENT_ID/SECRET` arrive via her script run + the redirect URI added in her console.
- **Sign-up limits confirmed and honest**: signup is per-IP (10/60, fail-closed) — the pair-key applies to sign-IN. Against DISTRIBUTED signup bots the real walls are email verification (this arc) + Turnstile at signup (recommended; a widget mint is her dashboard action) — noted, not yet wired.
- **Routing**: apex hero / account. auth / studio. locked — hostname-routed in the one Pages app; visual polish of those transitions is P7's now-explicit scope. DNS attaches (apex + account.) are her two clicks.

---

## 7 August 2026 — P4b-ui: the lens learns who you are; the custom domain lands

**Task (CEO, verbatim key parts):** "lets go ahead and build the p4b-ui, but before that i wanted to play you a video of a guy whos an elite developer ... from his video we can pick up more tips to optimixe our apps performance ... explain to me what we need or what you have decided" — plus screenshots showing `api.luminastream.live` attached to the Worker (her DNS wall, done).

### The outage epilogue (from 6 Aug, for the record)
PR #85's merge waited out a ~4-hour GitHub MAJOR platform outage (runners failed at `Failed to resolve action download info: Service Unavailable` — before any repo code ran; 196 worker tests green locally throughout). One trap caught mid-outage: the checks API briefly rendered an EMPTY list, which a naive grep read as "all passing" — doctrine 27's shape (a check that didn't render has not passed); the merge waited for five real passes on a fresh run. Post-recovery: merged, migration `0002_auth_sessions ✅` applied, live smoke on production verified all four walls (401 bare /me; 400 password policy; 403 foreign origin; uniform 401 unknown-account).

### The performance transcript, mapped honestly onto THIS stack
1. **Connection pooling** — not applicable by architecture: D1 and Durable Objects have no client-managed connections to pool. Our version of the same failure class ("per-request cost that scales with load") is the DO O(1) invariant — already doctrine, already mutation-tested (§P1's oracle).
2. **Caching layer** — planned exactly where it pays: the hot paths are VENDOR-bound (ElevenLabs, Decart), not DB-bound; the standing scale directive already says cache static vendor metadata with explicit TTLs. No cache added for auth/session paths — 3–5 indexed D1 reads per session need no cache, and caching auth answers is how stale sessions outlive revocation.
3. **Load testing** — genuinely applicable, and already a NAMED launch gate (PL: "a load test at several multiples of expected launch concurrency"), plus the concurrent-CPU drill that holds the pool ≤6. The honest bottleneck story: 50 signups cannot lock this database — the first wall they'd hit is agent capacity (an honest refusal), which is precisely what the PL elasticity gate exists to remove.

### What shipped (branch `feat/p4b-ui-accounts`)
- **`src/lib/authClient.js`** (+4 tests): credentialed fetch client — every call `credentials:'include'` (the session is an HttpOnly cookie the page never sees), ONE machine-token→prose table (tests caught a real bug: `null ?? fallback` gave the deliberately-silent `unauthenticated` token words — replaced with key-presence lookup), network failures resolve to results, never throws.
- **`src/hooks/useAuth.js`**: checking → signedOut → signedIn machine; no wrong-state flashes; fire-and-forget profile saves (identity autosave must never block the lens).
- **`src/components/AccountPanel.jsx`**: sign-in / create-account card on the access screen (admin key stays as the dev gate; the account is what makes the lens REMEMBER), signed-in chip with sign-out.
- **Studio**: saved identity applies ONCE per sign-in (voice, style prompt, sync trim — server truth lands on the local knobs, then the knobs are the truth again); debounced autosave with a baseline guard so the applied profile is never echoed straight back.
- **`VITE_API_BASE` → `https://api.luminastream.live`** (repo variable): first-party cookies — Safari sign-in works. Health-checked live.

### Verification
300 lib tests green; lint/typecheck/build clean; account panel screenshot-verified on the local build; api.luminastream.live `/api/health` 200 live.

---

## 6 August 2026 (late night) — P4b: AUTH — enterprise walls, one PR

**Task (CEO, verbatim key parts):** "okay lets go ahead with the p4b and so on, you have the road map lets keep working and having in my this is enterprice grade and use the best secure systems and build a solid saas"

### What shipped (branch `feat/p4b-auth`)
Email+password auth on the Worker — signup / signin / signout / me / profile — with every enterprise commitment written where it lives:

- **Passwords**: PBKDF2-SHA384, 100k iterations, per-hash salt, **versioned storage format** (`pbkdf2-sha384$v1$…`) — strengthening the KDF later is a rehash-on-next-signin (implemented and tested), never a password reset. NIST-style policy: length over composition, 10–200 chars.
- **Sessions**: 256-bit random tokens in an **HttpOnly Secure cookie**; the database stores only the SHA-256 (migration `0002_auth_sessions`) — a database leak yields nothing a browser can present. 14-day expiry, hourly-throttled last_seen, revocation = DELETE (P8's "sign out everywhere" is one query).
- **CSRF**: cookie-authed state changes reject any PRESENT Origin not on the allowlist; absent Origin (curl, native) is fine — those clients never auto-attach a victim's cookie. CORS gains `Allow-Credentials` with the exact-origin echo it always had.
- **Enumeration & stuffing**: sign-in answers `invalid_credentials` uniformly, and the missing-account path burns the SAME KDF time against a dummy hash; sign-in burns TWO limiter keys (per-IP and per-account) so a distributed guess against one account trips as fast as one machine. New `AUTH_LIMITER` (10/60), fail-closed like every guard: missing binding = 503, tested.
- **Profile**: `PUT /api/me/profile` clamps everything and **refuses client-supplied `avatar_key`** — the upload path (P4c) sets it after bytes actually land in R2; a client that could name its own key could name someone else's.
- Data layer additions ride the same injected-clock discipline; auth routes get the Worker's own helpers injected (`createAuthRoutes(kit)`) so the whole surface tests end-to-end through `worker.fetch` with a fake env.

### Tests
19 new (auth core unit + full route drive-through: cookie flows, uniform 401s, dual limiter keys, rehash-on-signin, fail-closed 503/429/403, avatar-key refusal). **196 worker tests green.**

### The two CEO doors this opens (ROADMAP §6)
1. **`api.luminastream.live` custom domain** (DNS wall): auth cookies are cross-site until the API shares the site with the studio — Chrome tolerates it, Safari does not. One CNAME + Worker custom-domain attach makes every browser first-party.
2. **Google OAuth client + Apple Services ID** when she's ready — the schema already holds those providers as rows.

### Next
P4b-ui (the lens learns sign-in/sign-up and loads the saved identity at Start), then P4c (R2 avatar + ElevenLabs voice clone), P4d (session history live).

---

## 6 August 2026 (night) — P4 OPENS: identity & persistence; P4a foundation built

**Task (CEO, verbatim key parts):** "so whats next in line now, what are we building next according to the roadmap, you know am trusting you with this ... lets keep momentum going" — and, on the sign-in question: "email and password, goggle sign in, apple sign in, thats it"

### The phase
P4 — the database phase, next by dependency (billing needs an account to charge; admin needs a person to look up; the native app wants an account to sign into). Sign-in surface decided: **email+password, Google, Apple**. Password ships first; the OAuth pair follows behind CEO-minted credentials (Google Cloud console; Apple Services ID once the P6 enrolment completes — the workstreams converge). Apple enrolment already running since 2 Aug.

### P4a — built this session
- **`workers/api/migrations/0001_identity.sql`**: `users` (with a `status` column NOW so P8 suspension is a WHERE clause, not a migration), `auth_identities` (providers as ROWS, unique(provider, subject), OAuth stores the stable subject never the email), `lens_profiles` (voice/avatar-key/prompt/sync-trim — localStorage graduates), `session_history` (machine-written, vendor summaries VERBATIM per the P2c trust boundary). UUIDs minted in the Worker, unix-seconds timestamps, no AUTOINCREMENT.
- **`src/db.js`**: thin, enumerable data layer — injected ids/clocks (tests own time), user+first-identity atomic via batch, `findIdentity` joins the suspension check so a suspended user resolves like a missing one (one failure path, no oracle), profile upsert COALESCEs so a voice change never erases an avatar.
- **`testkit/fakeD1.js` + `test/db.test.js`**: query-composition tests (6) — batches, binds, the no-second-clock rule (`SQL mints no time of its own`). Worker suite 175 green.
- **`.github/workflows/provision-d1.yml`** (manual): creates `luminastream-identity` + `-staging`, prints ids. Deliberately does NOT apply migrations or touch bindings — `d1 migrations apply` resolves through wrangler.jsonc, and the binding lands only in the follow-up PR once the databases exist. A deploy never references a binding before the thing behind it does.
- ROADMAP: P4 marked OPENED with the sign-in decision and the P4a–d plan.

### Next
Merge → run the provision workflow (if the CI token lacks D1 scope it 403s → one-time token-permission edit, CEO's hands) → follow-up PR: bindings + ids + migrations-apply in the deploy workflow → P4b auth.

---

## 6 August 2026 (later) — SPEND GOVERNOR TO DEV-UNLIMITED (CEO directive)

**Task (CEO, verbatim key parts):** "Everything is working as expected, but the Spain governor. that was on first on the speech to text text to speech side. It prevents me... from not hearing the converted voice. So I want you to remove that spend governor entirely for this development process. that way i can be able to test freely as long as am logged in"

### What was happening
The agent's per-run budgets (5,000 TTS chars / 300 STT seconds) are small against a real testing session; once exhausted, every reservation is refused and — per doctrine 21, never truncate an utterance — the WHOLE utterance is abandoned. To her ear: the converted voice goes silent mid-drill.

### What changed — the numbers, never the machinery
"Remove entirely" implemented as **DEV-UNLIMITED defaults** rather than deletion: `DEFAULT_MAX_TTS_CHARS = 1e9`, `DEFAULT_MAX_STT_SECONDS = 1e8` (named `DEV_UNLIMITED_*`, with the old bounded numbers preserved in the comment for re-arming). Everything doctrine 22 built stays armed — reserve-then-call, refusal arithmetic, env-only ceilings, fatal-on-malformed env — and env overrides can LOWER the caps without a deploy if a bounded posture is ever wanted again. The startup line now announces the posture as a WARNING ("SPEND GOVERNOR: DEV-UNLIMITED") — an unlimited governor that logs like a bounded one is how a dev setting survives into a launch unnoticed. The knobs registry fallback ceiling follows. P5 wallets re-arm real per-user numbers; that phase is where this posture dies.

### Guardrails that remain
The lens stays behind the admin gate (free spend is reachable only logged-in); systemd's StartLimitBurst still stops a crash loop from burning warm-up synthesis all night; the VIDEO SpendLedger is untouched (she named the speech side only). Spend is now bounded by the ElevenLabs account itself — her explicit call as spend authority.

### Verification
`agent/` pytest: **224 passed** (defaults re-pinned at the new values so a silent change is a red test, not a mid-drill surprise). VPS picks the change up via the pull-based deploy (~2 min after merge), restarts through the health-gated deploy script; the journal will show the DEV-UNLIMITED warning at startup.

---

## 6 August 2026 — THE LOCK-IN: 30fps target, raw passthrough (CEO verdicts)

**Task (CEO, verbatim key parts):** "i like the motion but ... that sixty FPS target was too much because he's making the motion look buttery smooth. And due to the fact that not the whole pixels are on the details of the screen the motion of the avatar is looking somehow so i think leaving it at 30 fps will be best then for the passthrough i noticed that theres a jumpscene that tries to match my voice, what if we make the passthrough to be raw, that means the raw stream from decart doesnt go through any piplines ... without being delayed or upscaled ... after this we can then lock in and move ahead with other areas of the project"

### Verdict 1 — 30fps, as a TARGET RATE (not a multiplier)
57fps was overshoot: buttery smoothness on an avatar whose detail does not fill every pixel reads uncanny. Native ~19fps has no integer factor landing on 30, so the ×factor scheme was replaced with a **grid resampler**: output frames on a fixed 1000/30ms grid, each synthesized at fractional t between the bracketing real pair, with a real frame SNAPPED (emitted as-is) when a tick lands within 8ms of it — never a synthetic copy of a frame the vendor just delivered. A real frame the grid passes over is dropped and closed (true resampling). Budgets recomputed: 20ms both tiers (1000/30 × 0.6) — dropping the rate made motion cheaper to grant, more hardware qualifies. Both tiers now differ only in HOW a frame is made, never how many. `synthCapability.js` (SYNTH_TARGET_FPS=30), `frameSynthesis.js` (grid cursor, snap, drop-and-close), `synthStage.js` (targetFps controller); tests rewritten to grid assertions (resample-away case, grid restart on discontinuity, snapped-reals-don't-sample) — 296 green.

### Verdict 2 — passthrough is RAW
The "jumpscene" was the sync machinery holding streams to match the voice. Direct mode now presents **the vendor's stream exactly as it arrives**: `useLensVideo` retains `rawStream` beside the processed one; Studio derives `presentedStream` per confirmed mode and points the transformed element, clean view, transformedReady, and the fps meter at it. The readout claims vendor truth only in raw mode — `720p · Nfps · raw passthrough`, no upscale/synth/hold labels — and the sync-trim hides (nothing to trim on a raw stream). The Direct-mode audio delay line (useAudioAlign) is **disengaged entirely** — built, tested, kept in the codebase for the native shell, wired to nothing. Zero added latency IS passthrough's product truth. The laggard-is-master-clock doctrine now governs Converted only (ROADMAP amended).

### Locked
ROADMAP v2.6: P3 fully closed — 50fps retired as overshoot (not failure) by CEO verdict; 30fps grid is the shipped standard; Direct-mode rawness is a product decision. §6's fps/trim action row retired. The project moves to other areas.

### Verification
Lint / typecheck / **296** lib tests / build green; post-merge deploy watch + render probe + check-live.

---

## 5 August 2026 (later) — SYNTHESIS PROVEN LIVE; and an incident honestly mis-attributed for one hour

### The incident, in the order it actually happened
1. #78 merged and deployed green. The post-deploy render probe FAILED — "the transformed \<video\> must be decoding frames" — deterministically, headless AND headed on real GPU. Read as: the new pipeline stage broke production. **Revert PR #79 opened** per the never-break-production rule.
2. While #79 sat in review, the instrumented debug run (page console + failing-response capture against production) found the truth: `POST /api/video/session` → **502 `vendor_session_failed`** — the WORKER's create call to Decart failing server-side, both video layers null because the video leg never started. The exoneration rests on two specific grounds, not a blanket axiom: #78 touches only the RECEIVING stream after `ontrack` and never the offer/create path this failure lives in; and the identical path later recovered with no code change on either side. **#78 exonerated.**
3. Wrangler tail was a dead end (local login is a different Cloudflare account — the Worker deploys via CI's token; dashboard forensics are the CEO's wall). ~1 hour after onset, the identical request path recovered with no code change on either side: transient vendor-side create failures.
4. Post-recovery, with #78 still deployed: **RENDER PROBE PASS — delivering 1920px wide, billed 5s** — and the evidence frame shows the tier ladder LIVE: **"1080P · 21FPS · SYNTHESIZED · BLEND · VIDEO HELD 0.0S"**. The GPU-less headless probe machine was granted exactly the mid tier the directive prescribes (motion correctly withheld — no WebGPU; blend built + benched under budget). First real-world proof the capability probe grades hardware honestly.
5. **#79 closed UNMERGED** with the evidence. Nothing was reverted.

### Lessons, named
- **Correlation with a deploy is not causation by the deploy.** The one probe was gating two failure domains (our pipeline AND the vendor leg), and a vendor outage landing minutes after a merge wore the merge's face. The tell I initially missed: the failure screenshot's state was consistent with NO stream at all, not a broken transform.
- The 4 Aug legibility arc's lesson inverted: there the probe's evidence frame caught what assertions missed; here the assertion fired for a cause outside the code under test. **A failing probe names a SYMPTOM; the diagnosis still has to be earned** — the revert-first reflex was correct under uncertainty, and closing it unmerged once evidence arrived was equally correct.
- Also swept up: the dev-budget bank had drained to 29s (the probe's own preflight wall caught it — working as designed); ledger reset to 0/3000 via the admin API before the re-runs. Post-run balance: **5s spent, 2995s remaining, zero open reservations.**

### Where synthesis stands
Live on production, all three tiers reachable, governor armed. The blend tier is proven end-to-end by the probe. The motion tier's first real grant happens on hardware with WebGPU — the CEO's session readout is the instrument: her fidelity line will name her tier and her fps.

---

## 5 August 2026 — ADAPTIVE FRAME SYNTHESIS: the tier ladder, built to the directive

**Task (CEO, verbatim key parts):** "Client-Side Synthesis Directive: Multi-Tier Adaptive Scaling ... We cannot assume every user will be on high-end hardware ... Device Capability Benchmark ... High-End: full WebGPU motion-compensated interpolation (50fps target). Mid-Range: fall back to lightweight midpoint blending. Low-End/Unsupported: bypass synthesis entirely ... Our rule remains: A/V Sync and low latency take precedence over frame synthesis. Proceed with the build using this progressive fallback model."

*(Context from the GPU drill that decided this direction — full record on branch `drill/gpu-interpolation`: RIFE-class synthesis measured 7–15ms on a discrete GPU while the network charged ~1.2s to reach it; client-side won on physics, ~$0.19 spent, both pods verified terminated.)*

### What was built (branch `feat/adaptive-frame-synthesis`)
The pipeline's canon order grew a stage: **receive → align → synthesize → upscale → present**. Position chosen twice over: AFTER align so the elastic queue holds native-rate frames (multiplying first would shrink the 150-frame queue below the 4s elastic ceiling), BEFORE upscale so synthesis runs at 720p — half the pixels of 1080p.

- **`synthCapability.js`** — the policy core, pure. `decideSynthTier`: a tier is granted only on PROOF (renderer built AND benched inside budget — budgets are 60% of the output frame interval, headroom for upscale/page/encode). `createSynthGovernor`: strike-counting demotion — sustained overload demotes, a lone GC spike never does (good frames pay strikes down). No runtime promotion, by design. **The test suite caught a real inversion during the build:** `demotedTier('nonsense')` would have PROMOTED unknown tiers to motion via indexOf's −1 wrapping to index 0 — exactly the fail-open shape doctrine 26 exists for; fixed and pinned.
- **`frameSynthesis.js`** — the mechanism: insertable-streams loop holding a pair-state clone (a written frame is transferred), emitting intermediates with correct interleaved timestamps and paced writes. Mode is LIVE-SWITCHABLE ({factor, renderer} read per iteration) so verdicts and demotions land mid-stream without rewrapping. Discontinuity guard (gap outside 10–250ms restarts the pair — never smear across a stall). A throwing renderer forwards the real frame and reports; the stream never dies for a shader.
- **`blendRenderer.js`** — mid tier: one WebGL2 pass, `mix(A,B,t)`, 19→38fps.
- **`motionRenderer.js`** — top tier, WebGPU, three passes: ¼-res luma downsample → full-search ±7 block match per 16-luma-px tile (zero-motion bias against junk vectors) → motion-warped blend whose occlusion fallback degrades DISAGREEING pixels to plain crossfade (a wrong vector must cost blend-quality, never smearing). 19→57fps. Upload + motion search run once per PAIR (keyed on frame identity), the warp once per intermediate.
- **`synthProbe.js`** — the session-start benchmark the directive ordered: builds each renderer, times 12 real synthesize calls on gradient frames (flush-gated, medians after warmup), grants the best tier that fits. Keeps the built renderers — demotion needs blend standing by.
- **`synthStage.js`** — policy wiring: adopt (late verdicts switch on live), demote ladder motion→blend→off disposing each loser, per-tier governors, honest `tier`/`label`/`active`.
- Wiring: probe fires at first `start()` (never for an idle tab); readout gains `· synthesized · motion` / `· synthesized · blend` — the LABEL is the stage's claim, the fps NUMBER stays the meter's measurement, kept separate so disagreement is diagnosis.

### Sync precedence, mechanically
The rule is enforced three ways, not hoped: budgets grant tiers from measurement; governors revoke them under sustained load; renderer failure demotes on the spot with the real frame already forwarded. 'off' is a floor that cannot fail. Latency price when synthesizing: (factor−1)/factor of one frame interval (~35ms at ×3) — absorbed by the same trim/elastic machinery as every video-path cost.

### Verification
21 new tests (293 total, all green); lint (exhaustive-deps caught a missing dep in my own hook wiring — the #62 gate paying for itself), typecheck, build green. Live tier proof on real hardware: the CEO's next session readout.

---

## 4 August 2026 (evening drill) — the CEO's screenshots ANSWER the two open questions; the chrome fails legibility over a bright wall; the interpolation mandate

**Task (CEO, verbatim key parts):** "I cannot see the live FPS or the trim value controls on the UI during a live session. I performed a hard refresh to clear my cache, but the 'lips earlier/later' dial and the FPS fidelity readout are not rendering clearly on the screen. ... Go ahead and rent the external GPU and spin up true motion-compensated interpolation on a test branch. I want to see what happens when we push this to the absolute limit."

### The drill result, logged same-day (rule 2) — and it contains the two numbers §6 was waiting for
Two screenshots, both live Converted sessions against production, 4 Aug ~18:55:

- **Delivered fps: 19** — on BOTH browsers (Chrome and Edge, hardware-accelerated), agreeing with the headless probe's 18. The folklore range ("20–25") is dead: **Lucy delivers ~18–19fps.** This is the number the 50fps work builds from — blending doubles it to ~38; reaching 50+ needs ~×2.6, i.e. true interpolation.
- **Trim: 700ms** (the shipped default, unmoved — she could not read the control well enough to use it, see below).
- Supporting readings: latency 1324/1271ms; one Mouth→Ear sample of 5909ms during a long utterance (structural backlog doing exactly what the physics said); video held 3.0s / 0.8s — the elastic working; 1080p claimed and delivered; budget line visible and counting.
- Protocol note, honestly recorded: one screenshot is Microsoft Edge — drill canon says real Chrome only. No harm here (both browsers agree on every number), but the canon stands.

### The legibility failure — a real bug, root-caused
The controls were rendering; they were **unreadable**. Root cause in the code: the fidelity readout and trim controls wear dark slate text (`#4A5568`, `#64748B`) and near-black borders (`#1A1A2E`) — colors chosen for the dark idle page — floated at 60% opacity over live video, protected only by a dark text-shadow. That shadow is a bet that the scene behind the text is dark; her wall is white and yellow, and the bet lost. Elements with their own dark pill backgrounds (mode toggle, live strip) stayed readable in the same frame — which is the fix, generalized.

### The fix (this PR): the lens-console panel
Every control and readout now lives in ONE `lens-console` wrapper. In cinematic mode the panel carries its own scrim — `rgba(7,9,20,.6)` + 18px backdrop-blur + hairline border — so legibility is independent of what the camera sees. Outside cinematic mode the class is inert (idle page pixel-identical, screenshot-verified). The washed-out rows also got honest colors for a dark ground: readout/trim `#94A3B8`, trim value `#E2E8F0`, borders `#475569`, budget `#7C8AA5`.

### The interpolation mandate — recorded, with the walls it must respect
Her directive: rent the external GPU, spin up true motion-compensated interpolation on a test branch, push to the absolute limit. Accepted as a **drill** (evidence-gathering, not a production commitment — the roadmap's rejection of a GPU server in the production video path stands until evidence overturns it, and the physics prediction is on record: a server hop adds network round-trip + one-frame lookahead ≥ ~100–200ms against the sync just locked at 8.5). Two rails planned: **Rail A** — client-side WebGPU motion-compensated interpolation on her Apple Silicon, zero rental, zero new credentials; **Rail B** — the rented-GPU absolute-limit drill, which requires a GPU-provider account/API key: **credential minting is a human wall — hers.** Claude prepares the full kit; she mints the key.

### Verification
Lint / typecheck / 272 lib tests / build green; idle-page screenshot pre-merge (panel inert); post-deploy render probe + live-layer check after merge.

### INCIDENT (same evening): the panel swallowed the stream — caught by the probe's evidence frame, fixed within the hour
The #75 wrapper had wrapped the `lens-backdrop` block (it sits mid-document-order between the voice column and the control cluster — I never checked). Two invariants broke at once on production: the cinematic recede rule exempts the backdrop by DIRECT-child selector, so wrapped, the stream itself dimmed to 60%; and the panel's `backdrop-filter` creates a **containing block**, so the backdrop's `inset-0` filled the panel instead of the viewport — the live stream rendered inside a 576px box. The probe's assertions PASSED throughout (they check intrinsic pixels, not layout); **the evidence frame caught it** — rule 8 earning its keep against its own author. A first probe run also rendered fully unstyled (CSS 200-OK seconds later; transient edge race right after deploy — re-run styled, noted, not papered over). Fix: the backdrop moved above the wrapper, direct child of `main` again, with the two invariants written into the JSX comment. Absolute positioning + `-z-10` make document order irrelevant to its layout, which is why the move is safe.

---

## 4 August 2026 (close) — SYNC LOCKED AT 8.5/10; roadmap v2.5 + the canonical PDF

**Task (CEO, verbatim key parts):** "Sync Locked at 8.5/10 — Roadmap Update & Next Steps. I decided to test your progress this evening, and I love where we are at. The syncing is good and completely manageable now. I am giving the overall experience an 8.5/10. Let's lock that in for now and move ahead with the project. ... Give me a plain-English breakdown of exactly where we currently stand on the roadmap after these recent architectural upgrades and sync fixes. ... Please update the PDF version of the roadmap to reflect our current reality and send it over. I need an updated, canonical document in front of me so I can review it."

### The score, logged same-day (rule 2)
**8.5/10 overall, CEO, 4 Aug 2026 — locked in.** Her own live test of the deployed #70–#73 arc (trim knob, dual-mode laggard alignment, fps instrument, 1080p upscale). "The syncing is good and completely manageable now." Sub-scores not provided; the trajectory on record: sync 5 → 6.6 → locked at 8.5 overall; clarity 7 → 8.4. Still invited from her drill: the on-screen fps number and the trim value she settled on — both named in ROADMAP §6 as the open CEO actions, because they decide the 50fps approach and the shipped `videoPathMs` default.

### ROADMAP.md v2.4 → v2.5 (this PR)
The document had drifted badly behind the code — it still declared "P2 — NEXT" with P2 two days closed and P3 built, scored, and locked. Per §7's own rule ("when this document and the code disagree, the code is right and this document is a bug"), fixed:

- **§2 rewritten:** P1+P2+P3 shipped; new table rows for Video (white-label topology, 3 DO req/session), Fidelity (720p→1080p client-side), Sync (measured at the ear, laggard doctrine), Score (8.5 locked). "What does not exist yet" is now honest: 50fps synthesis, database, billing, native app.
- **P2 marked ✅ closed 3 Aug** with the shipped ledger→probe→topology→lens arc; the "committed design, not yet implemented" status paragraph — stale since P2c went live — now says implemented.
- **P3 marked ✅ locked 4 Aug at 8.5** with what the arc proved (ear measurement, laggard generalization, calibration-as-knob, honest upscaler, fps instrument) and the one named follow-up: frame synthesis toward 50fps, gated on her measured number.
- **Doctrine 23 amended in place** — "audio is the pacing leg" was converted-mode truth stated as universal law; now "the laggard is the master clock," citing #71. Four new entries under "Earned since v2.4": **30** a mock you invented is a mirror, not a wall (#50); **31** UI state with a lifecycle is a lib with a test (three extractions, each exposing bugs); **32** measure the experience, not the component (#66); **33** an asserted claim must match delivered pixels (#69).
- **§6 refreshed:** `DECART_API_KEY` moved to done (placed 3 Aug, after the wall, as required); new top action — report the on-screen fps + final trim value.

### The PDF (repeatable, not artisanal)
No PDF had ever existed in the repo — "update the PDF" therefore meant "create the pipeline." `scripts/render-roadmap-pdf.mjs`: ROADMAP.md → marked (new devDependency) → styled HTML → Playwright Chromium `page.pdf()` — A4, print styles, versioned footer with page numbers, 19 pages. Output `/ROADMAP.pdf` is **gitignored by design**: it is a rendering of ROADMAP.md, never a second source of truth; the next update is `node scripts/render-roadmap-pdf.mjs`, not a hand-built document. First page verified visually (rule 8) via `sips` render. Delivered copy: `~/Desktop/LuminaStream-Roadmap-v2.5.pdf`.

### Files changed
ROADMAP.md (v2.5), scripts/render-roadmap-pdf.mjs (new), .gitignore (+/ROADMAP.pdf), package.json + package-lock.json (marked devDep), devlog/SESSIONS.md, notes.md.

### Verification
Local ritual (lint, typecheck, `node --test src/lib/*.test.js`, build) green; PDF generated and page 1 screenshot-verified; CodeRabbit review per workflow.

---

## 4 August 2026 (night) — the 6.6/10 drill decoded: calibration, the laggard doctrine, the fps instrument

**Task (CEO):** clarity 8.4/10; sync 6.6/10 — converted audio ~400ms ahead; passthrough "misaligned... feels like the sync logic was designed exclusively for converted mode"; target 50fps; explicit budget green light, "never lose current progress or break production."

### PR #70 — calibration + the trim knob
Her 400ms lead IS the calibration the video-path constant was built to receive: default 300 → **700ms**, and the estimate became a live control — `setVideoPathMs` on the align stage (one normalizer, `clampVideoPathMs`, at every boundary after CodeRabbit caught storage/state divergence), persisted, stepped 100ms per press, labeled by symptom: **"lips earlier" / "lips later"**. The next calibration is a button, not a deploy. CodeRabbit: 2 accepted+confirmed. Merged `dbb820b`.

### PR #71 — Direct mode: THE LAGGARD IS THE MASTER CLOCK
Her passthrough instinct was exactly right — the sync logic WAS converted-only. There audio always lags and video holds; in Direct mode audio returns ~350ms while video costs ~700ms: audio leads, and a video hold can never close a gap on the other side. Doctrine generalized: whichever stream leads takes the hold. Direct now routes the remote voice through a WebAudio delay line targeting (videoPath − mouth→ear), smoothed by its own tighter elastic (100/150/1500). Safety contract tested at the lib level: element path muted ONLY while the context is verifiably running; construction failure never touches the voice; suspension gives it back instantly; per-track volume scoping (a blanket mute would silence an undelayed second publisher); the UI's "audio held" claim follows ENGAGEMENT through a tested reporter, never the controller's wish. CodeRabbit: 3 accepted+confirmed (reporter extraction, track-scoped volume, stable-observer + object-identity sample dedupe — a re-observed sample would bypass the slew). Merged `5cbcde3`.

### PR #72 — the fps instrument
Step one of the 50fps mandate: measure before synthesizing. `fpsMeter.js` (sliding-window rate, null below minFrames — "measuring", never an invented number; backward-clock reset) + `useFpsMeter` (requestVideoFrameCallback feeds at frame rate, publishes at 1Hz so the instrument is not the load it measures). The fidelity line now reads e.g. "1080p · 24fps · video held 1.4s". The synthesis decision (GPU midpoint blend vs motion-compensated interpolation) is made from this number on her screen, not from a guess.

### Post-deploy verification (probe, production)

Corrected probe against the deployed arc: **PASS — delivering 1920px wide, billed 0s**; all 3 layers healthy. The evidence frame carries the first REAL fps measurement: the fidelity line reads **"1080P · 18FPS · VIDEO HELD 0.0s"** with the sync trim (lips later · 700MS · lips earlier) live beside it. 18fps measured under the probe's headless SwiftShader rendering — the CEO's hardware-accelerated Chrome may read differently, which is exactly why the number is now on HER screen. Folklore said "20–25"; the meter says what is true where it runs. The 50fps synthesis stage now has a measured starting point.

### Resources answer (her budget green light)
Nothing rented: both sync fixes and the instrument are client-side. The budget option stays open for true motion interpolation if blended synthesis fails her eye.

---

## 4 August 2026 (later) — the 9/10 sync mandate: measure at the ear; upscale is ours

**Task (CEO):** A/V sync 5/10 ("inconsistent — sometimes the video arrives before the voice, sometimes they land together") → goal 9/10; video clarity 7/10, "not crystal clear... doesn't feel fully upscaled". Assess architecture, implement without breaking production, test everything, flag needed input.

### The assessment (the part that mattered)

The elastic controller (median/deadband/slew — all sound) was fed the agent's `tail_latency_ms`: measured at the agent, from speech END to first sample ENQUEUED. Three dominant terms are invisible to it: (1) **the utterance's own duration** — the converted voice re-speaks the FIRST word `speech_s` later, so a 3s sentence puts video ~3s ahead while the controller targets ~0.7s; (2) **playback backlog** — enqueued ≠ played, structural p95 ≈ 1.9s; (3) **network + jitter buffer**. Short utterances hide all three ("land together"), long ones expose them ("video before voice"). Her 5/10 was this equation, not noise.

Clarity: **Lucy 2.5 is 720p, period** (docs re-verified today; no higher tier exists to buy). Crystal-clear is client-side work in our own pipeline's empty upscale slot.

### PR #66 — the mouth→ear meter (instrument before tuning)

Measure the WHOLE audio path where it is true — the browser hears both ends on ONE clock: local mic onset (mouth) → remote track onset (ear). `audioOnset.js` (hysteresis + hangover + min-duration gate, onset carries the true crossing time), `syncMeter.js` (FIFO pairing, expiry for dropped utterances, echo floor, windowed median), `useSyncMeter` (two micLevelMeter lifecycles), a Mouth→Ear stat in the live strip. Nothing moved the video. CodeRabbit: 4 findings — 3 accepted+confirmed (track selection → `remoteAudioTrack.js` lib, 5th lifecycle-in-component occurrence; `ended`-listener hygiene; mutation-checked reset test), 1 **withdrawn** after the bounds argument (output-stage buffering is tens of ms against a 120ms deadband, partially self-cancelling, absorbed by the calibration constant). Merged `1e9842b`, deploy green.

### PR #67 — the controller eats the measurement

`alignStage.observeTail` → `observeMouthToEar(ms)`: elastic sees measured − `DEFAULT_VIDEO_PATH_MS` (300 — the frames already arrive that late for free; the one knob drill data may move). Retuned for ground truth: window 5, slew 400, **ceiling 4000ms** (mouth→ear exceeds 2s by construction); delayQueue bound 150 frames (~5s @30fps, overflow closes OLDEST — pathology is video jumping forward, never OOM). Fidelity readout states the applied hold ("video held 1.4s"), as render-visible state after CodeRabbit caught the one-measurement-behind read (confirmed ✅). Merged `59bf5b7`, deploy green.

### PR #68 — the upscale slot, filled

`upscaleShaders.js` (WebGL2 GLSL: 9-tap Catmull-Rom bicubic upsample; AMD CAS contrast-adaptive sharpen; flip parity documented and asserted), `glUpscaler.js` (OffscreenCanvas + two-pass FBO renderer, throws where the platform can't deliver), `frameUpscale.js` (insertable-streams loop, inline transform, input closed exactly once, renderer failure = honest passthrough mid-stream too), `upscaleStage.js` (active only when wrap returned a DIFFERENT stream — no claimed resolution without produced pixels). Pipeline: receive → align → upscale → present, both P3 slots now real; readout says **1080p** only when the GPU actually produced it. 11 new tests (252 total).

### Post-deploy verification (probe, production)

First probe run after #68's deploy FAILED on the probe's own stale assertion — it demanded the "720p" readout, and the readout now honestly says **1080p** because the upscaler engaged. The stale assertion was replaced with the honesty rule itself: whatever resolution the fidelity line claims must match the pixels the element decodes. Corrected run: **PASS — delivering 1920px wide, billed 0s** (`fix/probe-fidelity-claim`). Evidence frame updated: cinematic view, 1080p claim, "video held 0.0s" (honest — the fake mic never speaks, so the controller rests at zero), Mouth→Ear stat present. Honest cost note: the two stale-assertion failed runs consumed ~154s of the internal video meter (899s → 745s) before their reservations settled — the probe's own finally-cleanup and the executioner did their jobs; the assertion, not the pipeline, was at fault.

### Where the 9/10 verdict lives now
CEO drill, closed headphones (meter assumes no speaker bleed): watch Mouth→Ear and "video held" converge, judge lips vs voice, report the numbers seen. `DEFAULT_VIDEO_PATH_MS` is the tuning knob her data may move. The inherent physics stands stated: perfect sync to a re-spoken voice means the lens runs seconds behind reality during long sentences — the meter makes that visible instead of mysterious.

---

## 4 August 2026 — Stop that didn't stop (stale-closure spend leak); identity before the meter; the cinematic fade

**Task (CEO, verbatim):** "i just topped up decart, production is working but not working as expected, when i am streaming and i click stop stream, the stream stops but the browser still gives me signal that my camera is still on which doesnt stop till i manually reload the tab, and it seems to me like decart bills me in backround when that is happening. the process of starting stream is bad, when i load the page entering admin password and clicking start stream starts the stream automaticslly without me even preparing and choosing voice/image ref which is bad. i should be able to choose those configs on that same screen am entering admin password so everything loads and syncs ones, then the annimation/transition between when streaming and when not streaming is terrible, the backround transitioning to camera feed when i start stream is terrible because the ui becomes unreadable so work on the ui and transition style so when i click to start stream the backround will slowly fage to my camera feed while its connecting and when it connects and is live everything looks cool"

### PR #62 — fix(studio): Stop now stops the real video leg (P0, live spend leak)

**Root cause.** `Studio.jsx`'s `stop` handler was `useCallback(..., [disconnect, holder])`. Both deps are identity-stable from the FIRST render — which happens before unlock, when `adminToken` is null. The `video` object captured in that closure wraps a negotiator created with no admin token: a negotiator that never started anything. Every press of Stop called that dead negotiator's `stop()`; the real one (created after unlock) kept the camera, the RTCPeerConnection, the SSE stream, and the billed Decart session. Only `pagehide` — tab reload — released it. Camera indicator on after Stop, vendor billing in the background: exactly the report.

**Why lint never caught it:** `react-hooks/exhaustive-deps` was not enabled (only `rules-of-hooks`), and `src/hooks/` was not in eslint's `files` list at all.

**The fix, three layers (the class, not the instance):**
1. `stop` depends on the current `video` leg.
2. Structural invariant: `isOrphanVideoLeg({hasCredentials, videoPhase})` in `unifiedLens.js` — no held audio session ⇒ no video leg, enforced by an effect that closes over the current render by construction. Fail-safe inversion: it names the two phases that must NOT be reaped ('off', 'stopping'); any future phase defaults to reaped.
3. `react-hooks/exhaustive-deps` is now an **error** and `src/hooks/` is linted. Gate mutation-tested: a probe file with the exact bug shape fails lint.

Also deleted the latches' `reset()` API — session identities are server-unique, so a new session re-arms a latch by being new; the manual `autoLatch.reset()` in the old stop handler was one render away from opening a second paid vendor session mid-teardown.

CodeRabbit: 1 actionable (extract the teardown predicate — the lifecycle-in-component doctrine's 4th occurrence), accepted with the fail-safe inversion; confirmed ✅. Merged `b6b19e0`; Pages deploy green.

### PR #63 — feat(studio): identity chosen on the access-key screen

Voice/avatar/prompt were gated on `adminToken`, so the first-ever Start took the user into a billed session they had never configured. All three are local state (manifest list, FileReader data URL, text) — now rendered pre-unlock; one press of "Start the lens" carries the whole identity. Honesty fixes en route: a disabled "choose a voice…" placeholder (the select used to DISPLAY the first list entry while the session would use the agent's default), and the style input speaks two tenses (styles the lens pre-start, restyles live after — accessible name included).

CodeRabbit: 2 actionable + 1 nitpick, all accepted and confirmed ✅ — stored voice ids validated against the list in force (`validChosenVoice`); the video auto-start holds (without consuming the latch) while a FileReader read is in flight, so the promised avatar always rides the first session; phase-aware `aria-label`. Merged `ae00f6a`; deploy green. Evidence: `devlog/evidence/identity-before-unlock.png`.

### PR #64 — feat(studio): the cinematic fade

The transition is now the product moment the CEO asked for: on Start the page fades slowly (1.6s) toward the person's own camera — dimmed, desaturated, honest about "materializing" — while the vendor leg negotiates; when the transformed stream goes live the two layers crossfade and the frame gently settles (scale 1.03 → 1). Readability over motion: chrome recedes to 60% (was 25% — unreadable over live video), edge scrims top and bottom carry the header and controls, soft text shadow, and the 260px lens ring yields the stage entirely in cinematic mode (its layout box stays, so nothing jumps; the CSS keeps it hidden even under hover restore — attention brings back controls, not ornament).

Plumbing: `videoNegotiator` gains an `onLocalStream` dep (reported when a start owns the camera, nulled at teardown, generation-guarded — 2 new tests, 25 pass); `useLensVideo` exposes `localStream`; the two backdrop `<video>` layers carry `data-role="camera-preview"` / `"transformed-stream"`.

The render probe was rewritten for the unified flow — it still clicked "Add video", a button #60 deleted, and its `querySelector('video')` would now grab the camera preview, whose fake-camera clock advances all by itself: a false PASS with Decart delivering nothing. It now drives access-key → "Start the lens" → asserts decode + advancing clock on `[data-role="transformed-stream"]` specifically → one Stop → reservation settles.

### Verification
- lint (with the new exhaustive-deps gate) / typecheck / `node --test src/lib/*.test.js` (218) / build — clean at every step
- #62 and #63 deploys: CI + Pages both success; #64 same gate before this entry is pushed
- Single-shot production render probe after #64's deploy (connection-budget doctrine: one run, reset on failure)
- **Probe result (post-deploy, 4 Aug): PASS** — access-key screen → "Start the lens" → transformed stream decoded with an advancing clock on `[data-role="transformed-stream"]` → one Stop → reservation settled, **billed 0s** (899s internal budget remaining). Evidence: `devlog/evidence/video-render-evidence.png` — the cinematic view live against production: transformed stream full-bleed, edge scrims, chrome legible at 60%. `scripts/check-live.sh`: all 3 layers PASS.

### Still the CEO's side of the walls
- The full identity drill with her eyes and ears (avatar + voice + cinematic fade + H), logged same-day
- P3 A/V sync acceptance in free talk

---

## 3 August 2026 (night) — halt-and-fix triage, the unified lens, pre-start identity

### Her halt mandate, resolved item by item

- **Agent offline** → her hands revived it; the log then showed the PRIMARY
  had been up 23h — the casualty was the template instance, and my
  crash-loop theory was only half right. Lesson: "agent offline" can be one
  instance of several; check every unit, not the first status line.
- **"502 still here"** → live tail: Decart **422 Insufficient credits** —
  the account balance, not the proxy. Now surfaces as
  vendor_credits_exhausted / HTTP 402 with prose; our meter untouched.
  Top-up is her spend wall.
- **Mic stays on** → instrumented run: NO track leak (mic ends on Stop).
  The indicator was the CAMERA behind the split buttons. Fixed
  structurally by the unified lens.
- **Voice dropdown "missing"** → renders from the agent broadcast; the
  agent was down. Returns with it — and pre-start selection now removes
  the dependency entirely (below).

### The unified lens (#60, merged + deployed)

ONE button. Start the Lens opens audio; on connection the video leg
auto-starts — once per session (createAutoStartLatch: re-renders never
double-bill, explicit stops are never overridden). Stop ends everything.
CINEMATIC mode: video live → the stream becomes the background (700ms
fade, mask off) and the chrome recedes to 25%, returning on attention;
H still gives the raw Clean View. Review: stacking context (isolate) +
prefers-reduced-motion, both accepted and confirmed. Video failure
degrades to voice with the reason on screen — never blocks.

### Pre-start identity (this PR): configure first, then Start keys everything in

- src/lib/voiceManifest.json: the account's 31 voices (21 premade, 10
  cloned), captured from the agent's own broadcast in one connection.
  The AGENT's live broadcast always overrides; ids are unusable without
  the key.
- The voice selector shows before start (manifest ?? broadcast), the
  choice persists (localStorage), and createVoicePreference applies it
  the moment the agent confirms — once per session, never against a
  choice the agent already holds, never before the agent has spoken
  (4 new tests). Connected, the selector still shows CONFIRMED truth.
- Avatar + prompt already rode the create; with #60's auto-start the
  full flow is: open → pick voice/avatar/style → Start the Lens →
  everything keys in.

## 3 August 2026 (evening) — the 5-hour mandate: render proven, Clean View, P3 A/V sync

### Task (verbatim, key parts)

> "You have full autonomy to keep executing down the roadmap... 1. The Blank
> Video Output... I expect that once #51 and the Avatar upload land, clicking
> 'Start' will successfully render the video stream on the screen. 2. New UI
> Requirement: 'Clean View' Toggle... pressing 'H'... leaving only the raw
> video output and the synced audio. 3. Proceed to Phase 3 (A/V Sync)...
> Audio is the master clock... I expect no unforced errors while I am gone."
> Later: "ensure you use playwright to test and ensure all ui and apps is
> working properly, simulate and test connection and ensure that the output
> and connection is actually showing and visible."

### Directive 1 — the blank render had FIVE stacked causes

The new render probe (npm run probe:video — asserts decoded frames whose
clock advances, not merely "connected") failed against the fully-patched
stack, and the diagnosis ran live against production:

1. PR #55: end-of-candidates travels INSIDE the list as [null] (bare null
   is refused: "Input should be a valid list") — this was the on-screen
   "an ICE candidate could not be delivered" — and NOTHING consumed the
   vendor's SSE event stream (P2e, promoted to blocking): the negotiator
   now opens vendor.events, queues vendor candidates until the answer is
   applied, and routes SSE error events into the terminal-limit classifier.
2. PR #56: CI typecheck caught .data on Event (MessageEvent casts). The
   unforced error of the day: I had not been running npm run typecheck
   locally although it is a CI gate. Ritual fixed.
3. Instrumented drills (RTCPeerConnection + EventSource wrapped in-page):
   ICE CONNECTED, transport stable, SSE open — zero frames, zero events.
   The vendor never begins generating.
4. **Root cause, PR #57: Lucy 2.5 generates NOTHING on a session with no
   prompt and no reference image — while billing it.** Same drill with a
   prompt: videoWidth=1280 in under 10s. The Worker now guarantees a
   session always has work: neutral identity default ("the same person,
   photorealistic...") when bare; a user's prompt never overridden; a
   reference image is work in itself.

**Render probe: PASS — billed 0s** (stop refunded the whole hold).

### Directive 2 — Clean View (#58)

H toggles an opaque overlay carrying only the raw stream — full-frame,
unmasked; the chrome underneath stays mounted so audio keeps playing.
The toggle decision is a lib with tests (typing guard, OS chords,
auto-repeat). CodeRabbit's Major was earned: hidden controls were still
focusable — now the chrome goes inert, focus moves into the overlay, and
returns on exit. Confirmed ✅, merged, deployed.

### The full Playwright validation (her explicit ask)

- Audio drill: **6/6** against production.
- Render probe: **PASS, billed 0s**.
- Visual validation (live session): video RENDERING at width=1280 →
  H → overlay on top, sr-only status announced, Stop UNREACHABLE by
  hit-test, chrome inert, focus contained → H → controls restored →
  typing "change cloth to blue" (with its h) does not toggle.
- Evidence committed: devlog/evidence/validate-studio-live.png and
  validate-clean-view-raw-output.png — the latter is Lucy's live
  transformed output full-frame in Clean View: the fake camera's test
  pattern re-imagined as a photorealistic scene under the default
  prompt. The lens, working, in one picture.

### Directive 3 — P3 A/V sync, the align slot filled (this PR)

Audio is the master clock; video buffers elastically; audio never waits.
Three tested modules + wiring:
- elasticDelay.js — the POLICY: windowed median over agent-measured tail
  samples, deadband (±120ms lip-sync tolerance), slew-limited glides
  (≤250ms/step), 2s ceiling (the structural p95). 6 tests.
- delayQueue.js — the HOLD: frames age to readiness; BOUNDED (overflow
  closes the OLDEST — a spike costs old pictures, never a freeze);
  ownership transfers on take; clear() closes all. 6 tests.
- frameDelay.js — the GLUE: insertable streams (Chrome; honest
  passthrough elsewhere), eager reader (never blocks the processor),
  paced writer.
- alignStage.js — fills framePipeline's align slot: one wrap per stream,
  predecessor released first, release() forgets the clock. 6 tests.
- Wiring: useLensVideo mounts the stage; Studio feeds
  utterances[0].tail_latency_ms; readout gains "· a/v synced".

### The rate-limit incident (CEO-found, evening)

Her live attempt failed at "Opening the lens": LiveKit's signal endpoints
answered 429 across every region. Cause: the day's validation volume —
suites, probes, and visual runs, each opening real rooms — consumed the
SHARED LiveKit project's connection-rate budget, and her attempt landed
inside the cooldown. Her failed attempts also wedged BOTH registry slots
(live 2/2), which would have turned into "at capacity" after the 429s
cleared. Reset released them; a single gentle retest connected in 6.4s.

**New doctrine: production tests share the CEO's connection budget.**
E2E suites and probes against production are single-shot instruments,
never run back-to-back; any failed browser run is followed by a session
reset; and heavy validation belongs on a staging LiveKit project (the
staging-agent → E2E-in-CI item just became load-bearing).

### Budget

~1530s spent by day's end (~$31) + one open reservation from a failed
validation run resolving via the executioner (~1290s remaining, ~$26).
Most spend was 180s-fully-spent reaps from the windows where stop paths
could not run — tuition, honestly accounted. Every reservation resolved;
the conservative machinery worked every time it was asked.


## 3 August 2026 — the CEO's drill finds the invented dialect (#50)

### Task (verbatim)

> "Live Video Drill Error (HTTP 502) & Feature Alignment — I ran the live
> drill on studio.luminastream.live, but clicking ADD VIDEO failed with a
> runtime error ... Reference Avatar Upload: I expect this phase to support
> uploading a reference avatar image/video so the output stream transforms
> into the selected reference identity. Voice Cloning & Voice Selection: Per
> our roadmap, voice cloning and user voice selection need to be integrated
> into this stage so users can select their cloned voice for the session.
> Please resolve the 502 error so I can complete the live drill."

### What the 502 was

Her first click on *Add video* was the first time the white-label create path
ever spoke to the real vendor — and Decart answered **HTTP 400,
"body.sdp: Field required"**. The adapter (#47) was coded against field names
I invented, and `whitelabel.test.js`'s vendor stub spoke that same invented
dialect back to the code: 17 green tests around a Worker whose first real
vendor call was a 400. The probe (#45) could not have caught it — it used
Decart's SDK, which speaks the real dialect internally.

### Diagnosis, for $0

`wrangler tail` + a scripted reproduction (fake SDP through the production
Worker; a failed create settles its own hold at zero). The vendor's error body
named the missing field outright; a constrained client token (the P2b path)
let me iterate the create shape directly against the live API. One real 201
exchange settled at zero taught the whole response contract:

- offer travels as `sdp: {type:'offer', sdp}` — not `sdpOffer`
- response is snake_case: `session_id`; the answer is at `sdp.sdp`
- the ICE ETag is a **rotating response header**, required as `If-Match` on
  every PATCH — not an optional body field
- `events: {url, event_token, expires_at}` is the SSE leg (P2e's input)
- DELETE's billing summary field is `billed_seconds` — the ledger's camelCase
  read treated every real summary as unusable and would have silently settled
  every clean stop as FULLY SPENT (over-charge, never under — but wrong)

One test session was orphaned by my own cleanup script reading the id at the
invented field name — 60s-constrained, zero generation, self-expired at
13:00Z. Poetic: the bug ate the bug-hunter's teardown too.

### The fix (#50)

Worker create sends the real dialect and lifts the ETag header into the vendor
passthrough; the candidates route returns each PATCH's rotated ETag; the
negotiator **serializes** ICE sends and chains the rotation (concurrent sends
would 412 against a rotated If-Match — a new discrimination test breaks the
chain and fails); candidates are mapped to exactly the three documented fields
(browser `toJSON()` adds `usernameFragment`, and the far end validates
strictly); the ledger reads `billed_seconds`.

The vendor stub is now a **contract fixture** mirroring the verified live
shapes (201 + ETag header, 204 PATCH + rotated ETag, snake_case DELETE
summary), with a header comment saying why. Mutation-tested: reverting the id
parse alone fails 16 of 17.

### The lesson (a new one, worth the name)

**A mock you invented is a mirror, not a wall.** Every prior test-blindness in
this project was a test asserting less than its name; this one was a test
asserting against a fantasy. The fixture rule going forward: any stub that
stands in for a vendor must cite the doc or live exchange its shapes came
from — a stub whose shapes have no citation is asserting my imagination.

### Scope asks (answered in chat, decided here)

- **Reference avatar**: native Lucy 2.5 capability (`image_data` at create,
  `POST /{id}/image` mid-session; JPEG/PNG/WebP; images only — video
  references are not a vendor capability). Next PR.
- **Voice cloning/selection**: per-session voice **selection** is an agent
  parameter and can land as a console knob; self-serve **cloning** requires
  user accounts + consent + wallet (P4) — sequenced there.

### Act two: the live verification caught what the dialect fix could not (#51)

PR #50 merged (CodeRabbit: 2 findings, both accepted — resolved-refusal
observability + fail-closed on a missing create ETag — both confirmed ✅ by
the bot) and deployed. The $0 live verification then did its job twice over:
**create 201'd — and the vendor DELETE answered 401.** Tested live:

> Decart accepts session control (ICE PATCH, prompt, DELETE) **only from the
> client token that created the session.** The raw account key is refused;
> the creating token gets 200 + billing summary (`reason: client_ended`).

Blast radius of the wrong assumption: the end path, both compensating
deletes, every executioner kill, and ICE candidate delivery — the CEO's
drill would have failed to connect even with the dialect fix.

The design answer keeps every canon intact (#51):
- the control token carries the vendor token **sealed** (AES-256-GCM, key
  derived from ADMIN_SESSION_SECRET + purpose label): the browser transports
  ciphertext it cannot open, control ops stay zero-DO-cost, O(1) stays 3,
  and the constrained token still never leaves the Worker in usable form;
- bind persists the vendor token in the ledger record — the alarm has no
  request to unseal from, so the executioner carries its own credential;
- mint expiresIn 120 → grantedSeconds+300: the token is the session's only
  control credential for life, so it must outlive settle + retries;
- the contract fixture enforces the 401 rule, so every control/end/kill test
  now discriminates on credential choice.

The reservation stranded by the failed end resolved EXACTLY as designed:
kills bounced 401, bounded retries exhausted, orphan-flagged settlement,
debit stood. openReservations 0; spent 90/3000 (probe 30 + orphan 60).

### Act three: the drill gate opens

CodeRabbit #50: 2 findings, both accepted (resolved-refusal observability;
fail-closed on a create without an ETag), both confirmed ✅ by the bot.
CodeRabbit #51: full review, zero findings. Both merged; Worker deploys
green. **Live create+END verification: PASS** — create 200 (session id,
control token, answer, etag), end 200 with vendor DELETE 200 and
vendor-truth settle (60s refunded), budget byte-identical before/after,
zero open reservations. The drill is unblocked.

Budget note for the record: spent moved 90 → 270 during the fix window.
The shape matches one 180s reservation reaped fully-spent — almost
certainly an Add-video retry landing between #50 (create works) and #51
(control works), where ICE couldn't flow and the tab closed on a bound
session. The ledger did exactly what it promises: bounded kill retries,
orphan flag, debit stands. ~$3.60 of tuition. 2730s (~$55) remain.

### Act four: the CEO's feature directives (same message as the 502)

- **Reference avatar (image only — she confirmed the video mention was a
  misstatement) + realtime prompting** → #52: Worker create takes
  `imageData` (normalized, refused before any hold), new `image` control
  action (mid-session identity swap, sealed creating token, zero DO
  cost), `setVideoImage`/`updateImage` plumbing, Studio avatar picker +
  live prompt field with Apply. 171 frontend + 167 worker green.
- **Voice selection dropdown on the studio page** → the discovery of the
  night: the ENGINE ALREADY HAS IT. `knobs.py` has a dynamic `voice`
  enum; `convert_agent._switch_voice` validates against the account's
  live voices; `agent_config` broadcasts choices + labels; the hook
  already ships `requestAgentConfig` and `refreshVoices`. Stage 1 built
  the whole machine and only the console ever surfaced it. The studio
  dropdown is a pure UI addition — next PR.
- **Voice cloning**: aligned at P4 (Identity & Persistence), her words.

### Verification

- #50: mutations (un-serialize chain; camelCase id parse → 16/17 fail).
- #51: mutations (control ops on raw key → 7 fail; executioner on raw
  key → 4 fail); seal/unseal unit tests (roundtrip, fresh IV,
  tamper/wrong-secret/wrong-purpose → null).
- Live: create+end $0 verification PASS (above); same-token DELETE 200
  with billing summary; raw-key DELETE 401 (twice, independently).
- #52: refuse-before-reserve asserts ZERO ledger requests for a bad
  upload; mid-session swap proven against the fixture's 401 rule.

### Act five: shipping the directives

PR #52 (avatar + live prompt): CodeRabbit found 2 — an honesty bug (the UI
said "Avatar set" even when the live swap was refused, and "clear" during
a stream cleared only local state while the vendor kept animating the old
identity) and a missing accessible name on the prompt input. Both accepted,
fixed, confirmed ✅, merged, Worker+Pages deploys green. The avatar and
live restyle prompt are LIVE on the studio page.

Voice selection (this PR): the Studio dropdown wired to the existing
machine — value is the agent-CONFIRMED voice, a pending request is named
as pending (the mode toggle's rule), a rejection shows the agent's own
reason. Rendered only when the agent's CONFIRMED mode is convert: Direct
passes the real voice through, and a selector there would promise what
the mode cannot do.

CodeRabbit then caught the project's recurring mistake a THIRD time: the
request lifecycle was a state machine living in Studio.jsx — same tell
as sessionHolder (P1b) and videoNegotiator (P2d): no test file beside
it — and, as both times before, the extraction surfaced real bugs the
component version shipped: a stale rejection could resolve a fresh
request; a failed/throwing publish left a pending state nothing could
clear; re-selecting the confirmed voice re-armed an abandoned request;
visibility keyed on the REQUESTED lens mode. All four accepted →
`src/lib/voiceSelection.js` (+7 tests, stale-rejection guard
mutation-tested). Three strikes makes it doctrine, not coincidence:
**if UI state has a lifecycle, it is a lib with a test, from the first
draft.**

### Files (all four PRs)

PR #50/#51: `workers/api/src/{index,spendLedger,crypto}.js` (+tests),
`src/lib/{videoNegotiator,videoClient}.js` (+tests)
PR #52: those plus `src/hooks/useLensVideo.js`, `src/pages/Studio.jsx`
this PR: `src/pages/Studio.jsx`, `devlog/SESSIONS.md`, `notes.md`

## 3 August 2026 (overnight) — P2c + P2d: the topology implemented, video in the lens (#48 merged, #49)

### Task (verbatim)

> "P2 Research Closed: Verdict Approved & P2c Green Light and after its
> comrfirmed and gone through tests as usual you can start P2d — video in the
> lens + WebGL upscale slot (frame pipeline). keep the good job going am
> proud, ill be sleeping now while you work on those."

### P2c — the white-label topology, implemented (#48, merged & deployed)

Create in the orphan-proof order: reserve (the unbound reservation IS the
durable pending-create marker) → constrained client token minted for the
WORKER'S OWN use (wall #2 rides on the session; the token is shown to nobody)
→ vendor create → bind the session id BEFORE the browser sees a byte →
respond. Control is stateless (HMAC token scoped to session+reservation+lease)
so ICE and prompts cost ZERO Durable Object requests. End is vendor-truth: the
Worker DELETEs and settles from Decart's own billing summary — the test enacts
the canon's attack (browser claims `billedSeconds: 1` while Decart says 41.2;
the ledger records 42). The executioner kills abandoned sessions with bounded
retries (1+KILL_RETRIES alarms, asserted), 404 counts as success, exhausted
retries flag an orphan.

Full O(1) budget: **reserve + bind + settle = 3 DO requests per video
session**, whatever its length. Verified live in production after deploy.

**Review (3 findings, all mine):** the sharpest was that I built an
executioner and then wrote two paths that destroy its ammunition — settling
deletes the reservation, and a failed vendor DELETE would leave a running
session with no server-side owner. `end` now refuses to settle on a failed
kill; the create-compensation path (which cannot defer) settles FULLY SPENT
and logs the orphan, because refunding a stream that may still run pays for
someone else's video.

### P2d — video in the lens (#49)

The lens grows a second, independently metered leg. The frame pipeline is the
CEO's day-one mandate made structural: frames never reach the screen as a bare
`<video>` — they pass `receive → align → upscale → present`, with the middle
stages declared, INERT, and named for the phase that fills them. The fidelity
readout says **"720p · upscale pending"** because that is what the pipeline
delivers; a mutation claiming FHD from an empty slot reddens two tests.

### Key finding — the same lesson, twice, and what it cost

**I put lifecycle logic in a React component again.** `sessionHolder.js` exists
because I did it with the audio session at P1b; four rounds later I did it with
the video's. The reviewer's tell was exact: `videoClient.js` and
`framePipeline.js` each shipped with a test file and the hook did not — *a file
with no test beside it, in a codebase where everything has one, is the shape of
logic hiding in the wrong layer.*

Extracting `videoNegotiator.js` (12 tests where there were none) immediately
exposed, in order:

1. **ICE candidates were silently dropped.** Gathering starts at
   `setLocalDescription`; the handler went on after a network round trip, and
   the DOM API does not replay missed events. Behind NAT: intermittent failure
   with no error anywhere.
2. **A hung start could not be cancelled** — an unanswered camera prompt left
   a PAID slot unreleasable, with Stop disabled during exactly that phase. The
   Starlink lesson reproduced in a new component within a day of citing it.
3. **The terminal-limit classifier had no input.** `onFailure` only ever
   emitted our own connection-failed string, so nothing could feed the vendor's
   message to `isDurationLimitError`. A wall with a door onto blank wall.
4. **Writing the test for a reported bug found a worse one underneath it.**
   Fixing shared-flag cancellation revealed that an abandoned start's cleanup
   tore down the session that had REPLACED it — closing the peer, stopping the
   camera, clobbering the phase. It would have presented as "video dies a
   second after I restart it", with nothing in any log. Starts now hold their
   own resources and publish to the shared slots only after each checkpoint.

Also caught: two tests asserting less than their names claimed, and one test of
mine whose assertions lived in a bare `.catch()` — never executed if the call
stopped rejecting.

**The pattern worth keeping:** every one of these was findable only after the
logic moved to `src/lib/`. The rule is not hygiene; it is the difference
between a bug that can be broken on purpose and one that ships.

### Verification

166 frontend tests (was 133), 157 worker, lint, typecheck, build, markdown
guard, dry-run. Twelve mutations across the two PRs, each convicting exactly
its guard. P2c verified live in production post-deploy (routes gated 401/403,
control token refused without its session, budget clean).

**Not done, deliberately:** no live end-to-end video run — that spends vendor
money and belongs to a CEO drill with its result logged same-day.

---

## 3 August 2026 — THE PROBE VERDICT: maxSessionDuration is ENFORCED — against generation (#46 merged, #47)

### The experiment (the project's first metered vendor spend)

`npm run probe:decart`, against production, through our own wall: a 30-second
reservation ($0.60 at the verified $0.02/s), a fake-camera Chromium page on
`studio.luminastream.live`, Lucy 2.5 connected with a client token constrained
to `maxSessionDuration: 30`, watched to 75 s. Settled honestly (`usedSeconds:
30`, clamped), ledger left clean. Full verdict + event log:
`test-results/decart-probe.json`, key events reproduced here per convention:

| t (wall) | event |
|---|---|
| 5.7 s | connected, model `lucy-2.5` |
| 6.1 s | state `generating`; ticks climb 0 → 26 |
| **39.1 s** | **`sdkError: "Session duration limit reached"`** (~33 generated s vs the 30 s constraint) |
| 39.1 s | SDK auto-reconnect: `reconnecting` → `connected`, new remote stream |
| 46–75 s | **ticks frozen at 32 — no further generation, no further billing** |
| 75.8 s | our watch window closes; we disconnect |

### The verdict

**ENFORCED at runtime, against GENERATION** — with three findings P2c builds on:

1. **The money stops at the constraint** (+~2–3 s of vendor granularity).
   Wall #2 is real: even if our executioner alarm and its retries all failed,
   a constrained token bounds the burn. Reserve accounting tolerates the
   granularity margin until vendor-truth settle reconciles it.
2. **Enforcement announces itself in the error stream, not by connection
   death.** The first classifier looked for the connection dying and returned
   "ambiguous" while the log showed a clean enforcement — the client (and the
   probe, now fixed) must listen for the limit error, not the hangup.
3. **The zombie-reconnect trap:** the SDK auto-reconnects after the limit into
   a connected-but-not-generating session — exactly the "silent freeze" the
   canon forbids the user ever seeing. The limit error is TERMINAL; P2c's
   client hard-stops with a visible reason.

### Instrumentation lessons (three live-run fixes, each its own commit)

`about:blank` has no `navigator.mediaDevices` — the probe now runs in our own
deployed origin, the same one P2c will use. The SDK takes a model OBJECT
(`models.realtime(id)`), not a string — every candidate id "failed" until the
shape was right, and the probe's refuse-to-conclude discipline (a probe that
cannot hear must not conclude) is what kept those from becoming verdicts. And
the fatal path now prints its event log — evidence trapped inside the page is
no evidence.

### Money

Reserved 30 s, generated ~32 s (vendor granularity), settled 30 s. Dev budget:
30/3000 s consumed ≈ $0.60. The wall metered its own calibration.

---

## 3 August 2026 — SCORED VOICE DRILL: 9/10 — and the topology, upscaler, and retail canon land

### The drill (CEO-run, logged same day per convention)

**Overall: 9/10** — up from July's 8.7, and scored on a materially different
system: the P1 session flow (server-allocated room and identity, slot held
Start→Stop), post-DNS-fix, through the deployed lens. The first scored drill
since the session layer, the release paths, and the two-agent pool shipped.

**What this entry does NOT have, named rather than implied:** sub-scores
(July carried clean 8 / latency-feel 8.3 / is-it-ME 8.5) and an analyzer
report (`--capture-dir` + `analyze_capture.py`). The CEO reported the overall
score in chat; if a capture exists, its report joins this entry when provided.
The 29 Jul convention exists because a drill that lives only in chat becomes a
hole — this one is logged the same day with exactly what is known.

### Decisions taken (CEO, 3 Aug 2026) — now canon in ROADMAP.md

1. **Topology approved:** control plane through the Worker (white-label
   signaling, real key never leaves the server in any form), media plane
   direct browser↔Decart. The ledger's reaper alarm becomes the executioner
   (expired reservation → DELETE the vendor session by id); settle consumes
   Decart's own billing summary — vendor-truth before wallets exist.
   `maxSessionDuration` demoted to defense-in-depth; the probe calibrates it.
2. **Upscaler approved:** client-side, staged — WebGL FSR-class in the studio
   (P3), MetalFX in the native lens (P6), FHD/2K mandate; backend GPU
   upscaling rejected (GPU-free doctrine, lip-sync, COGS). The render path is
   a composable frame pipeline from day one.
3. **Retail decoupling mandated:** the wallet's unit of account is retail
   (Lumina Credits), vendor units convert via a rate table at settlement, raw
   vendor summaries stored verbatim for audit, and — the enforceable part —
   **a margin floor the ledger refuses to boot below**: retail rate below
   declared COGS is fatal config, never silent. "Never sell compute at cost
   by accident" became an invariant, not an intention.

### Next

The P2b probe build: `/api/video/token` (reserve-bound client token, one mint
per reservation) + a Playwright probe that streams past a small
`maxSessionDuration` and clocks whether Decart cuts a RUNNING session. ~$1–2,
ledger-reserved. Then the white-label session routes (P2c) implementing the
committed topology.

---

## 3 August 2026 — P2a: the SpendLedger — the wall stands before the money exists (#43 merged)

### What shipped

Four routes (`/api/video/reserve|settle|budget|reset`) backed by the
`SpendLedger` Durable Object — **the prepaid wallet enforcer in dev-cap
clothes**, merged and deployed while the Decart key still does not exist, per
doctrine. Dev ceilings 180 s/session, 3000 s total (~$60). Reserve → settle:
two DO requests per video session whatever its length (the §P1 O(1) invariant
with money attached); debit-on-reserve; abandonment reaped conservatively as
fully spent.

139→140 worker tests. Five money mutations run, each reddening exactly its
guard: unclamped settle (1), record surviving its settle / double refund (2),
reaper crediting abandonment (1), fixed-interval sweep (4), and the shipped-
order restore below (1).

### The finding of the PR — a real money bug, and why my tests were blind to it

CodeRabbit's Major: `#settle` read the record without evaluating `expiresAt`,
so a settle arriving **after expiry but before Cloudflare delivered the
alarm** refunded a hold the object's own header says has already resolved as
spent. In wallet terms: let a session expire, then send the settle, reclaim
the money.

Two lessons, both sharper than the bug:

1. **The registry documents this exact rule** — "the alarm frees the slot, it
   does not define expiry" — and I applied it in one object and not its
   sibling. A rule living in one file's comments gets applied once. When the
   ledger graduates at P5, the sweep-before-read discipline should be
   extracted, not re-remembered.
2. **The reviewer diagnosed the test blindness precisely:** `advanceBy` fires
   alarms en route, so "expired but unreaped" never existed in my suite —
   while `warpBy` has existed in the harness for exactly this window since
   the registry's own delayed-alarm test. The new test uses it; restoring the
   shipped order reddens exactly that test.

Also fixed: a hedged assertion of mine that could silently compare 0 to 0 —
the "test that cannot fail on the thing it names" class, caught at review
rather than by an incident this time.

### Production drill of the wall (no vendor, no spend — pure bookkeeping)

Run against the deployed Worker after the v2 migration, transcript abridged:

| step | result |
|---|---|
| virgin budget | `spent 0 / 3000, open 0` |
| reserve 120 s | `granted 120, spent 120` (debit at reserve) |
| WRONG settle token | `403 settle_refused`, hold stands |
| settle, used 45 | `refunded 75, spent 45` |
| settle AGAIN | `settled:false, unknown_reservation` — no double credit |
| reset | meter zeroed, `0 / 3000`, clean for real P2b use |

Routes gated (401 unauthenticated, 405 wrong method), `check-live.sh` PASS ×3.

### Next — P2b, and its gating question

**Does Decart's `maxSessionDuration` actually cap a RUNNING session?** The
canon (#42) makes this the topology-deciding verification: pass → browser-
direct with reservation-bound tokens; fail → video authorization moves behind
the Worker. Needs a narrowly-scoped test key — a CEO wall — spent against the
ledger's own $60 ceiling in one instrumented experiment.

---

## 3 August 2026 — ALIGNMENT: the prepaid model, and elasticity becomes a launch gate

### Task (verbatim, abridged)

> "The Business Model is Prepaid (Pay-As-You-Go) and a monthly based
> subscription fee [...] two tiers, lets say standard and pro [...] a strictly
> prepaid wallet system [...] If 10,000 users burst the system, those are
> 10,000 funded sessions. [...] Auto-Scaling is an MVP Launch Requirement [...]
> Please acknowledge this prepaid architecture, add the pre-launch auto-scaling
> migration to the ROADMAP.md, and then let's get moving on P2: The SpendLedger."

### Decisions taken (CEO, 3 Aug 2026) — now canon in ROADMAP.md

1. **Prepaid wallet + two-tier subscription** (standard/pro, illustrative
   $10/$18 — real prices only after running costs are known; margins baked
   into credit pricing). Tier gates features; wallet gates usage.
2. **The SpendLedger is the wallet enforcer from day one**, temporarily wearing
   dev-cap clothes — same object, same code paths graduate from dev ceilings to
   user wallets. Spoof-proof server-side, zero-balance cutoff, and it must obey
   the O(1) invariant (reserve → settle, two DO requests per video session —
   a per-second meter would keep the DO awake for the whole stream).
3. **PL — a formal pre-launch gate:** stateless agents migrate to an
   auto-scaling container orchestrator (Fly.io / Fargate / K8s, chosen then)
   before any public MVP launch. Doctrine: **scale first, refuse last, never
   degrade** — a funded user should never reach the "busy" door, but the door
   stays as the last backstop behind elasticity. The 2 Aug capacity Q&A
   (three numbers, migration path, vendor-COGS truth) is canonised inside the
   gate's section.

Also observed by the CEO in live use: a THIRD device correctly refused at
capacity 2 — the honest-refusal path exercised by a real person in production,
behaving exactly as the e2e asserts.

### Next

P2a: the SpendLedger Durable Object — reserve/settle, two-layer caps, the
lifecycle oracle, spoof tests. The wall merges before the Decart key exists.

---

## 2 August 2026 (night) — P1c: two agents, and the capacity constant exists (#39, #40 merged)

### Task (verbatim)

> "okay its working, now now lets go ahead with P1c, you said my hands at the
> vps, whats required of me to do and provide me with everything i need. lets
> keep the momentum going"

### What happened, in order

**#39 — the template unit.** `lumina-agent@<room>.service`: instance name is
the room, identity derives as `echo-convert-<room>`, per-instance
StartLimitBurst spend wall. `deploy-agent.sh` now discovers every agent unit
(union of list-unit-files and list-units, bare template filtered), restarts
each, gates each BY NAME, stray-scans against the set of MainPIDs. Harness
grew 39 → 50 assertions; the mutation that silently drops @instances from the
restart list reddens five. Zero CodeRabbit findings — the first clean pass of
the day.

**The CEO's hands (runbook executed cleanly, screenshot in chat, logged here
same-day per the drill convention).** Box pulled #39 on its own; her
`enable --now lumina-agent@luminastream-2` came up and connected as
`echo-convert-luminastream-2`, mode=convert, publishing stats. Quiet proof in
her paste: the PRIMARY showed ELAPSED 10:44 against the instance's 05:04 —
**the pull-based deploy had already restarted the primary itself** when #39
landed. The multi-unit deploy worked in production before we watched it work.

### THE CAPACITY CONSTANT — measured for the first time

| | |
|---|---|
| Box | 7.8 GiB RAM, 4 cores, swap 0, 6.8 GiB available |
| Agent 1 RSS | 333 372 KiB idle → **346 128 KiB while the CEO spoke** (~325 → 338 MiB) |
| Agent 2 RSS | 333 536 KiB idle (~326 MiB) |
| CPU | ~3 % per agent — **lifetime average** (`ps %cpu`), see caveat |
| Per-agent budget | **~350 MiB** (floored margin over worst observed) |
| **RAM-bound ceiling** | **⌊6963 / 350⌋ = 19 agents** |

**Caveat recorded, not glossed:** `ps` reports lifetime-average CPU, so a 30 s
talk barely moves it — CPU under several *simultaneous* conversations is
unmeasured. Published constant: **19 RAM-bound, hold ≤ 6 until concurrent-load
CPU is measured** with `top` during a two-conversation drill. Floored, never
rounded (doctrine).

Also visible in her paste: agent 2's warm-up cost `TTS 1/5000 chars (1 call)`
— the per-instance governor working, and the per-deploy warm-up price of a
second agent (cents, capped by StartLimitBurst).

### #40 — the pool of two

`SESSION_ROOMS=luminastream-test,luminastream-2`, `MAX_CONCURRENT_SESSIONS=2`.
E2E made capacity-agnostic (the busy test reads the pool size and fills it, so
growth can never quietly turn it into a test of nothing) and **paced** — every
unlock spends one verify against the 5/60 s password-oracle limit, and the
robot slows down rather than anyone loosening a security control for tests.
New test: **TWO people at once** — two browser contexts, two sessions
simultaneously, two different rooms, both released. It skips (says so, does
not lie) while the deployed pool is 1; the proving run happens post-merge.

Pre-merge run against production: 5 passed, multi-user skipped, as designed.

### Post-merge result — 6/6

> ✓ TWO people at once — the first multi-user moment, proven (27.3s)

Two browser contexts pressed Start CONCURRENTLY (Promise.all); the registry
serialized the overlap and allocated two different rooms — luminastream-test
and luminastream-2, each with a live agent — both held at once (server:
live 2), both released (server: live 0). Against production, artifacts
retained. **P1 — the session layer — is closed, 2 August 2026.** Planned at
~1½ weeks; landed in one continuous day, at the cost the review record shows.

### Next

Post-merge: `npm run e2e` must show 6/6 — the first multi-user moment, proven.
Then still owed: the CEO's scored voice drill (DNS fixed, lens working), and
the concurrent-load CPU measurement before the pool ever grows past 6.

---

## 2 August 2026 (late) — INCIDENT: the stuck slot, reproduced, fixed, and pinned by E2E (#37 merged, #38 open)

### Task (verbatim)

> "i dont understand what you mean by you set the capacity to 1 [...] i also
> demand that you intall tools that helps you through this project like that
> playwright which gives you eyes to test uis and all that. i need everything
> working and also you letting me know where we are on the roadmap now"

### The incident

The CEO's drill hit `503 at_capacity` with no visible session — the only slot
held by a session no client could release. Two failures, in order of blame:

1. **No operator recovery existed.** The lease (2h) was the only way out.
   #37 shipped `/api/session/reset` + `scripts/reset-sessions.sh` (fail-closed
   after review). Run against production: `before live:1 → released:1 → after
   live:0`. Unblocked.
2. **The leak itself — root cause found by instrumented E2E, not by reading.**
   A wire-log run showed: create 200 → LiveKit WebSocket
   `ERR_NAME_NOT_RESOLVED` (the documented Starlink DNS blackhole, active on
   this Mac; host resolves fine via 1.1.1.1) → Stop clicked → **zero
   `/api/session/end` requests ever sent**. `stop()` sequenced the release
   BEHIND `await disconnect()`, and a teardown wedged mid-connect hangs — the
   try/finally from #35 round 4 protected against a disconnect that REJECTS,
   not one that HANGS. Second defect: the Stop button was `disabled` while
   Connecting, so a person wedged mid-connect had NO way to release their own
   slot. An unreleasable hold, by design.

### The fix (#38)

- `stop()` releases first and tears down in parallel — the release is never
  hostage to LiveKit. No data dependency existed; only accidental sequencing.
- **Stop is reachable from every held state.** Holding + disconnected now shows
  Reconnect (slot and grant still valid — retrying is free) + Stop.

### Playwright E2E — the CEO's demand, met

`npm run e2e`: headless Chromium, fake mic, real Worker/DO/agent. Five tests =
her drill, automated: start (server-allocated slot visible in UI **and**
confirmed held server-side), stop (server agrees released), **start-again**
(reuse is proof of release), busy-in-words (and one-click recovery, no
re-login), leave-page (pagehide keepalive release). Deliberately not in CI: it
needs the admin password and consumes the production slot; it is an on-demand
instrument like check-live.sh. Password flows secrets.env → env var, never argv.

**Discrimination, old-vs-new:** the same suite failed 3/5 against the deployed
(pre-fix) bundle and passes **5/5** against the fixed build served locally on
the CORS-allowed port. Screenshots + traces retained per run.

Suite defects found while building it (pattern of the day, continued): tests
lacked per-test isolation — test 1 deliberately ends while holding, poisoning
everything after it with the very at_capacity it exists to detect; and the
reuse test clicked faster than the release could land (UI says "Lens off"
before the server agrees — known wart, phase='stopping' sketched for P7).

### Analyzer report and scorecard for this drill

**None exist, and here is why rather than a hole:** the drill never reached
audio. The LiveKit connection failed at DNS (Starlink blackhole), so there was
no capture, nothing for `analyze_capture.py` to read, and nothing for the CEO
to score. The drill's product was the incident above. **A scored voice drill on
the new session flow is still owed** — it runs after the CEO applies the
OS-level 1.1.1.1 fix, and gets logged same-day per the convention this section
exists to honour.

### Still true / still owed

- **The CEO's Mac needs the OS-level DNS fix** (1.1.1.1) before voice will
  connect on Starlink — config is correct, network is the hazard. Runbook step.
- Capacity=1 is the physical agent count, not a policy choice; P1c raises it.
- A held-but-never-connectable slot self-releases only via Stop/leave; an
  auto-release on terminal connect failure is P1c-adjacent polish.


---

## 2 August 2026 — P1b: the lens takes a real session (#34, #35 merged)

### Task (verbatim)

> "okay lets move ahead with p1"

and, after P1a shipped:

> "okay lets continue with the Next"

### CEO decision taken this session

Asked what replaces the admin password once the lens uses `/api/session/create`,
given the repo is public and the endpoint mints LiveKit grants. Three options
put up; **"Keep the password for now"** chosen. So P1b is a plumbing change, not
a door change — the gate retires in P4 when accounts exist to replace it with.

### What I did

**#34 — a session slot is a room with an agent in it.** Found while wiring the
lens, and the reason P1b took two PRs. `/api/session/create` invented a room name
per session (`lumina-<uuid>`), and **no agent joins a name we made up a moment
ago.** The browser would connect, publish its microphone and wait forever for a
reply, while the registry reported a perfectly healthy session. Wiring the lens
to it as shipped would have broken the thing the CEO tested and liked.

Rooms are now allocated from a **pool** of rooms an agent is actually serving.
Two limits, deliberately distinct: `SESSION_ROOMS` is physical (how many rooms
have an agent), `MAX_CONCURRENT_SESSIONS` is policy (how many we admit).
Effective capacity is `min(pool, policy)`, so the knob can never admit **more**
sessions than there are agents — the audio governor's shape, an adjustable cap
under a hard ceiling. (`min` permits equality, and with one agent and a cap of
1 it *is* equality; "fewer" would have been the wrong inequality.)

**P1c got smaller as a result.** Growing capacity is now one command on the box
and one config line: `convert_agent.py --room <name>`, then that name in the
list. It was going to be a design problem; it is now an operation.

**#35 — the lens.** The server allocates room, identity and grant; the client
picks nothing. The slot is held **from Start to Stop**, not from unlock — a slot
claimed at unlock is held by someone reading the page and deciding, while the
person who actually wants to talk is refused. Released on Stop, on unmount (the
in-app navigation `pagehide` cannot see), and on `pagehide` via `fetch` with
`keepalive` — not `sendBeacon`, which cannot set the `X-Admin-Token` header the
endpoint is gated on.

### Key findings / surprises

**1. Five review rounds, eleven findings — and four of the six real bugs were in
code written to fix an earlier round.** That is the number worth recording, not
the total. Each fix was correct about the thing it fixed and wrong about
something adjacent, which is the shape of the whole session.

**2. I shipped a test that asserted a bug as correct behaviour.** `a failure
after the page is gone publishes nothing` checked exactly the early return that
wedges the phase: press Start, hide the tab, let the claim fail, and the Start
button is dead until a reload. The root cause was collapsing two states that
were never the same — **a disposed holder is never read again; a hidden one can
come back**. Then my *first* replacement test hid the page *after* the failure
had been handled, so it never touched the wedge path and passed against the bug
too. Caught by mutation, not by reading.

**3. The extraction found a bug rather than relocating one.** CodeRabbit cited
this project's own rule — `AGENTS.md`: *"anything with real logic belongs in
`src/lib/` rather than inside a component, because this is the part that can be
tested without a browser"* — against four lifecycle decisions I had put in
`Studio.jsx` and then shipped with a PR note saying they were untested. **That
note is what the rule exists to prevent.** I flagged the gap instead of closing
it, which felt like honesty and was really documenting a shortcut.

Extracting them into `src/lib/sessionHolder.js` (22 tests where there were none)
surfaced a case I would not have found by re-reading: a bfcached page comes
*back* holding credentials for a room the registry has since given to somebody
else. Reconnecting would have dropped that tab into a stranger's session.
`restored()` clears them now. That is the argument for the rule, stated better
than the rule states it.

**4. A mutation that reddened nothing exposed a weak assertion of mine.** I had
asserted that the two 503 refusals produce *different* messages. Collapsing the
branch still produced a different message — the bare code `sessions_disabled` —
which a difference check accepts while showing a person a machine token. I
strengthened it to demand prose across the three named codes, and **did not then
ask what happens to a code that is not in the list.** CodeRabbit did. Same
defect, one door further along.

**5. Declined, with reasoning: reclaiming a slot when the browser dies
mid-create.** No client code runs, so the lease is the only backstop — two hours
on a one-agent system. The suggested server-side fix (abort-triggered release
via `request.signal`) is not obviously safe: the abort can fire *after* a
successful response is on its way, converting a rare 2h stall into a rare
mid-call eviction. Recorded as a known window, to be revisited in P1c where
agent topology and lease length both change anyway.

**6. The through-line.** Every finding this session reduced to the same
sentence: **the slot is the scarce thing, and everything else is housekeeping.**
A failed local teardown, a dead tab, a restored page, a request landing after
the user navigated away — each was a route by which a slot could stay held while
nobody was using it. On a one-agent deployment that is not untidiness; it is the
product being unavailable to everyone for two hours.

### Files changed

- **New** `src/lib/sessionHolder.js` + tests — the lifecycle authority. No React,
  no DOM, every collaborator injected, so a test can resolve a create in the
  middle of an unmount and assert what happened to the slot.
- **New** `src/lib/sessionClient.js` + tests — `/api/session/*` client.
- **New** `src/lib/apiFetch.js` — the deadline and JSON POST shared with
  `serverMint.js`. One implementation, because `deadline()` is what stands
  between the app and a request that never settles.
- `src/pages/Studio.jsx` — publishes holder state and renders; browser lifecycle
  events go in one side. No room constant, no client-side identity.
- `workers/api/src/sessionRegistry.js` — the room pool, `SESSIONS_ENABLED`.
- `workers/api/wrangler.jsonc` — `SESSION_ROOMS` per environment; staging
  disabled because no agent serves it.
- `README.md`, `workers/api/README.md`, `src/lib/sessionIdentity.js` — the lens
  no longer chooses its room; the console still does, deliberately.

### Verification

- **132** frontend tests (was 89), **100** worker, **224** agent — all green
- lint, typecheck, build, markdown guard, `wrangler --dry-run` both environments
- **Eleven mutations run across both PRs**, each reddening exactly its guard;
  two reddened nothing and were themselves the finding.
- **Production:** both deploys succeeded; `scripts/check-live.sh` PASS on all
  three layers. Route probes confirm `/api/session/*` exists and is gated.

**Not verified:** no live drill has been run against the new flow. The paths
that matter most — Start → Stop → Start again, and Start → navigate away →
Start again — are exactly the ones no automated test reaches. Requested from
the CEO; **this entry will be updated with the result the same day it is run**,
per the CEO-run drill convention.

### Next

**P1c** — a second agent on the VPS with `--room`, added to `SESSION_ROOMS`, and
the **capacity constant** measured for the first time. Needs the CEO's hands on
the box.

---

## 2 August 2026 — P1a: the session layer, with the O(1) invariant enforced (#32 merged)

### Task (verbatim)

> "okay lets move ahead with p1"

Preceded in the same session by the CEO's answer on the Cloudflare plan and her
cost concern:

> "The Cloudflare account is currently on the free tier thou theres a concer,
> The CTO noted that Durable Objects are metered on paid Cloudflare plans. Even
> if you are on the Free plan right now, you will eventually upgrade as Lumina
> Stream grows. Durable Objects can be highly 'chatty' (making thousands of
> micro-requests per minute to check room status). If not engineered carefully,
> a chatty DO on a paid plan will rack up a massive Cloudflare bill overnight.
> that being said we move on with p1 or?"

### What I did

**PR #32 — `SessionRegistry`, three endpoints, and the oracle.** The Worker
gained `POST /api/session/create`, `POST /api/session/end` and
`GET /api/session/capacity`, backed by a SQLite-backed Durable Object holding
coordination state: which sessions are live, which room and identity each holds,
when each claim expires. Server-side only — nothing user-visible changed. This
is the project's first server-side storage and explicitly **not** the database
(P4).

**The design decision that made the invariant affordable is the lease, not the
code.** `SESSION_LEASE_SECONDS` (2h, hard-capped by the 6h LiveKit ceiling
imported from `livekit.js`) is deliberately two things at once: the maximum
session length, and the maximum time an *abandoned* slot stays held. The LiveKit
grant is minted for the same span, so slot and credential expire together and
cannot drift apart. That is what removes the need for a heartbeat — nothing has
to check in to stay alive, so rule 2 ("no heartbeats through the DO") costs
nothing to obey. `create` likewise returns everything the client needs in one
response, so nothing ever comes back to ask, which is what makes rule 1 free.

Cleanup is one demand-driven `alarm()` at the earliest pending expiry, re-armed
on wake. A clean session costs 3 requests / 0 alarms; an abandoned one costs
1 / 1 — no matter how far into its lease it was abandoned, and no matter how
long the registry then sits idle afterwards. (Nothing can be abandoned "after a
week": a session cannot outlive its 2h lease. The week is the *silence that
follows*, which is what the quick-vs-slow test actually varies, and what a
fixed-interval reaper would bill for.)

Fail-closed throughout, matching the rate limiter: a missing or throwing DO
binding refuses with 503 rather than handing out uncounted rooms; a malformed
`MAX_CONCURRENT_SESSIONS` fails the request with 500 rather than serving a
silent default; a wrong `endToken` (stored hashed) never frees someone else's
slot; a failed LiveKit mint gives the slot back rather than leaking capacity for
a full lease.

`MAX_CONCURRENT_SESSIONS` is **1** in production — one agent, one room, the
truth today. The second caller now gets `503 at_capacity` *with a reason*
instead of being silently ignored by a busy agent, which is already a product
improvement over `agent_busy`. Staging carries 4, where concurrency gets
exercised with no agent to over-admit onto.

### Key findings / surprises

**1. My own loop guard caught a defect in my own test, on the first run.** The
harness throws after 100 chained alarms, on the reasoning that a reaper
re-arming to the instant it woke for would spin an object awake forever — the
most expensive bug the file could contain, since a permanently awake DO bills
128 MB of wall clock and never hibernates. It fired immediately. Not on the
production code: I had written `h.instance.now = () => T0 + 60_000` in a test to
mean "a minute later", which froze the clock at a constant, so nothing ever
expired and `#rearm` re-armed to the same instant forever. Fixed by adding
`warpTo()` to the harness — moving the clock *without* running what came due,
which is a genuinely distinct real state (delayed alarm delivery), not a
shortcut around `advanceTo`.

**2. I claimed a mutation result more strongly than my own output supported, and
CodeRabbit caught it by deriving the contradiction from the shipped
assertions.** I wrote in `ROADMAP.md` that the short-vs-long row was *"the only
one that convicted the duration-scaling mutation"*. Review pointed out that the
abandoned row asserts `alarms === 1` and a 60-second sweep produces ~120 over a
2h lease, so row 2 must redden too. Re-ran both mutations; it was right. The
real table, now in §P1:

| Row | A: extra request on create | B: fixed 60s sweep |
|---|---|---|
| 1 · Clean | **red** | green |
| 2 · Abandoned | green | **red** |
| 3 · Short vs long | **red** | **red** |
| 4 · N concurrent | **red** | green |

Rows 1 and 4 never advance the clock far enough to wake a fixed-interval reaper.
Row 2 makes one request, so its ≤ 2 budget absorbs an extra one silently. **Row
3 is the only row red under both** — a weaker claim than I made, and a better
reason to keep the row than the one I gave.

Review also observed, correctly, that under mutation A row 3 fails on the
absolute pin (`requests === 3`) and *not* the `deepEqual` — both sessions gain
the same extra request, so the comparison sees nothing. Verified from the
failure message (`Expected values to be strictly equal`). The consequence is
worth keeping: the pins bound the constant, the comparison is the only thing in
the suite that detects cost tracking elapsed time, and neither is redundant.

The pattern is the same one this file has recorded before, in a new costume. It
was not a wrong number — it was a *true-sounding summary of evidence I did not
re-read*. The correction cost nothing; leaving it would have handed the next
person a tidier story than the evidence supports.

**3. Another test that could not fail on the thing it named.** My wrangler check
grepped the whole file for one occurrence of `class_name` and one of
`new_sqlite_classes`. Named environments inherit **neither** `durable_objects`
**nor** `migrations`, so it would have passed happily with `env.staging` missing
both — the top-level match alone satisfied it. It now parses the JSONC and walks
every scope, proves the parse before trusting it (`config.name` asserted first,
so a broken comment-stripper cannot make everything below vacuous), requires at
least one named environment, and checks *membership* rather than identity in
`new_sqlite_classes` so P2's `SpendLedger` can join that list without a rewrite.
Discrimination-tested by deleting staging's binding: exactly one test red.

**4. `storage.delete()` caps at 128 keys and throws above it.** Raised by review
with a doc citation, confirmed. `MAX_ALLOWED_CONCURRENT_SESSIONS` is 10,000, so
a valid configuration could put far more than 128 keys in one sweep — and it
would fail on the one occasion it matters most: every lease expiring together,
with the reaper as the only thing that can clear them. Now batched. The **test
harness was changed to enforce the real 128 limit**, because a fake that quietly
swallowed 10,000 would leave the chunking untestable, and untested chunking gets
deleted by whoever next finds it fussy.

**5. The authenticated capacity read was cacheable by shared proxies.**
`Cache-Control: max-age=5` with `X-Admin-Token` not in `Vary` lets a shared
cache key on the URL alone. Now `private, max-age=5`. Worth recording *why*
adding the header to `Vary` was not the fix here: `json()` merges
`corsHeaders(origin)` **last** so an extra header can never displace
`Access-Control-Allow-Origin`, and `corsHeaders` sets `Vary: Origin` — a `Vary`
passed through the extra-headers bag would be silently overwritten.

**6. The invariant's boundary is now stated rather than implied.** A session
cannot outlive its lease, so "constant regardless of duration" is not literally
true. The shipped claim is **no request is made as a function of elapsed time
within a lease**, and a lease is hours. Renewal, if longer sessions are ever
needed, is O(duration ÷ 2h) — bounded, and not O(seconds). An invariant with an
unstated boundary is one someone finds out about the hard way.

**7. The session-log PR (#33) then found three more, and one is the sharpest
instance of the pattern yet.** Reviewing the *correction*, CodeRabbit pointed
out that my new "N sessions expiring together cost ONE alarm" test ended with a
capacity read — and `#capacity` sweeps too. So a reaper that reclaimed *nothing*
would be cleaned up by that final request, and the test would still pass.

Verified by construction rather than accepted on argument: with `alarm()` gutted
to wake and reap nothing, and the new assertion removed, the test reports

```
✔ ORACLE many abandoned sessions sharing an expiry cost ONE alarm between them
```

A green tick over a completely broken reaper. The fix is one line —
`assert.equal(h.stored().size, 0)` **before** any request goes in — and the
lesson is one this file keeps recording in new costumes: *a test that observes
state through a call which can repair that state is not observing it.*

The same round corrected two over-claims. "The bound is the number of distinct
expiries, **never the number of sessions**" is false — distinct expiries equal
session count whenever creates do not coincide, which is the normal case. And I
framed the shared-alarm saving as generally "in our favour" when it applies only
to simultaneous creates. The half that actually carries the invariant is the
other one: **the bound does not grow with elapsed time.**

One finding was **rejected with evidence**: a request to change `afterwards` to
`afterward`. The repo uses `afterwards` 9 times to `afterward` once and mixes
BrE/AmE throughout (`cancelled` 6, `modelling` 2, `behaviour` 5 against
`behavior` 22) with no linter rule. Adopting a spelling convention is a
deliberate repo-wide decision, not a drive-by on two comment lines. CodeRabbit
agreed.

### Files changed

- **New** `workers/api/src/sessionRegistry.js` — the Durable Object.
- **New** `workers/api/test/sessionOracle.test.js` — the O(1) oracle, through
  the real HTTP surface.
- **New** `workers/api/test/sessionRegistry.test.js` — DO correctness, config
  fatality, the no-timer/no-WebSocket structural scan, per-environment wrangler
  assertions.
- **New** `workers/api/testkit/registryHarness.js` — the counting fake DO
  runtime. In `testkit/` rather than `test/` because `node --test` treats every
  file under a `test/` directory as a test file, and a helper reported as a
  passing test with nothing in it is a small lie in the output.
- `workers/api/src/index.js` — three routes, `sessionGate`, `callRegistry`
  (fail-closed), `registryRefusal`, the DO re-export, `json()` extra headers.
- `workers/api/wrangler.jsonc` — DO binding, `v1` SQLite migration,
  `SESSION_LIMITER`, and both config vars, in **both** environments.
- `workers/api/README.md` — the session-layer section and the lease rationale.
- `ROADMAP.md` — P1a marked shipped, the corrected mutation table, the lease
  boundary made explicit.

### Verification

- **88** worker tests (was 46), **89** frontend, **224** agent — all green
  locally and in CI on Linux.
- `npm run lint`, `npm run typecheck`, `npm run build`, markdown heading guard.
- `wrangler deploy --dry-run` on **both** environments before the PR.
- CodeRabbit: **5 findings, all 5 accepted, fixed, and confirmed resolved**;
  full re-review of the fix commit passed with no new findings.
- Four discrimination mutations run and recorded (extra request, fixed sweep,
  unchunked delete, staging missing its binding) — each reddened exactly the
  intended tests.
- **Production after merge:** deploy succeeded; the log shows
  `env.SESSION_REGISTRY (SessionRegistry) Durable Object` and
  `MAX_CONCURRENT_SESSIONS ("1")`. `scripts/check-live.sh` PASS on all three
  layers. Unauthenticated probes confirm the routes exist and the gates work —
  `/api/session/capacity` → **401** (not 503, so the new rate-limit binding
  deployed too), `/api/session/create` GET → **405**, control
  `/api/session/nope` → **404**. The DO binding itself could not be exercised
  end-to-end without the admin password, which is the CEO's to hold; what is
  observed is the deploy log and the routing, not a live session.

### Next

**P1b** — the lens wired to `/api/session/create`, admin-password gate retired.
Then **P1c**, which needs the CEO's hands: agent-per-session on the VPS and the
capacity constant, never yet measured.

---

## 2 August 2026 — P0 CLOSED: canon, CI, and the last owed fixes (#26, #27, #28 merged)

### Task (verbatim)

> "tested it and it worked, thou the ui looks generic, but i dont want ui and ux
> polishing to be something of todat but id like for it to be added in the
> roadmap, cause i would like a special sessio where all we will do is repolish
> the app ui and enhance user experiemce but for now lets focus on the nest P0
> PRs. movre on with the momentum."

### What I did

**#26 — the canon.** `ROADMAP.md` v2.2: the lens paragraph, the real state
(648 ms baseline, 8.7 scorecard, what does NOT exist), phases P0–P8, human-only
walls. §4 is 29 doctrine entries reconstructed from the failure narratives in
this file, each citing the session that paid for it. P7 is the CEO's design
session — its own brief, after P1, with the real system debt named.

**#27 — CI.** Nothing ran on a pull request. Both workflows were push-to-main
only, so the first automated opinion arrived after merge, and the Pages deploy
shipped without running a test. Four jobs now run on every PR; the deploy gates
on lint, typecheck and tests before building.

**#28 — the owed fixes.** The rate limiter fails closed. `agent/README` no
longer documents the pip trampoline. Python floor 3.10. Shutdown has the
regression test it never had.

### Key findings / surprises

**1. P6 was planned wrong, twice, and review caught both.** I wrote the macOS
camera extension as "embedded in the app bundle, no installer, no reboot".
Verified: it needs `OSSystemExtensionRequest` activation, the container app
**must be in `/Applications`**, and the user must clear a "System Extension
Blocked" alert. Then, asked to specify the microphone's packaging, I promoted
`AudioDriverKit` to a co-equal route **on the strength of the suggestion alone**
— and only checked on the next round, when it turned out Apple supports it for
*physical* audio devices only and **will not grant entitlements for virtual
ones**. Not a riskier route; a route that fails at the entitlement request.

Doctrine 6 says verify the invocation before believing the verdict. A review
suggestion is a verdict too, and deferring to a reviewer without checking is the
same failure as deferring to documentation without checking — it just feels more
polite. The useful consequence: the mic's admin-password install is a **fixed
constraint to design around**, which firms the estimate rather than widening it.

**2. CI paid for itself twice within a day of existing — both times on my
tests.** #27's own first run failed the bash harness on Linux: `git clone`
follows the remote's HEAD, the harness built its bare remote with a plain
`git init --bare`, and this Mac has `init.defaultBranch = main` globally. **The
harness only ever passed on machines configured like mine**, and had been
reporting 40/40 since #24. A blanket `2>/dev/null` I wrote then hid the reason,
surfacing it as a mismatched assertion rather than "the fixture did not build".

PR #28 repeated the shape: the shutdown harness printed READY *before*
`wait_for_stop` installed its handlers, so a signal arriving in that window got
the interpreter's default disposition. macOS lost that race rarely enough never
to fail; Linux lost it every time. Fixed with `loop.call_soon` — ordering, not a
sleep — and proven by probing `signal.getsignal(SIGTERM)` at the moment READY is
announced: `SIG_DFL` before, `installed` after.

**3. A fix for a test defect contained another test defect.** CodeRabbit was
right that the `run_seconds` test had no lower bound and could not fail on what
it named. Its suggested threshold — 0.25 s of wall clock on the subprocess —
would have produced **another test that cannot fail**: elapsed time includes
interpreter startup and importing `convert_agent`, which pulls numpy and torch
and costs over a second on its own. Found only by discrimination-testing the fix
rather than trusting it. The duration is now measured inside the child.

**4. The fail-open rate limiter was load-bearing for its own test suite.**
`isRateLimited` returned "not limited" on a missing binding so `node --test`
could run dependency-free — which meant the fail-open path could never be
removed without breaking the tests. That is how it survived a security review
and got written down as "deliberate and documented". The tests now inject a
permissive limiter, which is the more honest statement anyway.

**5. The README documented the exact command doctrine 13 forbids.** Twice.
`./.venv/bin/pip` — the `#!/bin/sh` trampoline holding an absolute path, on a
project that lost a session to precisely that and then wrote a doctrine entry
about it while the setup instructions kept telling you to do it.

**6. The SIGINT item was already fixed.** The spike branch's loop handlers are on
main and both signals already exit 0. Rather than invent a change, added the
guard that was missing.

### Files changed

- **New:** `ROADMAP.md`, `.github/workflows/ci.yml`, `agent/test_shutdown.py`
- **Changed:** `.github/workflows/deploy-pages.yml` (test gate),
  `workers/api/src/index.js` + `test/http.test.js` (fail closed),
  `agent/README.md` (3.10 floor, pip trampoline),
  `scripts/test-deploy-agent.sh` (branch portability, loud fixtures),
  `AGENTS.md`, `README.md`, `.gitignore`

### Verification

```text
CI (every PR, 4 jobs)      green — frontend, worker, agent 3.12, deploy harness
npm run lint / typecheck   clean
node --test src/lib/*      89 pass
workers/api node --test    43 pass  (was 35)
agent pytest -q            224 pass (was 221)
test-deploy-agent.sh       40 assertions
parentage (fails closed)   verified against origin/main on every merge
```

Discrimination mutations this session: 12, across the rate limiter (3), the
shutdown contract (2), the harness portability (3), the lens state (2) and the
deploy gate (2). One did not discriminate and exposed a missing test; one
exposed that a reviewer's proposed threshold was untestable.

### Next

**P1 — the session layer.** `POST /api/session/create`, a Durable Object ledger
(the Worker has zero storage bindings today), agent-per-session on the VPS, and
the capacity constant that has never been measured. This is where audio becomes
genuinely multi-user and where the shared room, the `agent_busy` state and the
admin-password gate all retire.

---

---

## 1 August 2026 — THE LENS ON `/`, BASE44 GONE, AND THE CANON WRITTEN DOWN (PRs #24 merged, #25 merged, branch docs/roadmap-canon)

### Task (verbatim)

> "i have ran the commands required of me to do on the vps, and its up and
> running, lets move ahead with the next thing which should be PR — P0: main UI
> wired to the real voice engine + Base44 excision, and remember to never forget
> git hygiene"

and, after the merge:

> "tested it and it worked, thou the ui looks generic, but i dont want ui and ux
> polishing to be something of todat but id like for it to be added in the
> roadmap, cause i would like a special sessio where all we will do is repolish
> the app ui and enhance user experiemce but for now lets focus on the nest P0
> PRs. movre on with the momentum."

### CEO-run drill — logged same day, per convention

**The CEO unlocked the lens at `/` against the live VPS agent and confirmed it
works.** Informal confirmation, not a scored drill: no analyzer report, no
scorecard, no latency figures taken. Recorded here so the result is owned by the
project rather than by a chat window — the exact failure this convention exists
to prevent.

Her one substantive note: **the UI is generic.** Deferred deliberately to a
dedicated design session rather than absorbed into feature work; now **P7** in
`ROADMAP.md`, scheduled after P1 because the session layer changes what the lens
page shows.

### What I did

**Box setup (CEO's hands, verified by me).** The three systemd units are
installed and the agent runs as `lumina-agent`, with `lumina-deploy.timer`
polling `origin/main` every two minutes. Deploys are now a property of merging.

**PR #25 — the lens on `/`, Base44 excised.** 107 files deleted, 33 runtime
dependencies removed, and a new product surface built on the same hook the
console uses.

- `src/lib/lensState.js` — the whole translation layer between the agent's
  protocol vocabulary and the product's, kept pure and unit-tested. Mode mapping
  (Direct↔passthrough, Converted↔convert), status derivation in severity order,
  and a median-of-five latency readout.
- `src/lib/micLevelMeter.js` — the mic amplitude lifecycle, every browser
  dependency injectable so it tests under plain node.
- `src/pages/Studio.jsx` — one decision, one action, everything rendered from
  agent-confirmed state.
- `src/hooks/useMicLevel.js` — five lines of React binding over the meter.

**PR (this one) — the canon.** `ROADMAP.md` v2.2: the lens paragraph, the real
state of the system, phases P0–P8, and a doctrine section reconstructed from the
failure narratives in this file. `graphify-out/` gitignored.

### Key findings / surprises

**1. The Vite plugin was load-bearing in a way nothing documented.** The Base44
plugin also supplied the `@` path alias that every file in `src/` imports
through. Deleting the plugin without noticing would have broken every import in
the codebase. Now declared explicitly in `vite.config.js`.

**2. A screenshot found a bug no test could.** The status line — the single piece
of text that says whether your voice is reaching the room — mounted with
framer-motion's enter animation armed, so it rendered at `opacity: 0` and was
invisible in the captured DOM. Confirmed in the dump, not inferred. Fixed with
`initial={false}`: the first status is already there, only changes animate.

**3. Nine rounds of CodeRabbit, twenty-five findings.** 24 accepted, 1 declined
with reasoning, 1 reframed at its root (CodeRabbit had correctly applied a rule I
had just written in `AGENTS.md`, and the rule was wrong — it forbade *naming* the
deleted vendor rather than *depending* on it, which would have deleted the
comment explaining why the `@` alias is declared manually).

**4. Six of the twenty-five were defects in my own tests.** This is the finding
worth carrying forward, and it is now doctrine entry 10. Two of the six were
tests that *could not fail*: one asserted `medianTailMs` honoured its window
using data whose median is identical either way, and I reported it to CodeRabbit
as fixed when it was not. One hung the runner for 240 s instead of failing —
a promise that only settles on abort, with the abort removed. The others: an
`indexOf` returning −1 that made a renamed field report as a deleted one, and
coverage claimed for a path the suite never reached.

**5. P6 was planned wrong, and CodeRabbit caught it in the roadmap.** I wrote the
macOS camera extension as "embedded in the app bundle, no installer, no reboot".
Verified against Apple's docs and the CMIO community writeups: the extension does
ship in the bundle, but it needs `OSSystemExtensionRequest` activation, the
container app **must be in `/Applications`**, and the user must clear a "System
Extension Blocked" alert in Privacy & Security. And the microphone is worse — an
`AudioServerPlugIn` installs to `/Library/Audio/Plug-Ins/HAL` as `root:wheel`,
which means a privileged installer, an admin password prompt, and a `coreaudiod`
restart before the device is discoverable. **The camera and mic are not one job
done twice**, and the mic — a first-class deliverable, since audio-only is a whole
product mode — is the harder half. I first widened the section to offer `AudioDriverKit` as
an alternative route with the same embedded flow as the camera — then checked,
and it is **not a route at all**: Apple supports AudioDriverKit for *physical*
audio devices only and states that entitlements will not be granted for virtual
ones. So the mic is an `AudioServerPlugIn`, its install friction is a fixed
product constraint rather than an open decision, and P7 owes it design time.
Worth recording that I added that route on a review suggestion and only verified
it on the next round — doctrine 6 says verify the invocation before believing the
verdict, and a suggestion is a verdict too.

**6. The leak the setup guard structurally could not reach.** `tick` runs from
the browser's animation-frame callback, not from inside the setup `try`. A throw
there escaped to the browser, scheduled no next frame, and never reached
teardown — the same leaked `AudioContext` the failure path already guarded,
arriving by a route that guard has no visibility into.

**7. Presence is not liveness.** A device unplugged mid-session leaves the
publication in place holding a track that has **ended** — still an object,
producing nothing. The ring animated silence while the readout said "live".
Filtered on `readyState === 'live'`, with an `ended` listener on the track
itself: that event produces no room event, so nothing else would ever re-read.

**8. `fetch()` has no timeout.** The unlock exchange could hang forever, leaving
the only entry to the lens disabled with no error. Not hypothetical here — the
CEO's Starlink intermittently blackholes DNS, already documented as a drill
hazard. One deadline across the whole exchange, not one per hop.

### Files changed

- **New:** `ROADMAP.md`, `src/lib/lensState.js` (+ test), `src/lib/micLevelMeter.js`
  (+ test), `src/hooks/useMicLevel.js`, `src/pages/Studio.jsx`,
  `src/pages/PageNotFound.jsx` (moved out of `src/lib/`)
- **Rewritten:** `src/App.jsx`, `vite.config.js`, `index.html`, `AGENTS.md`,
  `README.md` (head + verification gate), `src/lib/serverMint.js` (deadlines)
- **Deleted:** 107 files — every auth page, `src/components/studio/`,
  `src/components/admin/`, all 50 `src/components/ui/`, three dead hooks,
  `base44/`, `AuthContext`, `ovcClient`, the audio worklet
- **Config:** `package.json` (33 deps removed, renamed to `luminastream`),
  `jsconfig.json` (widened to `src/`, seven surfaced type errors fixed),
  `.gitignore` (`graphify-out/` in, dead `base44/` rule out)

### Verification

```text
parentage (fails closed)   origin/main is ancestor ✓, 10 commits, only this PR's
npm run lint               clean
npm run typecheck          clean
node --test src/lib/*      89 pass / 0 fail
npm run build              ✓ 852 kB
workers/api node --test    35 pass / 0 fail
agent pytest -q            221 pass
secrets scan (full diff)   no literals
```

Both routes rendered and screenshotted in real headless Chrome, in three states:
lens with no API configured, lens with `VITE_API_BASE` set, and the console.
Fourteen discrimination mutations run across the PR; every one failed the test it
was supposed to, except one that failed nothing and exposed a missing test — the
`stopped` guard in `teardown`, whose real job turned out to be suppressing a
redundant `report(0)` during a track swap. Test added, mutation re-run, 1 fail.

### Next

P0 continues: CI hardening (the workflow still runs **no tests at all**), then
the owed micro-fixes including the fail-open rate limiter. Then P1 — the session
layer, which is where audio becomes genuinely multi-user.

---

---

## 31 July 2026 — CTO HANDOVER + RECORD REPAIR: the VPS drill that was never logged (branch fix/vps-record-repair, PR pending, HOLD FOR CEO)

### Task (verbatim)

> You are now the CTO and Lead Developer for LuminaStream. The previous CTO (a web
> chat instance) was fired for losing the core product vision. I am the CEO.
>
> Your first mandatory task is to read CTO_HANDOVER.md, review our entire codebase,
> to understand where we are and where we are headed.
>
> YOUR OPERATING RULES:
>
> Alignment First: We have not started coding Stage 2 yet. Once you read the
> handover, you must summarize the previous CTO's mistake to prove you understand
> the 'Lens' vision (Virtual Camera + Virtual Mic), and align with me before
> writing code.
>
> Tooling & MCPs: You are authorized to install and configure any necessary MCP
> servers, skills, or sub-agents required for speed, accuracy, and execution, and
> plan ahead for the business logic and how we are going to approach this project.
> This includes tools for Git hygiene e.g creating pr before edit,commiting,
> waiting for coderabbit review, merge & sync local etc. because were designing for
> scale and for others to join etc, filesystem management, and UI/UX design (our
> product must be highly elegant with animated UIs, never something generic), tools
> that gives you eyes and ears if needed to be able to see what were doing when it
> comes to virtuals.
>
> Execution & Ownership: You write the code. If you need to spawn sub-agents for
> parallel tasks, you create and align them, but you own the final integration.
>
> Enterprise Scale: You must build for scale immediately. Implement proper caching,
> rate-limiting, and performance safeguards etc. Remember the mobile limitations and
> browser throttling physics from the handover. and you have the permision recommend
> whats best i want us to fasten up things while not compromising quality, security,
> performance.
>
> Plain English: You are highly technical, but when you speak to me, you explain
> your decisions, tradeoffs, and risks in plain, digestible English.
>
> Confirm you have read the codebase and the handover file. Tell me exactly how the
> VPS is currently working, summarize the previous CTO's mistake, and outline your
> exact step-by-step plan to kick off Stage 2.

Followed mid-session by a **VPS RECORD CORRECTION + OPERATIONS BRIEFING** from the
CEO correcting my report and specifying three writes (see below).

### What I did

- Read `CTO_HANDOVER.md`, the full codebase (agent/, src/, workers/api/, scripts/,
  .github/), `notes.md`, `devlog/SESSIONS.md`, `SPIKE.md`, `README.md`, `runbook.md`.
  Ran `scripts/check-live.sh` — all three layers PASS.
- Verified externally, before planning on top of them: Decart Lucy 2.5 pricing and
  SDK, macOS Camera Extension (CoreMediaIO) and AudioServerPlugIn feasibility,
  Windows `MFCreateVirtualCamera`, and the code-signing/notarization gates.
- Confirmed the lens vision (Virtual Camera + Virtual Microphone; LuminaStream is
  identity infrastructure, not a destination) and produced a Stage 2 plan. CEO
  decisions taken: engine-first sequencing as originally drafted; macOS first for
  the native shell; Base44 deleted in M0; video spend wall 180 s/session, ~$60 total.
- **Then got corrected on the VPS, and repaired the record** (this session's commit).

### Key findings

**1. Four "canon" documents in the handover never existed.** `ROADMAP.md` (v2.1),
`STAGE2_BLUEPRINT.md`, `COST_CONTROLS.md`, `MVP_BUDGET.md` — searched the working
tree, all 17 local+remote branches, and the full commit graph via
`--diff-filter=A` and `-S`. Never added, on any branch, ever. They lived in the
outgoing CTO's chat context. **The 27-entry doctrine list ("ROADMAP §5") is lost**;
the only surviving version is the handover's 6-line condensation. Reconstruction
from the failure narratives in this file is the recovery path.

**2. `/api/session/create` is not in our Worker.** The handover describes it as a
skeleton returning 503 until `DECART_API_KEY` is set. `workers/api/src/index.js`
has exactly three routes. The 503 being remembered is
`base44/functions/createSession/entry.ts` on the dead Base44 backend — which
**returns the raw Decart account key to the browser** (`entry.ts:64-73`). Noted as
the anti-pattern for M1.

**3. THE BIG ONE — I reconstructed a false history from an incomplete record.**
I read `notes.md:71` ("Amy to place it, I did not copy it"), found no VPS TTS drill
anywhere in `devlog/`, and reported to the CEO that the engine had never run on the
VPS — presenting the migration as the cheapest unclaimed win, worth ~350 ms.
**False.** It ran on 29 Jul and was graded at 648 ms. The method (trust the repo
over the handover) was right; the repo had a hole in it because CEO-run drills were
never logged. See the backfilled 29 Jul 22:15 entry below for the full record.

**4. The 8.7 / 8.3 scores the handover cited are real** — earned on the VPS
topology on 29 Jul. They are absent from the repo for the same reason: unlogged.
My report stated they "appear nowhere in the repo," which was true of the repo and
false of reality. Both are now recorded.

**5. Decart is less than half the assumed cost.** Verified against
`docs.platform.decart.ai` today: Lucy 2.5 realtime is **$0.02/sec at 720p
($1.20/min)**, not the $0.05/sec ($3/min) in the handover. Free credits on new
accounts. Volume/enterprise pricing exists via contact.

**6. Security posture note (not fixed here, queued for M0 PR D).**
`workers/api/src/index.js:47` — `isRateLimited` **fails open** when the binding is
missing. Deliberate and documented, so `node --test` runs without bindings. But if
a deploy ever drops the `ratelimits` block from `wrangler.jsonc`, the admin
password oracle becomes unthrottled and nothing errors.

### Files changed

- `CLAUDE.md` — new **VPS OPERATIONS** section (the box, the no-SSH wall, the
  fire-up runbook with startup gates, pull-then-pip, VPS-tracks-main, profile
  precedence, the Starlink DNS hazard). New same-day CEO-drill logging convention.
- `notes.md` — corrected the two stale lines (63, 71) in place with dated
  `[CORRECTED]` markers rather than rewriting them; new top entry.
- `devlog/SESSIONS.md` — this entry, plus the backfilled 29 Jul 22:15 VPS drill.

### A deliberate deviation, flagged

The CEO's briefing said to write "everything under THE VPS, COMPLETE" into
`CLAUDE.md`. **`CLAUDE.md` is a tracked file and this repo is PUBLIC.** Before this
commit, the raw VPS IP, the concrete `lumina@host` value, and the LiveKit project
subdomain appeared in **zero** tracked files — `.gitignore` carries an explicit rule
("Ops handover notes — contain raw VPS IPs/port maps; never commit") that exists to
keep it that way. Committing the literals would be a new public exposure of
infrastructure specifics.

I wrote the section complete with those three literals as placeholders pointing at
where the real values live. Nothing operational is lost — Claude has no SSH to the
box by design, so the literals are never needed by a future session. **Flagged to
the CEO for override; one word and I inline them.**

### Verification

- `scripts/check-live.sh` → PASS on all three layers (Worker `/api/health`,
  Pages `/`, Pages `/livekit-test`).
- Docs-only change: no code touched, no test suite affected.
- `git grep` confirms that no raw VPS IP, no concrete `lumina@host` value, and no
  LiveKit subdomain is tracked after this commit. **Placeholders deliberately
  remain** — `CLAUDE.md` carries `ssh lumina@<vps-host>` so the runbook reads as a
  runbook; the literal host is what stays out.

### Next

The analyzer report is **not available** — the CEO confirmed on 31 Jul that it was
not retained. The 29 Jul entry is therefore closed on stated provenance rather than
on a committed artifact (see its "Provenance" section), with her closed-headphone
listening test standing as the acceptance evidence for the voice engine. Then M0
PRs A–D, starting with the canon documents and the doctrine reconstruction.

**Merge authority changed this session.** The CEO granted standing permission to
merge, conditional on: the work is tested, and CodeRabbit's review has been read and
addressed. The hold-for-CEO default no longer applies to routine PRs. The three
human-only walls are unchanged — credential minting/scoping, DNS and custom domains,
and spend-authority keys remain hers alone.

---

## 30 July 2026 — 05:14 PDT — POST-STAGE-1 POLISH: loudness, governor console, --room, layout (PR pending, HOLD FOR CTO)

### Task (verbatim)

> POST-STAGE-1 POLISH (branch: feat/loudness-governor-console) — four tickets:
> 1. LOUDNESS NORMALIZATION: per-utterance loudness measurement + normalization
>    to a target level before enqueue, with a soft limiter (no clipping, ever).
>    Verify the right measurement approach for short utterances against practice
>    (RMS vs LUFS-style) and say which you chose and why. Knobs: loudness_normalize
>    (bool, default on for tts), loudness_target_db. CEO evidence: continuity holds
>    tone but volume sags across consecutive utterances; Speaker Boost doesn't
>    address level.
> 2. GOVERNOR → CONSOLE, CEILING-WALLED: session caps become knobs (tts_chars,
>    stt_seconds) adjustable from the console, server-side clamped to new env
>    ceilings (SPIKE_MAX_*_CEILING) that the client can NEVER exceed — requests
>    above ceiling clamp + report, same three-way disposition as every knob.
>    Env-only absolute ceiling is the wall; document the two-layer design.
> 3. AGENT --room FLAG: make the room name a first-class CLI flag/env so two
>    agent processes can serve two rooms concurrently (the manual two-session
>    test); log the room prominently at startup.
> 4. UI LAYOUT LEFTOVERS: the knob grid still collides at CEO's width (ticket 5
>    of #19 couldn't be live-verified) — fix against the real broadcast,
>    screenshots in the PR as evidence.
> Discipline unchanged: clamp-never-crash, applied-truth broadcast, captures,
> RVC suite green. PR → CodeRabbit → evidence → HOLD for CTO.

### What I did (branched off main; #18/#19/#20 all merged)

- **T1 loudness.** New `loudness.py`: measure each utterance's RMS, level to
  `loudness_target_db`, soft-knee limiter that ASYMPTOTES to a -1 dBFS ceiling
  (|out| < full scale for any input → cannot clip). **RMS, not integrated LUFS**
  — reasoned against BS.1770/EBU R128: integrated loudness gates over 400 ms
  blocks with a -10 LU relative gate, defined for program-length material and
  unstable on short utterances; and the problem is the relative level of ONE
  stationary voice, which RMS tracks directly (K-weighting buys ~nothing for a
  single spectrum). The engine BUFFERS the short utterance when normalization is
  on so the RMS is exact before enqueue; `tts_ttfb_ms` still marks the vendor's
  first chunk, tail is measured at the real enqueue, and the added wait is
  reported as `enqueue_delay_ms`. OFF ⇒ original chunk streaming, byte-identical.
  Knobs `loudness_normalize` (bool, default on) + `loudness_target_db` (-40…-12,
  default -20). Panel shows `lvl <out>dBFS`.
- **T2 governor two-layer** (REVERSES the #19 "no sliders" ruling, on the CEO's
  instruction). Caps became dynamic-float knobs `tts_chars`/`stt_seconds` whose
  slider max is a live env-only CEILING (`SPIKE_MAX_*_CEILING`). set_cap() clamps
  to [0, ceiling] with the three-way disposition; the ceiling DEFAULTS TO THE
  STARTING CAP, so without a deliberate override the console can only ever LOWER
  spend. A starting cap above its ceiling is clamped down; a malformed ceiling
  env is fatal. dynamic-float clamp branch added; metadata injects lo=0/hi=ceiling
  from the governor snapshot.
- **T3 --room.** `--room` is env-aware (`LIVEKIT_ROOM`) and logged in a banner at
  the very top of `main()`; two agents → two rooms, unambiguous from line one.
- **T4 layout.** Reproduced the collision: the grid splits 2-col at lg (viewport
  ≥1024px) but the container was `max-w-2xl` (672px) → ~320px cells, and a
  `<input type=range>` won't shrink that far so it collapsed to a bare thumb.
  Fix: widen the dev console to `max-w-4xl` (896px) → ~432px cells. Evidence:
  `devlog/evidence/knob-grid-before-after.png` at 1440px from the REAL broadcast
  + the exact KnobRow markup (generator committed for reproducibility).

### Key findings / surprises

- The streaming-vs-exact-RMS tension is real: exact per-utterance leveling needs
  the whole utterance, so I buffer (short utterances) and report the cost rather
  than hide it. For the shortest utterances the cost is ~0 (they already wait for
  force_prime). Keeping OFF byte-identical means the CEO can A/B the latency.
- The layout bug was NOT label overflow (my #19 truncate fix held) — it was the
  range input's intrinsic min-width in a viewport/container mismatch. The
  screenshot made it obvious (sliders → dots in the "before").
- Ceiling-defaults-to-cap is the crux that keeps this a guardrail, not a hole:
  the console gains a knob but an un-overridden environment can't spend a cent
  more than before.

### Files changed

- New: `agent/loudness.py`, `agent/test_loudness.py`, `devlog/evidence/*`.
- `agent/knobs.py` (loudness + Spend knobs, dynamic-float clamp, ceiling
  metadata), `agent/tts_engine.py` (buffered normalize path), `agent/convert_agent.py`
  (apply routing, snapshot, broadcast, --room), `agent/spend_governor.py`
  (ceilings + set_cap), `src/pages/LiveKitTest.jsx` (max-w-4xl, spend line,
  loudness panel), `agent/README.md`.
- Tests: `test_tts_engine.py`, `test_knobs.py`, `test_spend_governor.py`.

### Verification

- **212 py** (+11 over the session start's 201) · **28 node** · lint clean ·
  typecheck **60 (baseline, 0 in changed files)** · build green.
- RVC/VAD suites green (`test_bridge.py` + `test_vad.py` = 25) — loudness OFF and
  the RVC path never construct/touch the normalizer.
- Agent imports smoke-clean; `--room`/`LIVEKIT_ROOM` verified via `--help`.
- **Next:** CodeRabbit → evidence replies → **CTO presses merge**. Live E2E =
  volume-consistency A/B (loudness on/off), a cap slider drill + an over-ceiling
  raw set (watch the clamp), and two agents in two rooms.

---

## 30 July 2026 — 04:22 PDT — LOCK IN the tuning-session profile (agent/tts_profile.json, PR pending, HOLD FOR CTO)

### Task (verbatim)

> I have the final JSON config file from our tuning session. Create a file at
> agent/tts_profile.json, paste the JSON contents I will provide below into it,
> and open a PR to lock this profile in. [export JSON followed]

### What I did

- **Verified the export IS the profile format before overwriting.** The pasted
  file is the console's *export* shape (`exported_at`/`app_version`/`voice_name`
  metadata; `request_continuity` + `speed` nested inside `voice_settings`), which
  is not visually identical to the previous committed profile. Rather than trust
  that it "should" load, I traced the real loader:
  - `load_profile()` (convert_agent.py) validates only *is-JSON / is-a-dict* — no
    per-key schema — so the three metadata keys are read and then ignored.
  - `flatten_profile()` (knobs.py) hoists every key out of `voice_settings` and
    `pipeline` into a flat dict, so `request_continuity` (nested) lands top-level;
    maps `model`→`tts_model`; picks up top-level `voice`. `speed` is a real
    registered knob. Metadata keys match no knob and drop out.
  - `clamp_params()` range/type-checks every knob and only *logs* anything off —
    never crashes.
- **Ran the real path as a round-trip proof** (not an assertion): loaded the file
  through `flatten_profile → clamp_params → resolve_precedence`. Result: **zero
  rejected, zero clamped**; 14 knobs resolve; `startup_voice` pins to the CEO's
  voice; `request_continuity=True` sits on `eleven_multilingual_v2`, which
  **supports stitching** (would be gated on v3) — so continuity is genuinely live,
  not a silent no-op.
- Wrote the export **verbatim** as `agent/tts_profile.json` (the instruction, and
  the artifact is self-describing), branched `chore/lock-tts-profile` off main
  (both #18 and #19 are merged, so the voice/comfort/continuity knobs exist on the
  base), committed, opened the PR.

### Key findings / surprises

- **My initial worry was unfounded but worth checking.** `request_continuity`
  being nested inside `voice_settings` in the export looked like it would miss the
  top-level `request_continuity` knob — but `flatten_profile` merges all
  `voice_settings` keys up, so it lands correctly. Confirmed by running it.
- **Semantic deltas from the previous committed profile** (all deliberate, all the
  CEO's ear-found choices): `model` flash_v2_5 → **multilingual_v2** (quality ref,
  higher TTFB); `voice` now **pinned** to `kG0YavHsOC38yeSB7O1t`
  ("Celebrity lilcrush linda") — previously unset so `ELEVENLABS_VOICE_ID` stood;
  `voice_settings` `{}` → explicit values (which happen to equal the registry
  defaults, so runtime voice-setting behavior is unchanged, but they are now
  *pinned* rather than deferred to the clone's account settings); `vad_hangover_ms`
  200 → **300**.
- **The `_comment` doc block is dropped** — the exported artifact doesn't carry it,
  and it was partly stale for the new content (it said "voice_settings intentionally
  EMPTY", no longer true). The precedence/format is documented in
  `src/lib/configExport.js`, `agent/knobs.py`, and `agent/README.md`.
- **No secrets involved.** `voice_id` is an account voice identifier, already
  committed in the profile itself — not a credential. `ELEVENLABS_*` keys stay in
  secrets.env and are never referenced.

### Files changed

- `agent/tts_profile.json` — replaced with the tuning-session export (+15/−6).
- `devlog/SESSIONS.md`, `notes.md` — this log.

### Verification

- Round-trip through the real loader: **0 rejected, 0 clamped**; resolved config
  matches the file (voice pinned, model multilingual_v2, continuity live on a
  stitching-capable model, hangover 300, comfort −60).
- No code changed — only the committed config artifact + logs. RVC/tts suites
  unaffected (not re-run; no code delta).
- **Next:** CodeRabbit → evidence replies → **CTO presses merge**. Live acceptance
  = connect, confirm the CEO's voice + multilingual_v2 come up at startup and the
  resolved-config startup log matches the file.

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

## 29 July 2026 — 22:15 PDT — VPS PRODUCTION DRILL: TTS engine on the box, CEO scorecard 8.7 overall  ⟵ BACKFILLED 31 Jul 2026

> **This entry was written on 31 July 2026, two days late.** The drill was run by
> the CEO on the VPS and the result lived only in chat. The gap caused real damage:
> the incoming CTO read the stale `notes.md:71` ("Amy to place it, I did not copy
> it"), found no VPS drill in this log, and reported to the CEO that the TTS engine
> had never run on the VPS — proposing an already-completed migration as the
> project's biggest unclaimed win. **This is why CEO-run drills are now logged the
> same day** (convention added to `CLAUDE.md`). Chat is not a system of record.

### What happened

- **Keys placed (CEO's hands, human wall).** `ELEVENLABS_API_KEY` and
  `ELEVENLABS_VOICE_ID` appended to the VPS `~/luminastreamv1/secrets.env` by hand
  via `read -rs` piped append — values never rendered on screen, never in chat,
  never copied by an agent. This closed the last blocker recorded at `notes.md:71`.
- **Engine ran on the VPS**, through the full positive-preflight sequence:
  `STT READY` → `TTS READY (TTFB …ms)` → `PREFLIGHT OK` → connected to room.
- **Full live drill executed.** Capture:
  `agent/captures/vps_drill1/20260729-221506-696613` (on the box, not in git —
  `agent/captures/` is gitignored). Session header records `wall_time
  2026-07-29T22:15`, produced at `lumina@luminastream` — the self-identifying
  header doing exactly the job it was built for.

### Measured — VPS topology

| metric | VPS (29 Jul) | Mac/Starlink baseline (28 Jul) |
|---|---|---|
| tail latency p50 | **648 ms** | 932–954 ms (drill) / 1001 ms (live) |
| tail latency p95 | 1924 ms | 949–1009 ms (drill) / 1920 ms (live) |
| TTS TTFB, steady state | **81–129 ms** | ~344 ms p50 |

- **The p95 is one cold-start utterance**, not a distribution problem — the first
  synthesis of the session paying model-warmth cost. Fixed afterwards by
  warm-on-join (PR #18), which fires a real metered synthesis on
  `participant_connected` precisely because a GET ping cannot warm a voice model.
- **The TTFB collapse is the proof of location.** 81–129 ms steady-state is not
  reachable from the Mac, where measured Starlink RTT to `api.elevenlabs.io` alone
  was 200 ms TCP / 433 ms TLS. This drill ran where it says it ran.
- **The 28 Jul prediction was correct and is now closed.** *"VPS deploy should
  reach p50 ~550-650ms with zero code change"* — landed at 648 ms, inside the band,
  with no pipeline code touched.

### CEO scorecard (formal, this topology)

| axis | score |
|---|---|
| clean | 8 |
| latency-feel | 8.3 |
| is-it-ME | 8.5 |
| **overall** | **8.7** |

- This supersedes the earlier verbal *"clean 7/10, beats RVC on purity, emotions
  inconsistent vs live prosody"* (`notes.md:57`), which was an impression formed on
  the **Mac** topology at ~950 ms. Same engine, different latency, different verdict.
- **`is-it-ME` = 8.5 is the first time that judgement has been made at all.**
  `notes.md:59` correctly recorded that it had not been — that caveat is now closed.
- The 8.3 latency-feel score is the standing acceptance line: the CEO consciously
  revised the 1000 ms target after hearing this build. Her ears are the law.

### Provenance of these numbers — read before citing them

**The analyzer report was not retained and is not available** (CEO, 31 Jul 2026).
The capture directory `agent/captures/vps_drill1/20260729-221506-696613` lives on
the VPS and `agent/captures/` is gitignored, so no committed artifact backs the
figures above. This entry is therefore closed on the best evidence that exists,
not on the evidence we would have had if it had been logged on the day:

- **The latency figures and the scorecard are transcribed from the CEO's briefing
  of 31 Jul 2026.** They are her direct report of a drill she ran. Cite them as
  that — "CEO-reported, VPS drill 29 Jul" — never as analyzer output.
- **The acceptance judgement is first-hand and is not in doubt.** Before closing
  Stage 1, the CEO listened on closed headphones — the drill protocol's own
  standard — and confirmed she was satisfied with the voice engine. That listening
  test, not the numbers, is what closed Stage 1.
- **The one figure with independent corroboration is the TTFB.** 81–129 ms
  steady-state is unreachable from the Mac, where Starlink RTT to
  `api.elevenlabs.io` alone measured 200 ms TCP / 433 ms TLS (28 Jul, logged). The
  physics confirm the topology even though the report is gone.

**This is the cost of the gap, made concrete.** A drill was run, it passed, it
changed the project's direction — and the primary artifact is unrecoverable two
days later. Everything downstream now rests on a transcription. The same-day
logging convention added to `CLAUDE.md` in this PR exists so that this entry is
the last one that ever has to carry a section like this.

### Consequences for Stage 2

**Baseline re-derived: VPS TTS = 648 ms measured.** The remaining latency work is
optimization *from* 648 ms, not a migration. The "move the engine to the VPS"
track has been struck from the Stage 2 plan as already-done.

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
