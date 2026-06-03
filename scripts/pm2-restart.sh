#!/bin/bash
# Reliable restart for the pm2 fleet: orchestrator, backend, frontend.
#
# Why not `pm2 restart`? `pm2 restart` re-launches each app from the process
# definition cached in the pm2 daemon — the script path and the environment
# snapshot taken at the ORIGINAL `start` — and it re-reads whatever build
# artifact currently happens to sit in dist/. After a code change that makes it
# unreliable: a stale env snapshot, or a dist/ that was only half-written when
# restart fired, gets picked up and the old code keeps running. (This is the
# "pm2 restart didn't work, stop+start did" symptom.)
#
# This script removes that footgun by doing the safe thing every time:
#   1. rebuild each app's dist/ FROM SCRATCH (build:* already `rm -rf dist`),
#   2. `pm2 delete` the process so no cached definition/env survives,
#   3. start it fresh via the app's own `pm2` script (re-reads code AND env).
# That is the manual `stop`+`start` dance, automated and ordered after a clean
# rebuild.
#
# Usage:
#   bash scripts/pm2-restart.sh        # dev  fleet: orchestrator, backend, frontend
#   bash scripts/pm2-restart.sh prod   # prod fleet: *-prod
#
# Note: this does NOT run prisma migrations/seed. If the schema changed, run the
# full `pnpm run pm2` (dev) / `pnpm run pm2:prod` (prod) instead.

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

echo "[pm2-restart] ($FLAVOR) rebuilding orchestrator, backend, frontend from scratch…"
pnpm run build:orchestrator
pnpm run build:backend
pnpm run build:frontend

echo "[pm2-restart] removing cached pm2 process definitions…"
for name in orchestrator backend frontend; do
  pm2 delete "${name}${SUFFIX}" >/dev/null 2>&1 || true
done

echo "[pm2-restart] starting fresh pm2 processes…"
pnpm run \
  --filter ./apps/orchestrator \
  --filter ./apps/backend \
  --filter ./apps/frontend \
  --parallel "$PM2_SCRIPT"

pm2 save
pm2 list
echo "[pm2-restart] done — fleet restarted on freshly built code."
