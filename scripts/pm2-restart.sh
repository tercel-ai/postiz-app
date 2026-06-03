#!/bin/bash
# Reliable restart for the pm2 fleet: orchestrator, backend, frontend.
#
# This does NOT build. It restarts the processes against whatever already sits
# in each app's dist/. If you changed code, build first:
#   pnpm run build:backend   # or build:orchestrator / build:frontend / build
#
# Why not `pm2 restart`? `pm2 restart` re-launches each app from the process
# definition cached in the pm2 daemon — the script path and the environment
# snapshot taken at the ORIGINAL `start`. A stale env snapshot or a cached
# definition can survive, so the old process keeps running and the restart
# "doesn't take". (This is the "pm2 restart didn't work, stop+start did" symptom.)
#
# This script does the reliable stop+start dance every time:
#   1. `pm2 delete` the process so no cached definition/env survives,
#   2. start it fresh via the app's own `pm2` script (re-reads code AND env).
#
# Usage:
#   bash scripts/pm2-restart.sh        # dev  fleet: orchestrator, backend, frontend
#   bash scripts/pm2-restart.sh prod   # prod fleet: *-prod
#
# Note: this does NOT run prisma migrations/seed or build. If the schema changed,
# run the full `pnpm run pm2` (dev) / `pnpm run pm2:prod` (prod) instead.

set -euo pipefail
cd "$(dirname "$0")/.."

FLAVOR="${1:-dev}"
case "$FLAVOR" in
  dev)
    SUFFIX=""
    PM2_SCRIPT="pm2"
    ;;
  prod)
    SUFFIX="-prod"
    PM2_SCRIPT="pm2:prod"
    ;;
  *)
    echo "Usage: $0 {dev|prod}" >&2
    exit 1
    ;;
esac

echo "[pm2-restart] ($FLAVOR) removing cached pm2 process definitions…"
for name in orchestrator backend frontend; do
  pm2 delete "${name}${SUFFIX}" >/dev/null 2>&1 || true
done

echo "[pm2-restart] starting fresh pm2 processes (no rebuild)…"
pnpm run \
  --filter ./apps/orchestrator \
  --filter ./apps/backend \
  --filter ./apps/frontend \
  --parallel "$PM2_SCRIPT"

pm2 save
pm2 list
echo "[pm2-restart] done — fleet restarted on existing dist/ (no rebuild)."
