# AGENTS.md

## Project Context

LuminaStream is a **lens, not a venue**: identity infrastructure that presents
to the operating system as a Virtual Camera and Virtual Microphone, which the
user then selects inside WhatsApp, Zoom, TikTok or Discord. The browser app in
this repo is the workshop and the demo stage — it is never the product.

Start with `README.md` for setup and deploy, and `CLAUDE.md` for the operating
rules that bind agents working here: session logging, git and merge workflow,
and VPS operations.

This repository was generated from a Base44 template and ran on a Base44
backend until that layer was deleted.

**Never build against it.** Any surviving *executable* reference — an import of
`@base44/*`, a `base44 dev` instruction, a dependency, a call to a hosted
Base44 endpoint — is stale, and the fix is to delete it, not to make it work.

Comments and docs that *name* the vendor while explaining what was removed and
why are deliberate and stay. `vite.config.js` declares the `@` alias explicitly
because the deleted plugin used to supply it; deleting that sentence is how the
alias gets quietly dropped by the next person tidying up. The rule is about
what the code depends on, not about which words appear in it.

## The pieces

- `src/` — the frontend. Two routes: `/` is the lens (the product surface),
  `/livekit-test` is the console (the dev instrument). Both drive the same
  agent through `src/hooks/useLiveKitVoice.js`.
- `src/lib/` — pure, unit-tested modules. Anything with real logic belongs
  here rather than inside a component, because this is the part that can be
  tested without a browser.
- `agent/` — the Python voice agent (STT → TTS), running as a systemd user
  service on the VPS. Has its own `README.md` and its own pytest suite.
- `workers/api/` — the Cloudflare Worker: health, admin session, LiveKit token
  mint. Zero dependencies, hand-rolled crypto, native rate-limit bindings.
- `scripts/` — deploy and drill tooling, including `deploy-agent.sh` and its
  bash test harness.

## Working notes

- **The agent is the source of truth.** The UI renders what the agent
  CONFIRMED, never what the user requested. Where the two can differ, show
  both. A control that silently reports its own optimism is a bug.
- **Instrument before tuning.** Measure, then change the thing the numbers
  convict — not the thing that seems likely.
- **Discrimination-test.** A test that cannot fail is worse than no test. When
  you fix something, break the fix and confirm the right test goes red.
- Run the checks in `README.md` → Verification before finishing code changes.
- Never commit secrets. `secrets.env` and `.env.local` are local-only.
