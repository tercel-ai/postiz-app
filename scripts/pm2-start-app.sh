#!/bin/bash
# Register one app with pm2, using a STABLE absolute pnpm path.
#
# Why this exists: `pm2 start pnpm --name X -- start` resolves `pnpm` from PATH
# at registration time and bakes the result into ~/.pm2/dump.pm2 forever. Under
# fnm/nvm that resolves to an ephemeral shell dir such as
#   /run/user/1000/fnm_multishells/<pid>_<ts>/bin/pnpm
# which lives on tmpfs. After a reboot the path is gone and every app fails with
# MODULE_NOT_FOUND on boot, forever, until the definition is recreated.
#
# This script resolves pnpm to its real installation path, refuses to register
# an ephemeral one, and self-heals a definition that already points at a stale
# path by recreating it.
#
# Usage (run from the app directory, via each app's `pm2` / `pm2:prod` script):
#   bash ../../scripts/pm2-start-app.sh orchestrator-prod

set -euo pipefail

NAME="${1:?usage: pm2-start-app.sh <pm2-process-name>}"

# pnpm exports npm_execpath as the absolute path of its own .cjs entry when it
# runs a package script — already resolved, already stable. Fall back to PATH
# lookup + realpath for direct invocations.
resolve_pnpm() {
  if [[ -n "${npm_execpath:-}" && -f "${npm_execpath}" ]]; then
    node -e 'process.stdout.write(require("fs").realpathSync(process.argv[1]))' "$npm_execpath"
    return
  fi
  local bin
  bin=$(command -v pnpm) || return 1
  node -e 'process.stdout.write(require("fs").realpathSync(process.argv[1]))' "$bin"
}

PNPM=$(resolve_pnpm) || {
  echo "[pm2-start-app] Cannot locate pnpm. Install it or run through 'pnpm run'." >&2
  exit 1
}

# Guard the exact failure mode this script exists to prevent.
case "$PNPM" in
  /run/user/* | /tmp/* | */fnm_multishells/* | */.nvm/alias/*)
    echo "[pm2-start-app] Refusing to register an ephemeral pnpm path:" >&2
    echo "                  $PNPM" >&2
    echo "                It lives on tmpfs and disappears on reboot, which would" >&2
    echo "                leave '$NAME' permanently unstartable. Install pnpm to a" >&2
    echo "                persistent location (corepack, or npm i -g pnpm)." >&2
    exit 1
    ;;
esac

# What, if anything, is pm2 already holding under this name?
current_exec_path() {
  pm2 jlist 2>/dev/null | node -e '
    let raw = "";
    process.stdin.on("data", (d) => (raw += d)).on("end", () => {
      let list = [];
      try { list = JSON.parse(raw); } catch { /* pm2 not running / no JSON */ }
      const proc = list.find((p) => p.name === process.argv[1]);
      process.stdout.write((proc && proc.pm2_env && proc.pm2_env.pm_exec_path) || "");
    });
  ' "$NAME"
}

EXISTING=$(current_exec_path)

if [[ -n "$EXISTING" && "$EXISTING" != "$PNPM" ]]; then
  echo "[pm2-start-app] '$NAME' points at a stale interpreter:"
  echo "                  old: $EXISTING"
  echo "                  new: $PNPM"
  echo "[pm2-start-app] Recreating the definition."
  pm2 delete "$NAME"
  EXISTING=""
fi

if [[ -n "$EXISTING" ]]; then
  echo "[pm2-start-app] '$NAME' already registered with the correct path — restarting."
  exec pm2 restart "$NAME" --update-env
fi

echo "[pm2-start-app] Registering '$NAME' → $PNPM start (cwd: $PWD)"
exec pm2 start "$PNPM" --name "$NAME" --interpreter node --cwd "$PWD" -- start
