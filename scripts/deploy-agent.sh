#!/usr/bin/env bash
# Deploy the voice agent — pull-based, blue/green, safe by construction.
#
# Runs ON the VPS. Nothing outside the box has access to it: the box checks the
# public repo itself, so there is no deploy key to steal and no inbound path to
# a machine holding secrets.env. That asymmetry is why this is pull and not push.
#
# USAGE
#   bash scripts/deploy-agent.sh          deploy now (manual, on demand)
#   bash scripts/deploy-agent.sh --poll   deploy only if origin/main moved (timer)
#
# FREEZE
#   touch  ~/luminastreamv1/agent/.deploy-hold    block the swap during a drill
#   rm     ~/luminastreamv1/agent/.deploy-hold    and unblock
#
# THE ORDER IS THE SAFETY PROPERTY
#   1. fetch; stop early if nothing changed
#   2. build a NEW venv for this release — the running agent's venv is never
#      touched, so a half-finished install cannot poison a live process
#   3. preflight the new code with the new venv, in a THROWAWAY LiveKit room
#   4. only if the gates pass: swap the venv symlink and restart via systemd
#   5. verify the new agent came up; report loudly if it did not
# The running agent serves untouched through steps 1-3. A failure before step 4
# leaves it running on the old code and the old venv.

set -uo pipefail

REPO="${LUMINA_REPO:-$HOME/luminastreamv1}"
AGENT_DIR="$REPO/agent"
VENVS_DIR="$AGENT_DIR/.venvs"
VENV_LINK="$AGENT_DIR/.venv"
HOLD_FILE="$AGENT_DIR/.deploy-hold"
STATE_FILE="$AGENT_DIR/.deploy-state"
SERVICE="${LUMINA_SERVICE:-lumina-agent}"
KEEP_VENVS="${LUMINA_KEEP_VENVS:-3}"
PREFLIGHT_TIMEOUT="${LUMINA_PREFLIGHT_TIMEOUT:-180}"
# Network and install calls are bounded too. lumina-deploy.service is
# Type=oneshot and systemd disables TimeoutStartSec for that type, so nothing
# bounds them at the unit level — an unbounded stall would hang forever AND
# block every future deploy, since systemd will not start a second instance.
NET_TIMEOUT="${LUMINA_NET_TIMEOUT:-120}"
INSTALL_TIMEOUT="${LUMINA_INSTALL_TIMEOUT:-600}"
BOOT_TIMEOUT="${LUMINA_BOOT_TIMEOUT:-120}"
PYTHON="${LUMINA_PYTHON:-python3}"
# Startup gates, in order. Absent any one, the build is not healthy.
GATES=("STT READY" "TTS READY" "PREFLIGHT OK")

POLL_MODE=0
[ "${1:-}" = "--poll" ] && POLL_MODE=1

# ── portability shims ───────────────────────────────────────────────────────
# The VPS is Ubuntu and has GNU coreutils, but `timeout` and `mv -T` are absent
# on BSD/macOS. Shimming them costs nothing and keeps the script runnable — and
# therefore testable — on a developer machine. An untestable deploy script is
# one you have to take on faith.
_timeout() {   # _timeout <seconds> <cmd...>
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"; else "$@"; fi
}

_swap_symlink() {   # _swap_symlink <target> <link>
  local target="$1" link="$2"
  # rename(2) over an existing symlink is atomic; `ln -sfn` unlinks first, so a
  # reader in that window sees no venv at all. Prefer the atomic path.
  if ln -sfn "$target" "$link.tmp" 2>/dev/null && mv -Tf "$link.tmp" "$link" 2>/dev/null; then
    return 0
  fi
  rm -f "$link.tmp"
  ln -sfn "$target" "$link"
}

say()  { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; }
note() { printf '  %s\n' "$*"; }

# Machine-readable breadcrumb. The status surface reads this later; for now it
# is what tells a human WHY the box is on the code it is on.
record() {
  printf '%s\tresult=%s\tsha=%s\tdetail=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "${2:-unknown}" "${3:-}" >> "$STATE_FILE"
}

fail() {
  bad "$*"
  record "failed" "${TARGET_SHA:-unknown}" "$*"
  echo
  echo "DEPLOY ABORTED — the running agent was NOT touched. It is still serving"
  echo "the previous code from its own venv."
  exit 1
}

# Only one deploy at a time. The timer and a manual run must never interleave
# a symlink swap with a venv build.
LOCK="$AGENT_DIR/.deploy.lock"
exec 9>"$LOCK" 2>/dev/null || true
if command -v flock >/dev/null 2>&1; then
  flock -n 9 || { echo "another deploy is already running — exiting"; exit 0; }
fi

# ── 1. has anything actually changed? ───────────────────────────────────────
cd "$REPO" || fail "no repo at $REPO"
# Nothing is printed before the change check: in poll mode the overwhelmingly
# common outcome is "nothing to do", and a heartbeat every two minutes would
# bury real deploys in the journal.
_timeout "$NET_TIMEOUT" git fetch origin --quiet || fail "git fetch failed or timed out"

CURRENT_SHA="$(git rev-parse HEAD 2>/dev/null)"
TARGET_SHA="$(git rev-parse origin/main 2>/dev/null)"
[ -n "$TARGET_SHA" ] || fail "could not resolve origin/main"

if [ "$CURRENT_SHA" = "$TARGET_SHA" ]; then
  if [ "$POLL_MODE" = 1 ]; then exit 0; fi   # silent: the common case
  say "Checking origin/main"
  note "already at $(git rev-parse --short HEAD) — redeploying anyway (manual run)"
else
  # Restarting the agent drops whatever session it is serving. A docs or
  # frontend merge must never do that: only changes that can alter how the
  # agent RUNS justify a rebuild and a restart. Everything else just
  # fast-forwards the working tree.
  TOUCHED="$(git diff --name-only "$CURRENT_SHA" "$TARGET_SHA" -- \
              agent/ scripts/deploy-agent.sh scripts/systemd/ 2>/dev/null)"
  if [ -z "$TOUCHED" ] && [ -L "$VENV_LINK" ] && [ "$POLL_MODE" = 1 ]; then
    _timeout "$NET_TIMEOUT" git switch main >/dev/null 2>&1
    if _timeout "$NET_TIMEOUT" git pull --ff-only origin main --quiet; then
      record "skipped" "$(git rev-parse --short HEAD)" "no agent changes"
    else
      # Worth a breadcrumb either way: a fast-forward that fails here means the
      # checkout has diverged, and the next agent change will abort on it.
      record "skip-pull-failed" "$(git rev-parse --short "$TARGET_SHA")" "fast-forward failed"
    fi
    exit 0
  fi
  say "Checking origin/main"
  note "$(git rev-parse --short HEAD) → $(git rev-parse --short "$TARGET_SHA")"
  [ -n "$TOUCHED" ] && note "agent-affecting changes: $(printf '%s' "$TOUCHED" | wc -l | tr -d ' ') file(s)"
fi

# ── 2. code first ───────────────────────────────────────────────────────────
say "Updating the working tree"
git switch main >/dev/null 2>&1 || fail "could not switch to main"
# --ff-only: a diverged checkout must STOP the deploy, never silently merge on
# production.
_timeout "$NET_TIMEOUT" git pull --ff-only origin main --quiet || fail "git pull --ff-only failed — the VPS has diverged from main"
SHORT_SHA="$(git rev-parse --short HEAD)"
ok "at $SHORT_SHA — $(git log -1 --pretty=%s | cut -c1-58)"

# ── 3. blue/green: build a NEW venv, never mutate the live one ──────────────
# pip installing into the venv a running process is using can leave a
# half-written package that only explodes on a later lazy import — a working-
# looking agent with a landmine in it. A venv per release makes that
# impossible: the running process keeps its own by inode, whatever we do here.
NEW_VENV="$VENVS_DIR/$SHORT_SHA"
say "Building venv for $SHORT_SHA"
mkdir -p "$VENVS_DIR" || fail "could not create $VENVS_DIR"

# bin/python exists the moment `python -m venv` returns — BEFORE pip runs. If
# pip then failed, a bin/python check would treat the half-built venv as done on
# the next attempt and never install requirements again, wedging this sha
# permanently. The marker is written only after a SUCCESSFUL install.
VENV_READY="$NEW_VENV/.install-complete"
if [ -f "$VENV_READY" ] && [ -x "$NEW_VENV/bin/python" ]; then
  note "reusing complete venv for this sha"
else
  rm -rf "$NEW_VENV"
  "$PYTHON" -m venv "$NEW_VENV" || fail "python -m venv failed (is python3-venv installed?)"
  _timeout "$INSTALL_TIMEOUT" "$NEW_VENV/bin/python" -m pip install -q --upgrade pip >/dev/null 2>&1
  _timeout "$INSTALL_TIMEOUT" "$NEW_VENV/bin/python" -m pip install -q -r "$AGENT_DIR/requirements.txt" \
    || fail "pip install failed or timed out — venv left incomplete, live agent untouched"
  : > "$VENV_READY"
fi
ok "venv ready at .venvs/$SHORT_SHA"

# ── 4. prove the new build, in a room of its own ────────────────────────────
# A throwaway room and identity. The default room+identity would collide with
# the LIVE agent, and LiveKit evicts on duplicate identity — the preflight
# would kick the very agent it is supposed to protect.
say "Preflighting the new build (live agent still serving)"
PREFLIGHT_ROOM="preflight-$$"
PREFLIGHT_LOG="$(mktemp)"
_timeout "$PREFLIGHT_TIMEOUT" "$NEW_VENV/bin/python" "$AGENT_DIR/convert_agent.py" \
  --engine tts --run-seconds 1 \
  --room "$PREFLIGHT_ROOM" --identity "echo-preflight-$$" \
  >"$PREFLIGHT_LOG" 2>&1
PREFLIGHT_RC=$?

# Gate TEXT is not enough. A process can print all three lines and then crash,
# or be killed by the timeout (124) mid-shutdown — and we would swap the live
# agent onto a build that never actually completed a clean run.
if [ "$PREFLIGHT_RC" -ne 0 ]; then
  echo "--- preflight output (tail) ---"; tail -30 "$PREFLIGHT_LOG"; echo "-------------------------------"
  rm -f "$PREFLIGHT_LOG"
  if [ "$PREFLIGHT_RC" -eq 124 ]; then
    fail "preflight timed out after ${PREFLIGHT_TIMEOUT}s"
  fi
  fail "preflight exited $PREFLIGHT_RC — build not verified"
fi

for gate in "${GATES[@]}"; do
  if grep -qF "$gate" "$PREFLIGHT_LOG"; then
    ok "$gate"
  else
    echo "--- preflight output (tail) ---"; tail -30 "$PREFLIGHT_LOG"; echo "-------------------------------"
    rm -f "$PREFLIGHT_LOG"
    fail "missing startup gate: $gate (exit $PREFLIGHT_RC)"
  fi
done
rm -f "$PREFLIGHT_LOG"

# ── 5. hold file — a drill in progress outranks a deploy ────────────────────
if [ -f "$HOLD_FILE" ]; then
  say "HOLD FILE PRESENT — not swapping"
  note "$HOLD_FILE exists, so the running agent is left alone."
  note "Code and the new venv ARE built and verified; the live process is still"
  note "on the old code. Remove the file and re-run to complete the swap."
  record "held" "$SHORT_SHA" "deploy-hold present"
  exit 0
fi

# ── 6. swap: atomic symlink, then systemd ───────────────────────────────────
say "Activating $SHORT_SHA"
# One-time migration: a real .venv directory becomes a managed release. Moving
# it is safe even while in use — the running process holds it by inode.
if [ -d "$VENV_LINK" ] && [ ! -L "$VENV_LINK" ]; then
  mv "$VENV_LINK" "$VENVS_DIR/legacy-$(date -u +%Y%m%d%H%M%S)" \
    || fail "could not migrate the legacy .venv directory"
  note "migrated the pre-existing .venv into .venvs/ (kept, not deleted)"
fi
# ln -sfn is unlink-then-link: a reader in that window sees no venv at all.
# Create beside, then rename — rename(2) is atomic.
_swap_symlink "$NEW_VENV" "$VENV_LINK" || fail "could not swap the venv symlink"
ok "venv symlink → .venvs/$SHORT_SHA"

if systemctl --user list-unit-files "$SERVICE.service" >/dev/null 2>&1; then
  # SIGTERM (systemd's default) is handled by the agent's own signal handlers,
  # which close through aclose() and finalise capture WAV headers. Never a hard
  # kill: that corrupts the evidence of whatever session was running.
  systemctl --user restart "$SERVICE" || fail "systemctl --user restart $SERVICE failed"
  ok "restarted $SERVICE"
else
  bad "systemd unit '$SERVICE' not installed"
  note "Code and venv are updated and verified, but the process was not restarted."
  note "Install the units (see scripts/systemd/README or the repo README), or"
  note "restart the agent by hand to pick up $SHORT_SHA."
  record "swapped-no-restart" "$SHORT_SHA" "systemd unit missing"
  exit 1
fi

# ── 7. verify it actually came up ───────────────────────────────────────────
say "Waiting for the new agent to clear its gates"
DEADLINE=$((SECONDS + BOOT_TIMEOUT))
SINCE="$(date -u +%Y-%m-%d\ %H:%M:%S)"
while [ $SECONDS -lt $DEADLINE ]; do
  if journalctl --user -u "$SERVICE" --since "$SINCE" --no-pager 2>/dev/null \
      | grep -qF "PREFLIGHT OK"; then break; fi
  sleep 2
done

LOGS="$(journalctl --user -u "$SERVICE" --since "$SINCE" --no-pager 2>/dev/null)"
for gate in "${GATES[@]}"; do
  if printf '%s' "$LOGS" | grep -qF "$gate"; then
    ok "$gate"
  else
    echo "--- journal (tail) ---"; printf '%s\n' "$LOGS" | tail -30; echo "----------------------"
    bad "the new agent did not reach: $gate"
    record "restart-unhealthy" "$SHORT_SHA" "missing gate: $gate"
    echo
    echo "DEPLOY FAILED AFTER RESTART — the agent may be down."
    echo "  systemctl --user status $SERVICE"
    echo "  journalctl --user -u $SERVICE -n 100 --no-pager"
    exit 1
  fi
done

# ── 8. keep the last few releases, drop the rest ────────────────────────────
ACTIVE="$(readlink -f "$VENV_LINK")"
# shellcheck disable=SC2012
ls -1dt "$VENVS_DIR"/*/ 2>/dev/null | tail -n "+$((KEEP_VENVS + 1))" | while read -r old; do
  [ "$(readlink -f "$old")" = "$ACTIVE" ] && continue   # never the live one
  rm -rf "$old" && note "pruned $(basename "$old")"
done

# A hand-started agent (e.g. left running in tmux from before systemd) would
# join the same room under the SAME default identity, and LiveKit evicts on
# duplicate identity — the two would fight over the slot. systemd cannot see
# it, so say so loudly rather than let it look like a flaky connection.
STRAY="$(pgrep -fc 'convert_agent\.py' 2>/dev/null || echo 0)"
if [ "${STRAY:-0}" -gt 1 ]; then
  bad "$STRAY convert_agent.py processes are running — expected 1"
  note "A hand-started agent is probably still alive (tmux?). Two agents sharing"
  note "the default identity evict each other. Find and stop the stray:"
  note "  pgrep -af convert_agent.py"
  record "ok-with-stray" "$SHORT_SHA" "$STRAY agent processes"
else
  record "ok" "$SHORT_SHA" "healthy"
fi
echo
echo "DEPLOY OK — $SERVICE running $SHORT_SHA."
