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

# Git & merge workflow

One PR at a time. No step is skippable:

1. `git checkout main && git pull --ff-only origin main` — **sync first,
   every time.** `--ff-only` so a diverged local state fails loudly instead
   of quietly creating a merge commit.
2. `git checkout -b <type>/<slug>` — **off freshly-synced `main`, never off
   another feature branch.** Branching off an unmerged branch puts the
   parent's commits inside the child's diff, so the reviewer cannot tell
   the two changes apart.
3. Build. Commit with specific `git add <paths>` — **never `git add -A`.**
4. Push, open the PR.
5. Wait for CodeRabbit. Reply with evidence to **every** finding, including
   the ones you reject. It is the only independent reviewer this project
   has; never claim a throttled or ambiguous pass as clean — re-trigger.
6. **Merge** — see authority below.
7. `git checkout main && git pull --ff-only origin main` before starting
   anything else.

**Merge authority (CEO, 31 Jul 2026):** Claude may merge, conditional on
both — the work is tested, and CodeRabbit's review has been read and
addressed.

**Pre-merge parentage check — always against `origin/main`, never local
`main`.** A stale local `main` silently under-reports the diff, so the one
check meant to catch a mis-parented branch is exactly the check that fails
open:

```sh
git fetch origin \
  && git merge-base --is-ancestor origin/main HEAD \
  && git log --oneline origin/main..HEAD   # must show ONLY this PR's commits
```

Chained with `&&` deliberately: if the fetch fails, the ancestry test would
run against a stale `origin/main`; if the ancestry test fails, the branch is
mis-parented and the log output is meaningless. Each step is a precondition
for the next, so the chain must fail closed.

**The three human-only walls are unchanged and are not covered by that
permission:** credential minting/scoping, DNS and custom domains, and
spend-authority keys (`DECART_API_KEY`, `ELEVENLABS_API_KEY`). Those stay
the CEO's hands alone.

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
```sh
ssh lumina@<vps-host>

# code FIRST — and the branch check is the doctrine, not a formality:
# a plain `git pull` deploys whatever branch the box happens to be on.
cd ~/luminastreamv1 && git switch main && git pull --ff-only origin main

# deps SECOND
cd agent && ./.venv/bin/python -m pip install -r requirements.txt

./.venv/bin/python lk_smoke.py            # GATE: must print CONNECTED OK

# attach-or-create: plain `tmux new -s agent` errors if the session exists
tmux attach -t agent 2>/dev/null || tmux new -s agent

# optional session-cap raise for a long tuning session:
#   export SPIKE_MAX_TTS_CHARS=20000
#   export SPIKE_MAX_STT_SECONDS=1800

./.venv/bin/python convert_agent.py --engine tts --mode convert \
    --capture-dir captures/<session_name>      # add --room <name> for a second room

# detach: Ctrl-B then D
```

**One agent process per room.** If the `agent` session already exists and
has a live agent in it, stop that agent (Ctrl-C) before launching another
against the same room — two processes sharing the default identity collide
on LiveKit. A *second* room is fine and is the supported pattern: launch it
with `--room <name>` (and give it its own `--identity` if you also override
the default).

**Startup gates, in this order — do not proceed past a missing one:**
`STT READY` → `TTS READY (TTFB …ms)` → `PREFLIGHT OK` → connected to room.

## Agent process & deploys (systemd, pull-based)

The agent is a **systemd user service**, not a process in someone's tmux. tmux
is for attaching to watch; it is not what keeps the agent alive.

```sh
systemctl --user status  lumina-agent      # is it up, on what, since when
systemctl --user restart lumina-agent      # SIGTERM → clean aclose()
systemctl --user stop    lumina-agent
journalctl --user -u lumina-agent -f       # follow the log
journalctl --user -u lumina-agent -n 100 --no-pager

systemctl --user list-timers lumina-deploy.timer   # when the next poll fires
journalctl --user -u lumina-deploy -n 50 --no-pager
```

**Deploys are pull-based.** The box polls `origin/main` every two minutes and
deploys itself when the SHA moves. Nothing outside reaches in — the repo is
public, so this needs **no credential at all**, and there is no deploy key to
leak onto a machine holding `secrets.env`.

```sh
bash ~/luminastreamv1/scripts/deploy-agent.sh          # deploy now, on demand
touch ~/luminastreamv1/agent/.deploy-hold              # FREEZE (mid-drill)
rm    ~/luminastreamv1/agent/.deploy-hold              # unfreeze
cat   ~/luminastreamv1/agent/.deploy-state             # what happened, and when
```

**A crash loop is a spend leak, not just noise.** Every agent start fires a
real warm-up synthesis, and the governor is per-process — a hundred restarts is
a hundred fresh budgets. `StartLimitBurst=5` / `StartLimitIntervalSec=300` make
systemd give up and park the unit in `failed` rather than bill all night. If
you see `failed`, that limit did its job; fix the cause, then
`systemctl --user reset-failed lumina-agent`.

**Blue/green venvs.** `agent/.venv` is a **symlink** into `agent/.venvs/<sha>`.
Never `pip install` into a venv a live agent is using — a half-written package
only explodes on a later lazy import, which looks like a working agent with a
landmine in it. The deploy builds a new venv, proves it, then swaps the link;
the running process keeps its own by inode.

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
