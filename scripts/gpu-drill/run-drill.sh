#!/bin/bash
# GPU drill — the whole ceremony, teardown GUARANTEED by trap. The one
# invariant this wrapper exists for: no exit path leaves a pod billing.
#
#   bash scripts/gpu-drill/run-drill.sh
set -uo pipefail
cd "$(dirname "$0")/../.."

trap 'echo "[run-drill] tearing down (trap)"; bash scripts/gpu-drill/teardown.sh' EXIT

bash scripts/gpu-drill/provision.sh
node scripts/gpu-drill/drill-client.mjs
echo "[run-drill] drill complete — artifacts in scripts/gpu-drill/out/"
