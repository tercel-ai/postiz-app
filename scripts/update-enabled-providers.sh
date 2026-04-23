#!/bin/bash
# Update ENABLED_PROVIDERS — add, remove, or replace the provider allowlist.
#
# This is the ONLY command you need. It:
#   1. Diffs current vs target allowlist
#   2. If removing providers AND worker mode is per-provider:
#        terminate workflows on the removed providers' task queues
#      (other scenarios need no termination — activities re-dispatch on restart)
#   3. Updates .env
#   4. Rebuilds
#   5. Restarts backend + orchestrator with --update-env
#
# Deployment identity (namespace, PM2 process names) is read from .env —
# single source of truth.
#
# Usage:
#   # Replace the entire allowlist
#   bash scripts/update-enabled-providers.sh set    "x,linkedin"
#   bash scripts/update-enabled-providers.sh set    "x,linkedin,linkedin-page"
#
#   # Add providers (keep existing)
#   bash scripts/update-enabled-providers.sh add    "reddit,pinterest"
#
#   # Remove providers (keep the rest)
#   bash scripts/update-enabled-providers.sh remove "reddit"
#
#   # Disable allowlist (= enable all providers)
#   bash scripts/update-enabled-providers.sh set    ""
export NODE_OPTIONS="--max-old-space-size=4096"
export NEXT_FONT_GOOGLE_MOCKED_RESPONSES=true

set -euo pipefail

ARG_OP="${1:-}"
ARG_LIST="${2-}"

# -- Validate args --------------------------------------------------------
case "$ARG_OP" in
  set|add|remove) ;;
  *)
    echo "Error: Missing or invalid operation."
    echo "Usage: $0 {set|add|remove} \"<comma-separated-identifiers>\""
    exit 1
    ;;
esac

ENV_FILE=".env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: $ENV_FILE not found. Run this from the repo root."
  exit 1
fi

# -- Helpers --------------------------------------------------------------
# Read a single env key from .env (returns empty if unset). Handles quoted values.
read_env_value() {
  local key="$1"
  grep -E "^${key}=" "$ENV_FILE" | tail -1 \
    | sed -E "s/^${key}=//; s/^\"(.*)\"$/\1/; s/^'(.*)'$/\1/"
}

# Normalize a CSV list: lowercase, trim, drop empties, dedupe, sort.
normalize_csv() {
  local csv="$1"
  printf '%s\n' "$csv" \
    | tr ',' '\n' \
    | awk '{ gsub(/^[ \t]+|[ \t]+$/, ""); print tolower($0) }' \
    | awk 'NF' \
    | sort -u \
    | paste -sd, -
}

# Write/replace/append TEMPORAL_WORKER_MODE style key.
write_env_value() {
  local key="$1"
  local value="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    awk -v k="$key" -v v="$value" '
      $0 ~ "^"k"=" { print k"=\""v"\""; next }
      { print }
    ' "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
  else
    printf '\n%s="%s"\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

# -- Compute current/target allowlists -----------------------------------
CURRENT_RAW=$(read_env_value "ENABLED_PROVIDERS")
CURRENT=$(normalize_csv "$CURRENT_RAW")
INPUT=$(normalize_csv "$ARG_LIST")
WORKER_MODE=$(read_env_value "TEMPORAL_WORKER_MODE")
WORKER_MODE="${WORKER_MODE:-merged}"
NAMESPACE=$(read_env_value "TEMPORAL_NAMESPACE")
NAMESPACE="${NAMESPACE:-default}"
BACKEND_PROCESS=$(read_env_value "PM2_BACKEND_NAME")
BACKEND_PROCESS="${BACKEND_PROCESS:-backend}"
ORCHESTRATOR_PROCESS=$(read_env_value "PM2_ORCHESTRATOR_NAME")
ORCHESTRATOR_PROCESS="${ORCHESTRATOR_PROCESS:-orchestrator}"

case "$ARG_OP" in
  set)
    TARGET="$INPUT"
    ;;
  add)
    TARGET=$(normalize_csv "${CURRENT},${INPUT}")
    ;;
  remove)
    # Subtract INPUT from CURRENT.
    if [[ -z "$CURRENT" ]]; then
      TARGET=""
    else
      # Translate INPUT into a regex alternation of exact tokens.
      TO_REMOVE=$(printf '%s\n' "$INPUT" | tr ',' '\n' | awk 'NF')
      TARGET="$CURRENT"
      while IFS= read -r rm_id; do
        [[ -z "$rm_id" ]] && continue
        TARGET=$(printf '%s' "$TARGET" \
          | tr ',' '\n' \
          | awk -v r="$rm_id" '$0 != r' \
          | awk 'NF' \
          | paste -sd, -)
      done <<< "$TO_REMOVE"
    fi
    ;;
esac

echo "=== Update ENABLED_PROVIDERS ==="
echo "Operation:    $ARG_OP \"$ARG_LIST\""
echo "Worker mode:  $WORKER_MODE"
echo "Namespace:    $NAMESPACE (from .env)"
echo "Processes:    $BACKEND_PROCESS + $ORCHESTRATOR_PROCESS (from .env)"
echo "Current:      ${CURRENT:-<all>}"
echo "Target:       ${TARGET:-<all>}"
echo ""

if [[ "$CURRENT" == "$TARGET" ]]; then
  echo "No change in allowlist. Nothing to do."
  exit 0
fi

# -- Compute added / removed sets ----------------------------------------
CURRENT_LINES=$(printf '%s' "$CURRENT" | tr ',' '\n' | awk 'NF' | sort -u)
TARGET_LINES=$(printf '%s' "$TARGET" | tr ',' '\n' | awk 'NF' | sort -u)
ADDED=$(comm -13 <(printf '%s\n' "$CURRENT_LINES") <(printf '%s\n' "$TARGET_LINES") | awk 'NF' | paste -sd, -)
REMOVED=$(comm -23 <(printf '%s\n' "$CURRENT_LINES") <(printf '%s\n' "$TARGET_LINES") | awk 'NF' | paste -sd, -)

echo "Added:        ${ADDED:-<none>}"
echo "Removed:      ${REMOVED:-<none>}"
echo ""

# Special case: going from allowlist to no-allowlist widens coverage (everything
# enabled). Going from no-allowlist to allowlist narrows coverage — we can't
# precisely compute what's removed since "current=all" isn't enumerated here,
# so fall back to terminating all post workflows (same as redeploy).
WIDENING_TO_ALL=false
NARROWING_FROM_ALL=false
if [[ -n "$CURRENT" && -z "$TARGET" ]]; then
  WIDENING_TO_ALL=true
fi
if [[ -z "$CURRENT" && -n "$TARGET" ]]; then
  NARROWING_FROM_ALL=true
fi

# -- Build ----------------------------------------------------------------
echo "Step 1: Building..."
pnpm build 2>&1 | tail -5
echo ""

# -- Decide termination scope --------------------------------------------
# Merged mode: all providers share 'social-activities' queue. Termination
# isn't useful (same worker keeps serving everyone). Skip it.
# Per-provider mode: each removed provider has its own queue — terminate
# only those queues.
TERMINATE=false
TERMINATE_QUEUES=""
TERMINATE_ALL=false

if [[ "$WORKER_MODE" == "per-provider" ]]; then
  if [[ -n "$REMOVED" ]]; then
    TERMINATE=true
    # Map identifiers to task queues: root part before the first '-'.
    TERMINATE_QUEUES=$(printf '%s\n' "$REMOVED" \
      | tr ',' '\n' \
      | awk -F'-' '{ print $1 }' \
      | awk 'NF' \
      | sort -u \
      | paste -sd, -)
  fi
  if $NARROWING_FROM_ALL; then
    # Previous coverage = all providers; we don't know which ones had in-flight
    # workflows on queues that will no longer have workers. Safest: terminate
    # all post workflows; missingPostWorkflow will re-dispatch to the new
    # allowlist's queues within ~1h.
    TERMINATE=true
    TERMINATE_ALL=true
  fi
fi

if $TERMINATE; then
  echo "Step 2: Terminating in-flight workflows in '$NAMESPACE'..."
  if $TERMINATE_ALL; then
    echo "  (narrowing from no-allowlist: terminating all postWorkflowV101)"
    npx ts-node --project scripts/tsconfig.json scripts/terminate-workflows.ts \
      --execute --only-posts
  else
    echo "  Target queues: $TERMINATE_QUEUES"
    npx ts-node --project scripts/tsconfig.json scripts/terminate-workflows.ts \
      --execute --task-queues="$TERMINATE_QUEUES"
  fi
  echo ""
else
  REASON="no removals"
  if [[ "$WORKER_MODE" == "merged" && -n "$REMOVED" ]]; then
    REASON="merged mode — shared queue, no dispatch gap"
  fi
  if $WIDENING_TO_ALL; then
    REASON="widening to all providers — no in-flight work gets orphaned"
  fi
  echo "Step 2: Skipping workflow termination ($REASON)."
  echo ""
fi

# -- Commit .env change ---------------------------------------------------
echo "Step 3: Updating $ENV_FILE..."
write_env_value "ENABLED_PROVIDERS" "$TARGET"
echo "  ENABLED_PROVIDERS=\"$TARGET\""
echo ""

# -- Restart both processes with --update-env ----------------------------
echo "Step 4: Restarting $BACKEND_PROCESS + $ORCHESTRATOR_PROCESS..."
pm2 restart "$BACKEND_PROCESS" "$ORCHESTRATOR_PROCESS" --update-env
echo ""

echo "Done."
echo ""
echo "Verify:"
echo "  pm2 env $ORCHESTRATOR_PROCESS | grep ENABLED_PROVIDERS"
echo "  pm2 logs $ORCHESTRATOR_PROCESS --lines 30 --nostream 2>&1 | grep -i '\\[Temporal\\]'"
