#!/usr/bin/env bash
#
# check-live.sh — the instrument this deployment incident lacked. It turns
# "is the stack actually up?" into a one-command question, forever. Three
# layers, one PASS/FAIL line each, nonzero exit if ANY layer is down:
#
#   (a) Worker  /api/health    -> expects {"ok":true,...} JSON
#   (b) Pages   /              -> expects the app HTML shell (a #root mount),
#                                 NOT the Worker's API JSON (the exact mix-up
#                                 that hid for a whole incident: the domain
#                                 pointed at the Worker, so "/" served JSON)
#   (c) Pages   /livekit-test  -> SPA fallback: the SAME app HTML shell, NOT
#                                 JSON (proves deep links render client-side)
#
# URLs default to the automated production addresses: the *.pages.dev apex and
# the Worker's workers.dev URL (the one baked into the frontend as
# VITE_API_BASE). Both are override-able, so this doubles as a smoke test for
# the custom domain once it is moved, or for staging:
#
#   WORKER_URL=https://api.luminastream.live \
#   PAGES_URL=https://studio.luminastream.live \
#     scripts/check-live.sh
#
# No -e: we probe all three layers and report every one, rather than bailing on
# the first failure. The exit code is driven by the failure counter at the end.
set -uo pipefail

WORKER_URL="${WORKER_URL:-https://luminastream-api.obenholdingsltd.workers.dev}"
PAGES_URL="${PAGES_URL:-https://luminastream-studio.pages.dev}"

# Trim a trailing slash so path joins stay clean.
WORKER_URL="${WORKER_URL%/}"
PAGES_URL="${PAGES_URL%/}"

fails=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; fails=$((fails + 1)); }

# One HTTP GET: follow redirects, hard timeout, quiet. We deliberately do NOT
# pass -f (fail-on-HTTP-error): the served *body* is the test (an app shell vs.
# API JSON), so we always want to see it — a misbound domain that answers "/"
# with the Worker's 404 JSON should surface that JSON in the FAIL line, not a
# blank. Prints whatever body came back.
fetch() { curl -sS -L --max-time 25 "$1" 2>/dev/null; }

echo "check-live: probing deployed reality"
echo "  worker: ${WORKER_URL}"
echo "  pages:  ${PAGES_URL}"
echo

# (a) Worker /api/health -> ok JSON.
health="$(fetch "${WORKER_URL}/api/health")" || true
if printf '%s' "$health" | grep -q '"ok":[[:space:]]*true'; then
  pass "(a) Worker /api/health  ${health}"
else
  fail "(a) Worker /api/health  expected {\"ok\":true,...}; got: ${health:-<no response>}"
fi

# (b) Pages root -> app HTML shell (#root), and NOT the Worker's JSON.
root="$(fetch "${PAGES_URL}/")" || true
if printf '%s' "$root" | grep -q 'id="root"' && ! printf '%s' "$root" | grep -q '"ok":'; then
  pass "(b) Pages /            app HTML shell (#root mount, not JSON)"
else
  fail "(b) Pages /            expected app HTML with #root and no JSON; got: $(printf '%s' "${root:-<no response>}" | tr '\n' ' ' | head -c 160)"
fi

# (c) Pages /livekit-test -> SPA fallback to the same app HTML, NOT JSON.
livekit="$(fetch "${PAGES_URL}/livekit-test")" || true
if printf '%s' "$livekit" | grep -q 'id="root"' && ! printf '%s' "$livekit" | grep -q '"ok":'; then
  pass "(c) Pages /livekit-test app HTML shell via SPA fallback (#root, not JSON)"
else
  fail "(c) Pages /livekit-test expected app HTML with #root and no JSON; got: $(printf '%s' "${livekit:-<no response>}" | tr '\n' ' ' | head -c 160)"
fi

echo
if [ "$fails" -gt 0 ]; then
  echo "RESULT: FAIL — ${fails} layer(s) down"
  exit 1
fi
echo "RESULT: PASS — all 3 layers healthy"
