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
  mkdir -p "$1.origin" && (cd "$1.origin" && git init -q --bare)
  mkdir -p "$1/agent" "$1/scripts"
  : > "$1/agent/requirements.txt"
  cat > "$1/agent/convert_agent.py" <<PYEOF
import sys, os
open(os.environ.get("ARGS_OUT", "/dev/null"), "a").write(" ".join(sys.argv[1:]) + "\n")
print("ARGS " + " ".join(sys.argv[1:]))
$2
PYEOF
  (cd "$1" && git init -q && git add -A \
     && git -c user.email=t@t -c user.name=t commit -qm init \
     && git branch -M main && git remote add origin "$1.origin" \
     && git push -q origin main && git branch --set-upstream-to=origin/main main -q) 2>/dev/null
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
CLONE="$ROOT/clone9"; git clone -q "$R.origin" "$CLONE"
(cd "$CLONE" && echo doc >> README.md && git add -A \
   && git -c user.email=t@t -c user.name=t commit -qm docs && git push -q origin main) 2>/dev/null
: > "$ROOT/pip.txt"; rc=$(run "$R" --poll)
chk "exit 0" "$rc" "0"
chk "no rebuild (pip never ran)" "$(wc -c <"$ROOT/pip.txt" | tr -d ' ')" "0"
chk "venv symlink unchanged" "$(readlink "$R/agent/.venv")" "$BEFORE"
grep -q "result=skipped" "$R/agent/.deploy-state"; chk "recorded as skipped" "$?" "0"
chk "working tree still fast-forwarded" "$(cd "$R" && git rev-parse HEAD)" "$(cd "$R" && git rev-parse origin/main)"

echo
printf 'passed %d, failed %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
