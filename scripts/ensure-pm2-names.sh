#!/bin/bash
# Idempotently ensure .env has the PM2 process names that match the pm2 flavor
# being launched. Only writes when a key is missing; respects existing values
# as explicit user overrides.
#
# Called by `pm2-run` / `pm2-run:prod` in package.json before pm2 starts, so
# downstream scripts (redeploy-orchestrator, switch-worker-mode, etc.) can
# read the correct names from .env without manual configuration.
#
# Usage:
#   bash scripts/ensure-pm2-names.sh dev   # → backend, orchestrator
#   bash scripts/ensure-pm2-names.sh prod  # → backend-prod, orchestrator-prod

set -euo pipefail

FLAVOR="${1:-}"

case "$FLAVOR" in
  dev)
    TARGET_BACKEND="backend"
    TARGET_ORCHESTRATOR="orchestrator"
    ;;
  prod)
    TARGET_BACKEND="backend-prod"
    TARGET_ORCHESTRATOR="orchestrator-prod"
    ;;
  *)
    echo "Usage: $0 {dev|prod}" >&2
    exit 1
    ;;
esac

ENV_FILE=".env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "[ensure-pm2-names] $ENV_FILE not found — skipping (run from repo root if you expected this to write)." >&2
  exit 0
fi

read_env_value() {
  local key="$1"
  grep -E "^${key}=" "$ENV_FILE" | tail -1 \
    | sed -E "s/^${key}=//; s/^\"(.*)\"$/\1/; s/^'(.*)'$/\1/"
}

# Returns 0 if the key exists in .env with ANY value (incl. empty).
key_exists() {
  grep -qE "^${1}=" "$ENV_FILE"
}

append_key() {
  local key="$1"
  local value="$2"
  printf '\n%s="%s"\n' "$key" "$value" >> "$ENV_FILE"
  echo "[ensure-pm2-names] Added $key=\"$value\""
}

ensure_key() {
  local key="$1"
  local target="$2"
  if ! key_exists "$key"; then
    append_key "$key" "$target"
    return
  fi
  local current
  current=$(read_env_value "$key")
  if [[ -z "$current" ]]; then
    # Key exists but is empty — treat as unset, write target.
    # Rewrite in place so we don't duplicate the line.
    awk -v k="$key" -v v="$target" '
      $0 ~ "^"k"=" { print k"=\""v"\""; next }
      { print }
    ' "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
    echo "[ensure-pm2-names] Filled empty $key=\"$target\""
    return
  fi
  if [[ "$current" != "$target" ]]; then
    echo "[ensure-pm2-names] $key already set to \"$current\" (expected \"$target\" for $FLAVOR). Leaving as-is — set explicitly in .env if this is intentional." >&2
  fi
}

ensure_key "PM2_BACKEND_NAME" "$TARGET_BACKEND"
ensure_key "PM2_ORCHESTRATOR_NAME" "$TARGET_ORCHESTRATOR"
