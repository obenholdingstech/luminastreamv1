# See AGENTS.md

Follow the instructions in `AGENTS.md`.

# Session logging convention
At the end of every working session (or when I say "log it"), do BOTH:
1. Append a full session record to devlog/SESSIONS.md (create devlog/ if
   missing): date/time heading, the task I gave you (verbatim), what you
   did, key findings/surprises, files changed, and verification results.
   Newest entry at TOP.
2. Add a 3-6 line summary to notes.md (also newest at top): decisions
   made, state changed, next action. Terse — this is the handover
   artifact, not a transcript.
Never log secrets, tokens, or contents of secrets.env in either file.
Both files get committed with the session's work.

**CEO-run drills are logged the SAME DAY.** Any drill the CEO executes —
on the VPS or anywhere else — gets its analyzer report and her scores
committed to devlog/SESSIONS.md that day, by whoever is at the keyboard.
Chat is not a system of record. This convention exists because it was
broken once: the 29 Jul 2026 VPS drill lived only in chat, and the next
CTO read the stale notes.md around it and reconstructed a false history
(see "the record had a hole" entry in notes.md). An unlogged result is
a result the project does not own.

# VPS OPERATIONS

The VPS is the production runtime for the voice agent. It is the topology
every current latency number was measured on.

## The box
- Verpex VPS, Ubuntu 24.04, user `lumina`. **Host address: see the ops
  handover / CEO's password manager — deliberately not committed** (this
  repo is PUBLIC; `.gitignore` keeps raw VPS IPs and port maps out of it).
- Repo: `~/luminastreamv1`. **The VPS tracks `main`, never feature
  branches.**
- Agent venv: `agent/.venv` on **Python 3.12**. This is why the VPS gets
  patched aiohttp via environment markers. **The Python 3.9 venv is the
  Mac harness — never confuse the two.**
- Agent runs in tmux session `agent`.
- Secrets: `~/luminastreamv1/secrets.env` (repo root, gitignored) holding
  the LiveKit and ElevenLabs values.

## The wall: no SSH
**Claude has no SSH access to this box, by design — it holds secrets.**
Every command below is executed by the CEO's hands. Claude's job is to
guide her through them and verify the pasted output. Never ask for the
box's credentials; never propose a command that would print secrets.

## Fire-up runbook (CEO executes, Claude verifies)
```
ssh lumina@<vps-host>
cd ~/luminastreamv1 && git pull                                    # code FIRST
cd agent && ./.venv/bin/python -m pip install -r requirements.txt  # deps SECOND
./.venv/bin/python lk_smoke.py                                     # GATE: CONNECTED OK
tmux new -s agent        # or: tmux attach -t agent

# optional session-cap raise for a long tuning session:
#   export SPIKE_MAX_TTS_CHARS=20000
#   export SPIKE_MAX_STT_SECONDS=1800

./.venv/bin/python convert_agent.py --engine tts --mode convert \
    --capture-dir captures/<session_name>      # add --room <name> for a second room

# detach: Ctrl-B then D
```

**Startup gates, in this order — do not proceed past a missing one:**
`STT READY` → `TTS READY (TTFB …ms)` → `PREFLIGHT OK` → connected to room.

## Doctrines
- **pull-then-pip.** `git pull` BEFORE `pip install`, always. `pip` alone
  is a silent no-op that once produced a vacuous drill result — green
  output, stale code, meaningless numbers.
- **VPS tracks `main`.** Never check out a feature branch on the box.
- **Profile is committed config.** `agent/tts_profile.json` is the
  production standard. Precedence: CLI/env > profile > voice defaults >
  registry defaults, resolved and logged at startup — read that log line
  to confirm what actually loaded.

## Environmental hazard
The CEO's Starlink intermittently blackholes `*.livekit.cloud` DNS.
**Pre-drill, on her Mac:** `nslookup <livekit-project-host>` — it must
answer. Fix: 1.1.1.1 at OS level, Chrome Secure DNS pinned. Drill
protocol: real Chrome only (never the VS Code preview), mic-processing
toggles OFF, closed headphones, macOS Mic Mode = Standard.
