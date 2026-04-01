#!/bin/bash
# Redeploy orchestrator with clean workflow restart.
#
# Usage:
#   bash scripts/redeploy-orchestrator.sh

set -euo pipefail

PM2_PROCESS="${PM2_PROCESS:-orchestrator}"

echo "=== Orchestrator Redeploy ==="
echo ""

# 1. Terminate existing workflows via SDK
echo "Step 1: Terminating old workflows..."
npx ts-node --project scripts/tsconfig.json scripts/terminate-workflows.ts --execute
echo ""

# 2. Build
echo "Step 2: Building..."
pnpm build 2>&1 | tail -5
echo ""

# 3. Restart orchestrator
echo "Step 3: Restarting $PM2_PROCESS..."
pm2 restart "$PM2_PROCESS"
echo ""

echo "Done. missingPostWorkflow will recreate post workflows within minutes."
