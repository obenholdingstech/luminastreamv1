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

# 2. Report the state BEFORE, so the output says what was actually stuck rather
#    than only what was cleared.
echo -n "  before: "
curl -sS "$API/api/session/capacity" -H "X-Admin-Token: $TOKEN" \
  | jq -c '{enabled, live, capacity, available, pool}'

# 3. Release everything.
RELEASED="$(
  curl -sS -X POST "$API/api/session/reset" -H "X-Admin-Token: $TOKEN" \
    | jq -r '.released // "?"'
)"
echo "  released: $RELEASED slot(s)"

echo -n "  after:  "
curl -sS "$API/api/session/capacity" -H "X-Admin-Token: $TOKEN" \
  | jq -c '{enabled, live, capacity, available, pool}'
