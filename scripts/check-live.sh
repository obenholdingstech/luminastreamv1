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

# One HTTP GET: follow redirects, hard timeout, quiet. Appends the final HTTP
# status as a trailing line (via -w) so each check can require 200 AND still
# show the body for diagnostics. We do NOT use -f: a misbound domain that
# answers "/" with the Worker's 404 JSON must surface that JSON (and its 404)
# in the FAIL line, not a blank. Emits "<body>\n<status>" (status "000" if the
# request never connected).
fetch() { curl -sS -L --max-time 25 -w '\n%{http_code}' "$1" 2>/dev/null; }

# Split a fetch result into globals STATUS (last line) and BODY (the rest). The
# appended status is always the final line, so we split on the LAST newline —
# the body may itself contain newlines (HTML) and is preserved intact.
split_resp() { STATUS="${1##*$'\n'}"; BODY="${1%$'\n'*}"; }

echo "check-live: probing deployed reality"
echo "  worker: ${WORKER_URL}"
echo "  pages:  ${PAGES_URL}"
echo

# (a) Worker /api/health -> HTTP 200 + ok JSON.
split_resp "$(fetch "${WORKER_URL}/api/health")"
if [ "$STATUS" = "200" ] && printf '%s' "$BODY" | grep -q '"ok":[[:space:]]*true'; then
  pass "(a) Worker /api/health  HTTP ${STATUS} ${BODY}"
else
  fail "(a) Worker /api/health  expected HTTP 200 + {\"ok\":true,...}; got HTTP ${STATUS}: ${BODY:-<no response>}"
fi

# (b) Pages root -> HTTP 200, app HTML shell (#root), and NOT the Worker's JSON.
split_resp "$(fetch "${PAGES_URL}/")"
if [ "$STATUS" = "200" ] && printf '%s' "$BODY" | grep -q 'id="root"' && ! printf '%s' "$BODY" | grep -q '"ok":'; then
  pass "(b) Pages /            HTTP ${STATUS} app HTML shell (#root mount, not JSON)"
else
  fail "(b) Pages /            expected HTTP 200 + app HTML with #root and no JSON; got HTTP ${STATUS}: $(printf '%s' "${BODY:-<no response>}" | tr '\n' ' ' | head -c 160)"
fi

# (c) Pages /livekit-test -> HTTP 200, SPA fallback to the same app HTML, NOT JSON.
split_resp "$(fetch "${PAGES_URL}/livekit-test")"
if [ "$STATUS" = "200" ] && printf '%s' "$BODY" | grep -q 'id="root"' && ! printf '%s' "$BODY" | grep -q '"ok":'; then
  pass "(c) Pages /livekit-test HTTP ${STATUS} app HTML shell via SPA fallback (#root, not JSON)"
else
  fail "(c) Pages /livekit-test expected HTTP 200 + app HTML with #root and no JSON; got HTTP ${STATUS}: $(printf '%s' "${BODY:-<no response>}" | tr '\n' ' ' | head -c 160)"
fi

echo
if [ "$fails" -gt 0 ]; then
  echo "RESULT: FAIL — ${fails} layer(s) down"
  exit 1
fi
echo "RESULT: PASS — all 3 layers healthy"
