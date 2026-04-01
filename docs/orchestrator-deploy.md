# Orchestrator Deployment Guide

## Overview

The Orchestrator runs Temporal workers that execute post scheduling workflows. Due to Temporal's deterministic replay mechanism, **certain code changes require terminating existing workflow executions** before deploying. This document explains when and how to do this.

---

## Temporal Replay and Nondeterminism

Temporal workflows are long-running stateful processes. Each workflow execution maintains an **event history** — a log of every activity call, sleep, and decision made during execution. When a worker restarts, Temporal **replays** the event history against the current code to restore workflow state.

If the code has changed in a way that produces a different sequence of commands than what the history recorded, Temporal raises a **nondeterminism error** and the workflow gets stuck:

```
[TMPRL1100] Nondeterminism error: Activity type of scheduled event
'isCommentable' does not match activity type of activity command
'prepareRecurringCycle'
```

### What Causes Nondeterminism

| Change Type | Breaks Replay? | Example |
|-------------|---------------|---------|
| Add/remove an activity call | **Yes** | Inserting `prepareRecurringCycle` before `isCommentable` |
| Reorder activity calls | **Yes** | Swapping `postSocial` and `isCommentable` |
| Change `sleep` duration/logic | **Yes** | Changing `sleep('1 hour')` to `sleep('30 minutes')` |
| Change conditional branching | **Yes** | Adding an `if` that skips an activity in some cases |
| Change activity implementation (service/repo code) | **No** | Fixing a bug inside `postSocial`'s logic |
| Change activity parameters or return values | **Usually no** | Unless serialization format is incompatible |
| Add new workflows (new exports) | **No** | Adding `dataTicksSyncWorkflow` |

### Rule of Thumb

> If you changed the **sequence of Temporal API calls** (activities, sleep, continueAsNew) inside a workflow function, existing executions must be terminated.

---

## When to Terminate Old Workflows

**You MUST terminate** when you've changed:
- The order of `await activity()` calls in a workflow
- Added or removed `await activity()` calls
- Changed `await sleep()` parameters or conditions
- Added or removed `if` branches that gate activity calls

**You do NOT need to terminate** when you've changed:
- Activity implementations (code inside `PostActivity`, services, repositories)
- Code outside of workflow functions (controllers, modules, etc.)
- Only added new workflow exports

---

## Automatic Recovery: missingPostWorkflow

The system has a built-in recovery mechanism:

```
missingPostWorkflow → runs every 1 hour
  → searchForMissingThreeHoursPosts()
    → finds QUEUE posts without a running workflow
    → signalWithStart('postWorkflowV101', ...) to recreate them
```

After terminating old workflows, `missingPostWorkflow` automatically recreates workflows for all `QUEUE` posts within 1 hour. For recurring posts, the original post stays in `QUEUE` state permanently, so it will always be picked up.

---

## Deployment Steps

### Quick Deploy (workflow changes)

```bash
bash scripts/redeploy-orchestrator.sh
```

This script:
1. Terminates all running workflows via `scripts/terminate-workflows.ts`
2. Rebuilds the project
3. Restarts the orchestrator pm2 process
4. `missingPostWorkflow` auto-starts and recreates workflows for QUEUE posts

### Manual Deploy (workflow changes)

```bash
# 1. Preview what will be terminated
npx ts-node --project scripts/tsconfig.json scripts/terminate-workflows.ts --dry-run

# 2. Terminate all running workflows
npx ts-node --project scripts/tsconfig.json scripts/terminate-workflows.ts --execute

# 3. Build and restart
pnpm build
pm2 restart orchestrator
```

### Safe Deploy (no workflow changes)

When only activity implementations changed (service/repository code):

```bash
pnpm build
pm2 restart orchestrator
```

No workflow termination needed.

---

## Terminate Workflows Script

`scripts/terminate-workflows.ts` uses `@temporalio/client` SDK to connect to the Temporal server and terminate running workflows. No need to install the `temporal` CLI.

**Targeted workflow types:**
- `postWorkflowV101` — post scheduling workflows
- `missingPostWorkflow` — orphaned post recovery (auto-restarts on boot)
- `dataTicksSyncWorkflow` — daily analytics sync (auto-restarts on boot)
- `refreshTokenWorkflow` — token refresh monitoring (auto-restarts on boot)

**Usage:**

```bash
# Dry run — list running workflows without terminating
npx ts-node --project scripts/tsconfig.json scripts/terminate-workflows.ts --dry-run

# Execute — terminate all running workflows
npx ts-node --project scripts/tsconfig.json scripts/terminate-workflows.ts --execute
```

**Environment variables:**
- `TEMPORAL_ADDRESS` — Temporal server address (default: `localhost:7233`, loaded from `.env`)
- `TEMPORAL_NAMESPACE` — Temporal namespace (default: `default`, loaded from `.env`)

---

## Post-Deploy Verification

### Check for nondeterminism errors

```bash
pm2 logs orchestrator --lines 50 --nostream 2>&1 | grep -i "nondeterminism\|TMPRL1100"
```

If you see nondeterminism errors, workflows were not properly terminated:

```bash
npx ts-node --project scripts/tsconfig.json scripts/terminate-workflows.ts --execute
pm2 restart orchestrator
```

### Check workflow recreation

After orchestrator restarts, `missingPostWorkflow` runs every hour to recreate workflows for QUEUE posts. To verify:

```bash
# Check orchestrator logs for workflow creation
pm2 logs orchestrator --lines 30 --nostream 2>&1 | grep -i "workflow\|signal"
```

### Check for stuck recurring posts

If a recurring post's original was accidentally set to `PUBLISHED` or `ERROR` by old code:

```sql
-- Find recurring originals not in QUEUE state
SELECT id, state, "publishDate", "intervalInDays"
FROM "Post"
WHERE "intervalInDays" IS NOT NULL
  AND "intervalInDays" > 0
  AND "parentPostId" IS NULL
  AND "deletedAt" IS NULL
  AND state != 'QUEUE';
```

Fix them:

```sql
UPDATE "Post"
SET state = 'QUEUE', "releaseId" = NULL, "releaseURL" = NULL, error = NULL
WHERE id IN ('...');  -- IDs from query above
```

---

## Infrastructure Workflows

These workflows are registered at orchestrator startup via `InfiniteWorkflowRegisterModule` and auto-restart when the orchestrator boots:

| Workflow | Purpose | Restart Behavior |
|----------|---------|-----------------|
| `missingPostWorkflow` | Recreates workflows for orphaned QUEUE posts (every 1h) | Auto-starts on boot |
| `dataTicksSyncWorkflow` | Daily analytics sync (UTC 00:05) | Auto-starts on boot |
| `refreshTokenWorkflow` | Token refresh monitoring | Auto-starts on boot |

All are terminated by `scripts/terminate-workflows.ts` and automatically recreated when the orchestrator restarts.

---

## Recurring Post Architecture

For context on how recurring posts work with the cycle-clone mechanism, see the workflow code at `apps/orchestrator/src/workflows/post-workflows/post.workflow.v1.0.1.ts`.

**Key design decisions:**
- Original recurring post stays in `QUEUE` state permanently
- Each publish cycle creates a clone with `PUBLISHED`/`ERROR` state
- `publishDate` on the original is advanced after each cycle (regardless of success/failure)
- `changeState('ERROR')` on recurring originals is a no-op (service layer protection)
- Failed cycles don't block subsequent cycles
