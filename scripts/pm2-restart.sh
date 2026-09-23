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

# This restarts definitions pm2 already holds; it cannot create them. Bail out
# with a useful pointer instead of failing halfway through the fleet.
REGISTERED=$(pm2 jlist 2>/dev/null | node -e '
  let raw = "";
  process.stdin.on("data", (d) => (raw += d)).on("end", () => {
    let list = [];
    try { list = JSON.parse(raw); } catch { /* pm2 not running / no JSON */ }
    process.stdout.write(list.map((p) => p.name).join("\n"));
  });
')

MISSING=""
for app in orchestrator backend frontend; do
  if ! grep -qxF "${app}${SUFFIX}" <<<"$REGISTERED"; then
    MISSING="${MISSING}${MISSING:+ }${app}${SUFFIX}"
  fi
done

if [[ -n "$MISSING" ]]; then
  echo "[pm2-restart] Not registered with pm2: $MISSING" >&2
  echo "[pm2-restart] Nothing to restart. Register the fleet first:" >&2
  echo "                pnpm run pm2:start${SUFFIX:+:prod}" >&2
  exit 1
fi

echo "[pm2-restart] ($FLAVOR) stopping pm2 processes…"
for app in orchestrator backend frontend; do
  # Already-stopped is fine — don't abort the fleet restart over it.
  pm2 stop "${app}${SUFFIX}" || true
done

echo "[pm2-restart] starting pm2 processes (no rebuild)…"
for app in orchestrator backend frontend; do
  pm2 start "${app}${SUFFIX}"
done

pm2 save
pm2 list
echo "[pm2-restart] done — fleet restarted on existing dist/ (no rebuild)."
