#!/usr/bin/env bash
#
# reset-sessions.sh — release every session slot the registry is holding.
#
#   Usage: scripts/reset-sessions.sh [production|staging]
#          default: production.
#
# WHY THIS EXISTS. A session holds a slot from Start to Stop, and a slot nobody
# releases stays held until its lease expires two hours later. That lease is a
# backstop for the paths where no client code can run — a hard tab close, a dead
# laptop. It is NOT an operation. The first live drill hit a held slot with no
# client left to release it, and the only recovery available was "wait until
# this afternoon", which is not a recovery.
#
# WHAT IT DOES. Releases EVERY slot, held or not. It cannot tell a stuck slot
# from a live one, because from the server they are identical: a record with
# time left on it looks the same whether someone is speaking into it or the tab
# closed an hour ago. So this can cut off a real session. Use it when the lens
# refuses with "busy" and nobody is using it.
#
# The admin password flows from the gitignored secrets.env straight into the
# request body and is never echoed, never in argv, and never in shell history —
# the same pipe discipline as put-worker-secrets.sh.
#
set -euo pipefail

ENVIRONMENT="${1:-production}"
case "$ENVIRONMENT" in
  production) API="https://luminastream-api.obenholdingsltd.workers.dev" ;;
  staging)    API="https://luminastream-api-staging.obenholdingsltd.workers.dev" ;;
  *) echo "usage: $0 [production|staging]" >&2; exit 2 ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS_FILE="$REPO_ROOT/secrets.env"
[ -f "$SECRETS_FILE" ] || {
  echo "error: $SECRETS_FILE not found (it is gitignored — create it)" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || { echo "error: jq is required" >&2; exit 1; }

# Read the password without ever putting it in argv or in the log. `--arg` on
# jq keeps it out of the command line too, by reading it from an exported
# variable rather than an argument.
ADMIN_PASSWORD="$(grep -E '^ADMIN_PASSWORD=' "$SECRETS_FILE" | head -1 | cut -d= -f2-)"
[ -n "$ADMIN_PASSWORD" ] || { echo "error: ADMIN_PASSWORD not set in secrets.env" >&2; exit 1; }
export ADMIN_PASSWORD

echo "reset-sessions: $ENVIRONMENT"

# 1. Exchange the password for a short-lived admin session.
TOKEN="$(
  jq -n '{password: env.ADMIN_PASSWORD}' \
    | curl -sS -X POST "$API/api/admin/verify" \
        -H 'Content-Type: application/json' --data-binary @- \
    | jq -r '.token // empty'
)"
unset ADMIN_PASSWORD
[ -n "$TOKEN" ] || { echo "error: admin verify failed (wrong password, or rate-limited)" >&2; exit 1; }

# Every call below FAILS CLOSED. `curl -sS` alone exits 0 on a 502 or 503 — the
# body is simply an error document — so without `-f` this script would print
# "released: ?" and exit 0, reporting a successful recovery having released
# nothing. A recovery tool that lies about recovering is worse than no tool:
# the operator walks away, and the product is still down.
#
# `-f` makes curl exit non-zero on an HTTP error, `pipefail` (set at the top)
# propagates that through the pipe, and the jq guards additionally require
# `ok: true` in the body — because a 200 carrying `{"ok": false}` is also a
# failure, and only the body knows that.
capacity_snapshot() {
  curl -fsS "$API/api/session/capacity" -H "X-Admin-Token: $TOKEN" \
    | jq -ce 'if .ok == true
              then {enabled, live, capacity, available, pool}
              else error(.error // "capacity request failed") end'
}

# 2. Report the state BEFORE, so the output says what was actually stuck rather
#    than only what was cleared.
echo -n "  before: "
capacity_snapshot

# 3. Release everything.
RELEASED="$(
  curl -fsS -X POST "$API/api/session/reset" -H "X-Admin-Token: $TOKEN" \
    | jq -er 'if (.ok == true and (.released | type == "number"))
              then .released
              else error(.error // "session reset failed") end'
)"
echo "  released: $RELEASED slot(s)"

echo -n "  after:  "
capacity_snapshot
