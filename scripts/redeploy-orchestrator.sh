#!/bin/bash
# Redeploy orchestrator with clean workflow restart.
#
# Usage:
#   bash scripts/redeploy-orchestrator.sh
#   bash scripts/redeploy-orchestrator.sh --only-posts   # skip on-demand workflows
export NODE_OPTIONS="--max-old-space-size=4096"
export NEXT_FONT_GOOGLE_MOCKED_RESPONSES=true

set -euo pipefail

PM2_PROCESS="${PM2_PROCESS:-orchestrator}"
EXTRA_ARGS="${1:-}"

echo "=== Orchestrator Redeploy ==="
echo ""

# 1. Build FIRST — if it fails, no workflows are disrupted
echo "Step 1: Building..."
pnpm build 2>&1 | tail -5
echo ""

# 2. Terminate existing workflows
echo "Step 2: Terminating old workflows..."
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
