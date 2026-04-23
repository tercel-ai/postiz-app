#!/bin/bash
# Redeploy orchestrator with clean workflow restart.
#
# All deployment identity (namespace, PM2 process name) comes from .env —
# single source of truth, matches whatever the running app is using.
#
# Usage:
#   bash scripts/redeploy-orchestrator.sh
#   bash scripts/redeploy-orchestrator.sh --only-posts
export NODE_OPTIONS="--max-old-space-size=4096"
export NEXT_FONT_GOOGLE_MOCKED_RESPONSES=true

set -euo pipefail

# Pass through any extra args to terminate-workflows.ts (e.g., --only-posts).
EXTRA_ARGS="${*:-}"

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
PM2_PROCESS=$(read_env_value "PM2_ORCHESTRATOR_NAME")
PM2_PROCESS="${PM2_PROCESS:-orchestrator}"

echo "=== Orchestrator Redeploy ==="
echo "Targeting PM2: $PM2_PROCESS (from .env)"
echo "Namespace:     $NAMESPACE (from .env)"
echo ""

# 1. Build FIRST — if it fails, no workflows are disrupted
echo "Step 1: Building..."
pnpm build 2>&1 | tail -5
echo ""

# 2. Terminate existing workflows — namespace resolved by the ts script from .env
echo "Step 2: Terminating old workflows in $NAMESPACE..."
npx ts-node --project scripts/tsconfig.json scripts/terminate-workflows.ts --execute $EXTRA_ARGS
echo ""

# 3. Restart orchestrator immediately after terminate (minimize gap)
echo "Step 3: Restarting $PM2_PROCESS..."
pm2 restart "$PM2_PROCESS"
echo ""

echo "Done."
echo "  Auto-restarted: missingPostWorkflow, dataTicksSyncWorkflow (on boot)"
echo "  Post workflows: recreated by missingPostWorkflow within ~1 hour"
echo ""
echo "Verify: pm2 logs $PM2_PROCESS --lines 30 --nostream 2>&1 | grep -i 'workflow\|nondeterminism'"
