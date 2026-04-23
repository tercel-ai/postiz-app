#!/bin/bash
# Switch Temporal worker mode between 'merged' and 'per-provider'.
#
# Why a dedicated script:
#   - Both backend AND orchestrator must restart together. If only one
#     restarts, backend dispatches to old queues while orchestrator listens
#     on new queues (or vice versa), and activities hang forever.
#   - In-flight workflows bound to the old queue must be terminated first;
#     missingPostWorkflow will re-dispatch QUEUE posts to the new queue
#     within ~1 hour after orchestrator restarts.
#
# Deployment identity (namespace, PM2 process names) is read from .env —
# single source of truth.
#
# Usage:
#   bash scripts/switch-worker-mode.sh merged
#   bash scripts/switch-worker-mode.sh per-provider
export NODE_OPTIONS="--max-old-space-size=4096"
export NEXT_FONT_GOOGLE_MOCKED_RESPONSES=true

set -euo pipefail

ARG_MODE="${1:-}"

if [[ "$ARG_MODE" != "merged" && "$ARG_MODE" != "per-provider" ]]; then
  echo "Error: Missing or invalid mode argument."
  echo "Usage: $0 {merged|per-provider}"
  exit 1
fi

NEW_MODE="$ARG_MODE"

ENV_FILE=".env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: $ENV_FILE not found. Run this from the repo root."
  exit 1
fi

read_env_value() {
  local key="$1"
  grep -E "^${key}=" "$ENV_FILE" | tail -1 \
    | sed -E "s/^${key}=//; s/^\"(.*)\"$/\1/; s/^'(.*)'$/\1/"
}

NAMESPACE=$(read_env_value "TEMPORAL_NAMESPACE")
NAMESPACE="${NAMESPACE:-default}"
CURRENT_MODE=$(read_env_value "TEMPORAL_WORKER_MODE")
CURRENT_MODE="${CURRENT_MODE:-merged}"
BACKEND_PROCESS=$(read_env_value "PM2_BACKEND_NAME")
BACKEND_PROCESS="${BACKEND_PROCESS:-backend}"
ORCHESTRATOR_PROCESS=$(read_env_value "PM2_ORCHESTRATOR_NAME")
ORCHESTRATOR_PROCESS="${ORCHESTRATOR_PROCESS:-orchestrator}"

echo "=== Temporal Worker Mode Switch ==="
echo "Target mode: $NEW_MODE"
echo "Namespace:   $NAMESPACE (from .env)"
echo "Processes:   $BACKEND_PROCESS + $ORCHESTRATOR_PROCESS (from .env)"
echo ""

echo "Current mode: $CURRENT_MODE"
if [[ "$CURRENT_MODE" == "$NEW_MODE" ]]; then
  echo "Already in target mode. Nothing to do."
  exit 0
fi
echo ""

# 1. Update .env — portable across GNU/BSD sed by rewriting to a temp file
echo "Step 1: Updating $ENV_FILE..."
if grep -qE "^TEMPORAL_WORKER_MODE=" "$ENV_FILE"; then
  awk -v mode="$NEW_MODE" '
    /^TEMPORAL_WORKER_MODE=/ { print "TEMPORAL_WORKER_MODE=\"" mode "\""; next }
    { print }
  ' "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
else
  printf '\nTEMPORAL_WORKER_MODE="%s"\n' "$NEW_MODE" >> "$ENV_FILE"
fi
echo "  TEMPORAL_WORKER_MODE=$NEW_MODE"
echo ""

# 2. Build
echo "Step 2: Building..."
pnpm build 2>&1 | tail -5
echo ""

# 3. Terminate in-flight workflows in this namespace.
#    These are bound to old taskQueues — leaving them alive would strand
#    activities on queues no worker is listening to anymore.
echo "Step 3: Terminating in-flight workflows in '$NAMESPACE'..."
npx ts-node --project scripts/tsconfig.json scripts/terminate-workflows.ts --execute
echo ""

# 4. Restart backend AND orchestrator together with --update-env so PM2
#    picks up the new TEMPORAL_WORKER_MODE value.
echo "Step 4: Restarting $BACKEND_PROCESS + $ORCHESTRATOR_PROCESS..."
pm2 restart "$BACKEND_PROCESS" "$ORCHESTRATOR_PROCESS" --update-env
echo ""

echo "Done."
echo ""
echo "What happens next:"
echo "  - Orchestrator boots workers on new task queues ($NEW_MODE mode)"
echo "  - Backend dispatches new posts to matching queues"
echo "  - missingPostWorkflow will re-dispatch stuck QUEUE posts within ~1h"
echo ""
echo "Verify:"
echo "  pm2 logs $ORCHESTRATOR_PROCESS --lines 30 --nostream 2>&1 | grep -i 'worker\\|queue'"
echo "  pm2 env $ORCHESTRATOR_PROCESS | grep TEMPORAL_WORKER_MODE"
