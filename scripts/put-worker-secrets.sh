#!/usr/bin/env bash
#
# put-worker-secrets.sh — inject the API Worker's runtime secrets into
# Cloudflare from ./secrets.env using the pipe pattern, so no secret value is
# ever printed to the terminal or a CI log. Each value flows
# grep → cut → wrangler stdin and is never echoed.
#
#   Usage: scripts/put-worker-secrets.sh [staging|production]
#          default: staging.
#
# production's CODE is deployed only by the merge workflow, but its SECRETS are
# still set here, once, by a human (CI never sees the LiveKit/admin values).
#
# Auth: run after `npx wrangler login`, or `export CLOUDFLARE_API_TOKEN=<token>`
# first (the same narrow token CI uses — Workers Scripts:Edit is enough).
#
set -euo pipefail

ENVIRONMENT="${1:-staging}"
case "$ENVIRONMENT" in
  staging | production) ;;
  *) echo "usage: $0 [staging|production]" >&2; exit 2 ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS_FILE="$REPO_ROOT/secrets.env"
[ -f "$SECRETS_FILE" ] || { echo "error: $SECRETS_FILE not found (it is gitignored — create it)" >&2; exit 1; }

# The Worker reads these five from env. The first three are the sensitive
# LiveKit/admin credentials; the last two are also required for a functional
# Worker (session signing + the LiveKit URL kept out of the public repo).
SECRET_NAMES=(ADMIN_PASSWORD ADMIN_SESSION_SECRET LIVEKIT_API_KEY LIVEKIT_API_SECRET LIVEKIT_URL)

# staging → --env staging ; production → top-level (no --env). The `+` guard
# keeps the empty-array expansion safe under `set -u` on bash 3.2 (macOS).
ENV_FLAG=()
[ "$ENVIRONMENT" = "staging" ] && ENV_FLAG=(--env staging)

read_value() {
  # One secret's value, WITHOUT echoing it: first matching line, everything
  # after the first '=', CR/LF stripped. Empty output ⇒ missing or blank.
  grep -m1 -E "^${1}=" "$SECRETS_FILE" | cut -d= -f2- | tr -d '\r\n' || true
}

# Preflight: EVERY required secret must be present AND non-empty before we touch
# Cloudflare. A partial update can brick the Worker; worse, during a rotation a
# typo'd or absent key would be silently skipped, leaving the OLD secret in
# place (e.g. an ADMIN_SESSION_SECRET "kill switch" that never fires). So this
# is all-or-nothing: validate first, then set.
missing=()
for name in "${SECRET_NAMES[@]}"; do
  [ -n "$(read_value "$name")" ] || missing+=("$name")
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "error: required secret(s) missing or empty in secrets.env: ${missing[*]}" >&2
  echo "       set all ${#SECRET_NAMES[@]} first — nothing was changed." >&2
  exit 1
fi

cd "$REPO_ROOT/workers/api"

echo "Setting ${#SECRET_NAMES[@]} secrets on the '$ENVIRONMENT' Worker (values piped, never printed)…"
for name in "${SECRET_NAMES[@]}"; do
  # Pure pipe: the value goes straight from secrets.env into wrangler over
  # stdin, never landing in a shell variable or a log line.
  read_value "$name" | npx wrangler secret put "$name" ${ENV_FLAG[@]+"${ENV_FLAG[@]}"} >/dev/null
  echo "  ✓ $name"
done

echo "Done — ${ENVIRONMENT}. (re-run to rotate; values were never echoed)"
