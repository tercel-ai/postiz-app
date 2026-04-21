#!/bin/bash
# Redeploy orchestrator with clean workflow restart.
#
# Usage:
#   bash scripts/redeploy-orchestrator.sh dev
#   bash scripts/redeploy-orchestrator.sh prod
#   bash scripts/redeploy-orchestrator.sh prod --only-posts
export NODE_OPTIONS="--max-old-space-size=4096"
export NEXT_FONT_GOOGLE_MOCKED_RESPONSES=true

set -euo pipefail

# 0. Identify Environment
ARG1="${1:-}"

if [[ "$ARG1" == "prod" ]]; then
  ENV_NAME="prod"
  PM2_PROCESS="orchestrator-prod"
  NAMESPACE="prod"
  shift
elif [[ "$ARG1" == "dev" ]]; then
  ENV_NAME="dev"
  PM2_PROCESS="orchestrator"
  NAMESPACE="dev"
  shift
else
  echo "Error: Missing or invalid environment argument."
  echo "Usage: $0 {dev|prod} [options]"
  exit 1
fi

# Collect all remaining arguments
EXTRA_ARGS="${*:-}"

echo "=== Orchestrator Redeploy ($ENV_NAME) ==="
echo "Targeting PM2: $PM2_PROCESS"
echo "Namespace:     $NAMESPACE"
echo ""

# 1. Build FIRST — if it fails, no workflows are disrupted
echo "Step 1: Building..."
pnpm build 2>&1 | tail -5
echo ""

# 2. Terminate existing workflows
echo "Step 2: Terminating old workflows in $NAMESPACE..."
npx ts-node --project scripts/tsconfig.json scripts/terminate-workflows.ts --execute --namespace="$NAMESPACE" $EXTRA_ARGS
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
