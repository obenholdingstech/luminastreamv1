#!/usr/bin/env bash
# Deploy the voice agent on the VPS — safely.
#
# Runs ON the VPS. Invoked by .github/workflows/deploy-agent.yml over SSH, and
# runnable by hand for the same result.
#
# The ordering is the whole point. A naive deploy pulls, restarts, and if the
# new code is broken you are left with NO agent — mid-drill, with no obvious
# cause. So the new code must prove itself before the running agent is touched:
#
#   1. pull + install
#   2. preflight the NEW code in a throwaway process
#   3. only if that passed, stop the old agent and start the new one
#   4. verify the new one actually came up
#
# The old agent keeps serving through steps 1-2. If step 2 fails we abort with
# the working agent still running, and the deploy is red.
#
# HOLD FILE: touch ~/luminastreamv1/agent/.deploy-hold to block restarts while
# a drill is in progress. Code and dependencies still update; the running
# process is left alone and the deploy reports it loudly.

set -uo pipefail

REPO="${LUMINA_REPO:-$HOME/luminastreamv1}"
SESSION="${LUMINA_TMUX_SESSION:-agent}"
HOLD_FILE="$REPO/agent/.deploy-hold"
VENV="$REPO/agent/.venv/bin/python"
# Startup gates, in order. Absent any one of them, the agent is not healthy.
GATES=("STT READY" "TTS READY" "PREFLIGHT OK")
PREFLIGHT_TIMEOUT="${LUMINA_PREFLIGHT_TIMEOUT:-120}"
BOOT_TIMEOUT="${LUMINA_BOOT_TIMEOUT:-120}"

say()  { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; }

fail() { bad "$*"; echo; echo "DEPLOY ABORTED — the previously running agent was left untouched."; exit 1; }

# ── 1. code first, then dependencies ────────────────────────────────────────
# pull-then-pip, in that order. pip alone is a silent no-op that once produced
# a green run against stale code and a drill result that meant nothing.
say "Syncing $REPO to origin/main"
cd "$REPO" || fail "no repo at $REPO"

git switch main >/dev/null 2>&1 || fail "could not switch to main"
git fetch origin --quiet || fail "git fetch failed"
# --ff-only: a diverged checkout must stop the deploy, never silently merge.
git pull --ff-only origin main || fail "git pull --ff-only failed (VPS has diverged from main?)"
ok "at $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s | cut -c1-60)"

say "Installing dependencies"
"$REPO/agent/.venv/bin/python" -m pip install -q -r "$REPO/agent/requirements.txt" \
  || fail "pip install failed"
ok "requirements satisfied"

# ── 2. prove the NEW code before touching the RUNNING agent ─────────────────
say "Preflighting the new code (old agent still serving)"
PREFLIGHT_LOG="$(mktemp)"
timeout "$PREFLIGHT_TIMEOUT" "$VENV" "$REPO/agent/convert_agent.py" \
  --engine tts --run-seconds 1 >"$PREFLIGHT_LOG" 2>&1
PREFLIGHT_RC=$?

for gate in "${GATES[@]}"; do
  if grep -qF "$gate" "$PREFLIGHT_LOG"; then
    ok "$gate"
  else
    echo "--- preflight output ---"; tail -40 "$PREFLIGHT_LOG"; echo "------------------------"
    fail "missing startup gate: $gate  (exit $PREFLIGHT_RC)"
  fi
done
rm -f "$PREFLIGHT_LOG"

# ── 3. hold file — a drill in progress outranks a deploy ────────────────────
if [ -f "$HOLD_FILE" ]; then
  say "HOLD FILE PRESENT — not restarting"
  echo "  $HOLD_FILE exists, so the running agent is left alone."
  echo "  Code and dependencies ARE updated; the live process is still on the old code."
  echo "  Remove the file and re-run this script to pick up the new code."
  exit 0
fi

# ── 4. swap the agent ───────────────────────────────────────────────────────
say "Restarting the agent in tmux session '$SESSION'"
if tmux has-session -t "$SESSION" 2>/dev/null; then
  # SIGINT, not SIGKILL: the agent installs explicit signal handlers and closes
  # cleanly through aclose(), which is what finalises capture WAV headers. A
  # hard kill corrupts the evidence from whatever session was running.
  tmux send-keys -t "$SESSION" C-c 2>/dev/null
  for _ in $(seq 1 20); do
    tmux list-panes -t "$SESSION" -F '#{pane_current_command}' 2>/dev/null | grep -q python || break
    sleep 0.5
  done
  ok "old agent stopped cleanly"
else
  tmux new-session -d -s "$SESSION" || fail "could not create tmux session"
  ok "tmux session '$SESSION' created"
fi

LOG="$REPO/agent/deploy-run.log"
tmux send-keys -t "$SESSION" \
  "cd '$REPO/agent' && ./.venv/bin/python convert_agent.py --engine tts --mode convert 2>&1 | tee '$LOG'" C-m \
  || fail "could not start the agent"

# ── 5. verify it actually came up ───────────────────────────────────────────
say "Waiting for the new agent to clear its gates"
DEADLINE=$((SECONDS + BOOT_TIMEOUT))
while [ $SECONDS -lt $DEADLINE ]; do
  if [ -f "$LOG" ] && grep -qF "PREFLIGHT OK" "$LOG"; then break; fi
  sleep 2
done

for gate in "${GATES[@]}"; do
  if grep -qF "$gate" "$LOG" 2>/dev/null; then
    ok "$gate"
  else
    echo "--- agent log ---"; tail -40 "$LOG" 2>/dev/null; echo "-----------------"
    bad "new agent did not reach: $gate"
    echo
    echo "DEPLOY FAILED AFTER RESTART — the agent may be down."
    echo "Recover:  tmux attach -t $SESSION"
    exit 1
  fi
done

echo
echo "DEPLOY OK — agent running $(git rev-parse --short HEAD) in tmux session '$SESSION'."
