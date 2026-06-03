#!/bin/bash
# Restart the pm2 fleet: orchestrator, backend, frontend.
#
# This does NOT build. It restarts the processes against whatever already sits
# in each app's dist/. If you changed code, build first:
#   pnpm run build:backend   # or build:orchestrator / build:frontend / build
#
# Why not `pm2 restart`? In this deployment it can keep serving old code after
# a release. The reliable manual operation has been `pm2 stop <name>` followed
# by `pm2 start <name>`, so this script automates that exact flow.
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
    ;;
  prod)
    SUFFIX="-prod"
    ;;
  *)
    echo "Usage: $0 {dev|prod}" >&2
    exit 1
    ;;
esac

echo "[pm2-restart] ($FLAVOR) stopping pm2 processes…"
for app in orchestrator backend frontend; do
  pm2 stop "${app}${SUFFIX}"
done

echo "[pm2-restart] starting pm2 processes (no rebuild)…"
for app in orchestrator backend frontend; do
  pm2 start "${app}${SUFFIX}"
done

pm2 save
pm2 list
echo "[pm2-restart] done — fleet restarted on existing dist/ (no rebuild)."
