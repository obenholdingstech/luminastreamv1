#!/usr/bin/env bash
# Regression tests for scripts/deploy-agent.sh.
#
# Runs the REAL deploy script against a throwaway git repo and a stub python,
# so the safety properties are DEMONSTRATED rather than asserted in a comment.
# No VPS, no network, no systemd — runnable anywhere, including a Mac.
#
#   bash scripts/test-deploy-agent.sh
#
# What it pins, and why each one exists:
#   T1  a healthy deploy builds a venv per sha, swaps the symlink, and
#       preflights in a THROWAWAY room — never the live room/identity, which
#       would evict the running agent (LiveKit evicts on duplicate identity).
#   T2  a failed preflight swaps NOTHING; the live agent keeps serving.
#   T3  the hold file blocks the swap but still builds and verifies.
#   T4  --poll is silent when origin/main has not moved (it runs every 2 min).
#   T5  a pre-existing .venv DIRECTORY is migrated, never deleted.
#   T6  statically: no symlink swap or restart can precede the gates.
set -u
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/deploy-agent.sh"
ROOT="$(mktemp -d)"; trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
chk() { if [ "$2" = "$3" ]; then printf '  \033[32mok\033[0m   %s\n' "$1"; PASS=$((PASS+1));
        else printf '  \033[31mFAIL\033[0m %s (got %s, want %s)\n' "$1" "$2" "$3"; FAIL=$((FAIL+1)); fi; }

build_repo() {   # $1 = dir, $2 = gates the stub agent will print
  rm -rf "$1" "$1.origin"; : > "$ROOT/args.txt"; : > "$ROOT/pip.txt"
  # HEAD is set EXPLICITLY rather than inherited from init.defaultBranch.
  # Without this the bare repo's HEAD is whatever the developer's global git
  # config says — `main` on a machine configured for it, `master` on a stock
  # CI runner. A later `git clone` of this remote then checks out nothing, and
  # every test that clones silently sets up wrong. `symbolic-ref` rather than
  # `git init -b main` so it works on git older than 2.28.
  # Checked, because this script sets -u and NOT -e: an unchecked failure here
  # would leave HEAD at the machine default and simply carry on, which is the
  # same silent-setup-failure the fatal path below exists to stop.
  if ! (mkdir -p "$1.origin" \
     && (cd "$1.origin" && git init -q --bare) \
     && git --git-dir="$1.origin" symbolic-ref HEAD refs/heads/main); then
    printf '  \033[31mFATAL\033[0m bare repo setup failed for %s\n' "$1"; exit 2
  fi
  mkdir -p "$1/agent" "$1/scripts"
  : > "$1/agent/requirements.txt"
  cat > "$1/agent/convert_agent.py" <<PYEOF
import sys, os
open(os.environ.get("ARGS_OUT", "/dev/null"), "a").write(" ".join(sys.argv[1:]) + "\n")
print("ARGS " + " ".join(sys.argv[1:]))
$2
PYEOF
  # NOT redirected to /dev/null. A blanket 2>/dev/null here once hid a broken
  # setup completely: the clone in T9 failed, its commit never reached the
  # remote, and the test reported a mismatched assertion instead of "the
  # fixture did not build". A setup that fails must say so.
  # `git branch -M main` below renames whatever init produced, so the working
  # repo needs no -b flag; only the BARE repo's HEAD had to be pinned.
  if ! (cd "$1" \
     && git init -q \
     && git add -A \
     && git -c user.email=t@t -c user.name=t commit -qm init \
     && git branch -M main \
     && git remote add origin "$1.origin" \
     && git push -q origin main \
     && git branch --set-upstream-to=origin/main main -q); then
    printf '  \033[31mFATAL\033[0m build_repo failed for %s\n' "$1"; exit 2
  fi
}

make_python_stub() {   # a fake python3: makes venvs, no-ops pip, execs real python
  mkdir -p "$ROOT/bin"
  cat > "$ROOT/bin/fakepython" <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" = "-m" ] && [ "${2:-}" = "venv" ]; then
  mkdir -p "$3/bin"
  cp "$0" "$3/bin/python"
  chmod +x "$3/bin/python"
  exit 0
fi
if [ "${1:-}" = "-m" ] && [ "${2:-}" = "pip" ]; then
  echo "$*" >> "${PIP_LOG:-/dev/null}"; exit 0
fi
exec /usr/bin/python3 "$@"
STUB
  chmod +x "$ROOT/bin/fakepython"
}

run() { ARGS_OUT="$ROOT/args.txt" PIP_LOG="$ROOT/pip.txt" LUMINA_REPO="$1" LUMINA_PYTHON="$ROOT/bin/fakepython" LUMINA_SERVICE="definitely-not-a-unit" \
        bash "$SCRIPT" "${2:-}" >"$ROOT/out.txt" 2>&1; echo $?; }

make_python_stub
GOOD='print("STT READY"); print("TTS READY (TTFB 91ms)"); print("PREFLIGHT OK")'
BAD='print("STT READY")'

echo "── T1  healthy build: venv per sha, symlink swapped, throwaway room ──"
R="$ROOT/r1"; build_repo "$R" "$GOOD"; rc=$(run "$R")
SHA="$(cd "$R" && git rev-parse --short HEAD)"
chk "exit 1 (no systemd unit in test env)" "$rc" "1"
[ -d "$R/agent/.venvs/$SHA" ]; chk "venv built at .venvs/<sha>" "$?" "0"
[ -L "$R/agent/.venv" ]; chk ".venv is a symlink" "$?" "0"
chk "symlink → this release" "$(readlink "$R/agent/.venv")" "$R/agent/.venvs/$SHA"
grep -q -- "--room preflight-" "$ROOT/args.txt"; chk "preflight used a throwaway room" "$?" "0"
grep -q -- "--identity echo-preflight-" "$ROOT/args.txt"; chk "preflight used a throwaway identity" "$?" "0"
grep -q -- "luminastream-test" "$ROOT/args.txt"; chk "never named the live default room" "$?" "1"
grep -q -- "echo-convert-agent" "$ROOT/args.txt"; chk "never used the live default identity" "$?" "1"

echo "── T2  preflight fails: NOTHING is swapped ──"
R="$ROOT/r2"; build_repo "$R" "$BAD"; rc=$(run "$R")
chk "exit 1" "$rc" "1"
[ -L "$R/agent/.venv" ]; chk "venv symlink NOT created" "$?" "1"
grep -q "was NOT touched" "$ROOT/out.txt"; chk "says the live agent is untouched" "$?" "0"
grep -q "missing startup gate: TTS READY" "$ROOT/out.txt"; chk "names the missing gate" "$?" "0"

echo "── T3  hold file: build+verify, but no swap ──"
R="$ROOT/r3"; build_repo "$R" "$GOOD"; touch "$R/agent/.deploy-hold"; rc=$(run "$R")
SHA="$(cd "$R" && git rev-parse --short HEAD)"
chk "exit 0 (a hold is not a failure)" "$rc" "0"
[ -d "$R/agent/.venvs/$SHA" ]; chk "venv still built" "$?" "0"
[ -L "$R/agent/.venv" ]; chk "symlink NOT swapped" "$?" "1"
grep -q "HOLD FILE PRESENT" "$ROOT/out.txt"; chk "says so loudly" "$?" "0"
grep -q "result=held" "$R/agent/.deploy-state"; chk "recorded as held" "$?" "0"

echo "── T4  --poll with no change: silent no-op ──"
R="$ROOT/r4"; build_repo "$R" "$GOOD"; rc=$(run "$R" --poll)
chk "exit 0" "$rc" "0"
chk "no output at all" "$(wc -c <"$ROOT/out.txt" | tr -d ' ')" "0"

echo "── T5  legacy .venv directory is migrated, never deleted ──"
R="$ROOT/r5"; build_repo "$R" "$GOOD"
mkdir -p "$R/agent/.venv/bin" && echo marker > "$R/agent/.venv/OLD_MARKER"
rc=$(run "$R")
[ -L "$R/agent/.venv" ]; chk ".venv became a symlink" "$?" "0"
ls "$R/agent/.venvs"/legacy-*/OLD_MARKER >/dev/null 2>&1; chk "old venv preserved under .venvs/legacy-*" "$?" "0"

echo "── T6  static: no swap/restart before the gates ──"
PF=$(grep -n 'Preflighting the new build' "$SCRIPT" | cut -d: -f1)
for pat in '_swap_symlink "' 'systemctl --user restart'; do
  L=$(grep -n "$pat" "$SCRIPT" | cut -d: -f1 | head -1)
  [ "$L" -gt "$PF" ]; chk "'$pat' (line $L) is after preflight (line $PF)" "$?" "0"
done
PIP=$(grep -n 'pip install -q -r' "$SCRIPT" | cut -d: -f1 | head -1)
grep -n 'pip install -q -r' "$SCRIPT" | grep -q '\$NEW_VENV'; chk "pip only ever installs into the NEW venv" "$?" "0"

echo "── T7  a half-built venv is rebuilt, not trusted ──"
# bin/python exists as soon as `python -m venv` returns. Without a completion
# marker, a failed pip install would wedge this sha forever.
R="$ROOT/r7"; build_repo "$R" "$GOOD"
SHA="$(cd "$R" && git rev-parse --short HEAD)"
mkdir -p "$R/agent/.venvs/$SHA/bin"; cp "$ROOT/bin/fakepython" "$R/agent/.venvs/$SHA/bin/python"
rc=$(run "$R")
grep -q "requirements.txt" "$ROOT/pip.txt"; chk "requirements reinstalled over the half-built venv" "$?" "0"
[ -f "$R/agent/.venvs/$SHA/.install-complete" ]; chk "completion marker written" "$?" "0"

echo "── T8  gates printed but a NONZERO exit still blocks the swap ──"
CRASH='print("STT READY"); print("TTS READY"); print("PREFLIGHT OK"); import sys; sys.exit(3)'
R="$ROOT/r8"; build_repo "$R" "$CRASH"; rc=$(run "$R")
chk "exit 1" "$rc" "1"
[ -L "$R/agent/.venv" ]; chk "symlink NOT swapped on an unverified build" "$?" "1"
grep -q "preflight exited 3" "$ROOT/out.txt"; chk "reports the exit code" "$?" "0"

echo "── T9  a non-agent change does not restart the agent ──"
R="$ROOT/r9"; build_repo "$R" "$GOOD"; rc=$(run "$R")   # first deploy establishes the venv
BEFORE="$(readlink "$R/agent/.venv")"
# Commit from a SEPARATE clone. Committing inside the deployed repo would put
# the change in local HEAD already, so there would be nothing upstream to pull
# and the poller would (correctly) see no change at all — testing nothing.
CLONE="$ROOT/clone9"
# -b main explicitly, and the whole setup fails loudly. Cloning without it
# follows the remote's HEAD, which is exactly the machine-dependent value that
# made this test pass on a developer laptop and fail on a stock CI runner —
# while the 2>/dev/null that used to sit here hid the reason completely.
if ! (git clone -q -b main "$R.origin" "$CLONE" \
   && cd "$CLONE" && echo doc >> README.md && git add -A \
   && git -c user.email=t@t -c user.name=t commit -qm docs \
   && git push -q origin main); then
  printf '  \033[31mFATAL\033[0m T9 fixture (clone/commit/push) failed\n'; exit 2
fi
: > "$ROOT/pip.txt"; rc=$(run "$R" --poll)
chk "exit 0" "$rc" "0"
chk "no rebuild (pip never ran)" "$(wc -c <"$ROOT/pip.txt" | tr -d ' ')" "0"
chk "venv symlink unchanged" "$(readlink "$R/agent/.venv")" "$BEFORE"
grep -q "result=skipped" "$R/agent/.deploy-state"; chk "recorded as skipped" "$?" "0"
chk "working tree still fast-forwarded" "$(cd "$R" && git rev-parse HEAD)" "$(cd "$R" && git rev-parse origin/main)"

echo "── T10 full happy path reaches the stray scan (zero matches) ──"
# T1-T9 all stop at the missing systemd unit, so the tail of the script — the
# restart, the gate re-verification, and the stray scan — was never executed.
# Stub systemctl/journalctl so the whole path runs, and pin that a zero-match
# pgrep records `ok` rather than misfiring. (`pgrep -fc` prints 0 AND exits 1
# on no match, which is exactly how the previous implementation went wrong.)
mkdir -p "$ROOT/sbin"
# The systemctl stub answers unit discovery from $SYSTEMCTL_UNITS (a file of
# `list-unit-files`-shaped lines; defaults to just the primary) and logs every
# invocation to $SYSTEMCTL_LOG so a test can assert exactly which units were
# restarted — and, as important, which were NOT.
cat > "$ROOT/sbin/systemctl" <<'SC'
#!/usr/bin/env bash
[ -n "${SYSTEMCTL_LOG:-}" ] && echo "$*" >> "$SYSTEMCTL_LOG"
case "$*" in
  *"show -p MainPID"*) echo 0 ;;   # no live service in the test env
  *list-unit-files*|*list-units*)
    if [ -n "${SYSTEMCTL_UNITS:-}" ]; then cat "$SYSTEMCTL_UNITS"
    else echo "lumina-agent.service enabled enabled"; fi ;;
  *) exit 0 ;;                     # restart / daemon-reload succeed
esac
SC
# journalctl answers per-unit: the unit named in $JOURNAL_BAD_UNIT never
# prints its gates, which is how a sick INSTANCE is simulated while its
# siblings stay healthy.
cat > "$ROOT/sbin/journalctl" <<'JC'
#!/usr/bin/env bash
unit=""; prev=""
for a in "$@"; do [ "$prev" = "-u" ] && unit="$a"; prev="$a"; done
case "$unit" in
  *"${JOURNAL_BAD_UNIT:-/none/}"*) printf 'STT READY
' ;;
  *) printf 'STT READY
TTS READY (TTFB 88ms)
PREFLIGHT OK
' ;;
esac
JC
chmod +x "$ROOT/sbin/systemctl" "$ROOT/sbin/journalctl"

R="$ROOT/r10"; build_repo "$R" "$GOOD"
rc=$(PATH="$ROOT/sbin:$PATH" ARGS_OUT="$ROOT/args.txt" PIP_LOG="$ROOT/pip.txt" \
     LUMINA_REPO="$R" LUMINA_PYTHON="$ROOT/bin/fakepython" LUMINA_SERVICE="lumina-agent" \
     bash "$SCRIPT" >"$ROOT/out.txt" 2>&1; echo $?)
chk "exit 0 — full path completes" "$rc" "0"
grep -q "DEPLOY OK" "$ROOT/out.txt"; chk "reports DEPLOY OK" "$?" "0"
# Tab-delimited field match: `result=ok\b` would ALSO match
# `result=ok-with-stray`, since \b treats the hyphen as a word boundary —
# the assertion would pass on exactly the outcome it exists to rule out.
grep -q "$(printf '\tresult=ok\t')" "$R/agent/.deploy-state"; chk "zero strays recorded as exactly ok" "$?" "0"
# Deliberately NOT asserting the absence of a stray warning here: pgrep is
# machine-global, so any unrelated process on a developer box matching the
# pattern would trip it. That is flaky, not meaningful. T11 pins detection
# positively instead, which is the direction that actually matters.

echo "── T11 a real stray IS detected and named ──"
# The zero-match case is not discriminating: both the old and new
# implementations land on `ok` with nothing running. The defect only bites
# when a stray EXISTS — so spawn one whose argv matches, and require the
# deploy to name its PID rather than silently reporting healthy.
( exec -a "python3 convert_agent.py --engine tts --mode convert" sleep 30 ) &
STRAY_PID=$!
sleep 0.3
R="$ROOT/r11"; build_repo "$R" "$GOOD"
rc=$(PATH="$ROOT/sbin:$PATH" ARGS_OUT="$ROOT/args.txt" PIP_LOG="$ROOT/pip.txt" \
     LUMINA_REPO="$R" LUMINA_PYTHON="$ROOT/bin/fakepython" LUMINA_SERVICE="lumina-agent" \
     bash "$SCRIPT" >"$ROOT/out.txt" 2>&1; echo $?)
grep -q "stray agent process" "$ROOT/out.txt"; chk "stray reported" "$?" "0"
grep -q "$STRAY_PID" "$ROOT/out.txt"; chk "names the offending PID" "$?" "0"
grep -q "result=ok-with-stray" "$R/agent/.deploy-state"; chk "recorded as ok-with-stray" "$?" "0"
kill "$STRAY_PID" 2>/dev/null; wait "$STRAY_PID" 2>/dev/null

echo "── T12 template instances: every agent unit restarted and gated ──"
# One box, two agents: the primary plus lumina-agent@room-a. The deploy must
# restart BOTH (all agents share one venv symlink, so a skipped instance runs
# old code forever), gate each BY NAME, and never try to start the bare
# template — `lumina-agent@.service` is a stencil, not a unit.
UF="$ROOT/units12"; cat > "$UF" <<'U'
lumina-agent.service enabled enabled
lumina-agent@.service disabled disabled
lumina-agent@room-a.service enabled enabled
U
R="$ROOT/r12"; build_repo "$R" "$GOOD"
: > "$ROOT/sysctl12.log"
rc=$(PATH="$ROOT/sbin:$PATH" ARGS_OUT="$ROOT/args.txt" PIP_LOG="$ROOT/pip.txt" \
     SYSTEMCTL_UNITS="$UF" SYSTEMCTL_LOG="$ROOT/sysctl12.log" \
     LUMINA_REPO="$R" LUMINA_PYTHON="$ROOT/bin/fakepython" LUMINA_SERVICE="lumina-agent" \
     bash "$SCRIPT" >"$ROOT/out.txt" 2>&1; echo $?)
chk "exit 0 with two live units" "$rc" "0"
grep -q -- "restart lumina-agent.service" "$ROOT/sysctl12.log"; chk "primary restarted" "$?" "0"
grep -q -- "restart lumina-agent@room-a.service" "$ROOT/sysctl12.log"; chk "instance restarted" "$?" "0"
grep -q -- "restart lumina-agent@.service" "$ROOT/sysctl12.log"; chk "bare template NOT restarted" "$?" "1"
grep -q "lumina-agent@room-a.service: PREFLIGHT OK" "$ROOT/out.txt"; chk "instance gated by name" "$?" "0"
grep -q "$(printf '\tresult=ok\t')" "$R/agent/.deploy-state"; chk "recorded ok" "$?" "0"

echo "── T13 a sick INSTANCE fails the deploy and is NAMED ──"
# The primary is healthy; room-b never prints its gates. "An agent is down" is
# not actionable; "lumina-agent@room-b is down" is — the deploy must fail AND
# say which. LUMINA_BOOT_TIMEOUT=1 so the gate wait does not stall the suite.
UF="$ROOT/units13"; cat > "$UF" <<'U'
lumina-agent.service enabled enabled
lumina-agent@room-b.service enabled enabled
U
R="$ROOT/r13"; build_repo "$R" "$GOOD"
rc=$(PATH="$ROOT/sbin:$PATH" ARGS_OUT="$ROOT/args.txt" PIP_LOG="$ROOT/pip.txt" \
     SYSTEMCTL_UNITS="$UF" JOURNAL_BAD_UNIT="room-b" LUMINA_BOOT_TIMEOUT=1 \
     LUMINA_REPO="$R" LUMINA_PYTHON="$ROOT/bin/fakepython" LUMINA_SERVICE="lumina-agent" \
     bash "$SCRIPT" >"$ROOT/out.txt" 2>&1; echo $?)
chk "exit 1 when one instance is sick" "$rc" "1"
grep -q "lumina-agent@room-b.service did not reach" "$ROOT/out.txt"; chk "the sick unit is NAMED" "$?" "0"
grep -q "lumina-agent.service: PREFLIGHT OK" "$ROOT/out.txt"; chk "the healthy sibling passed first" "$?" "0"
grep -q "restart-unhealthy" "$R/agent/.deploy-state"; chk "recorded restart-unhealthy" "$?" "0"

echo
printf 'passed %d, failed %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
