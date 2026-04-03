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

## Workflow Types

| Workflow | File | Auto-restart? | Notes |
|----------|------|:---:|-------|
| `postWorkflowV101` | `post.workflow.v1.0.1.ts` | Via `missingPostWorkflow` | Recreated for QUEUE posts within ~1 hour |
| `missingPostWorkflow` | `missing.post.workflow.ts` | **Yes** (on boot) | Runs every 1h, recreates orphaned post workflows |
| `dataTicksSyncWorkflow` | `data-ticks.workflow.ts` | **Yes** (on boot) | Daily analytics sync |
| `autoPostWorkflow` | `autopost.workflow.ts` | **No** (on-demand) | Started when user enables autopost |
| `refreshTokenWorkflow` | `refresh.token.workflow.ts` | **No** (on-demand) | Started per-integration when token nears expiry |
| `digestEmailWorkflow` | `digest.email.workflow.ts` | **No** (on-demand) | Started for email digests |
| `sendEmailWorkflow` | `send.email.workflow.ts` | **No** (on-demand) | Started for sending emails |

**Auto-restart** workflows are registered in `InfiniteWorkflowRegister` and start automatically when the orchestrator boots. **On-demand** workflows are started by application logic and will NOT be recreated after termination — they resume naturally when their trigger fires again.

---

## Deployment Steps

### Quick Deploy (workflow function changes)

```bash
bash scripts/redeploy-orchestrator.sh
```

This script:
1. **Builds** the project (fails fast if build broken — no workflows disrupted)
2. **Terminates** all running workflows via `scripts/terminate-workflows.ts`
3. **Restarts** the orchestrator pm2 process (immediately after terminate)
4. `missingPostWorkflow` auto-starts and recreates workflows for QUEUE posts

Use `--only-posts` to skip on-demand workflows (autopost, refreshToken, email):
```bash
bash scripts/redeploy-orchestrator.sh --only-posts
```

### Manual Deploy (workflow function changes)

```bash
# 1. Build first
pnpm build

# 2. Preview what will be terminated
npx ts-node --project scripts/tsconfig.json scripts/terminate-workflows.ts --dry-run

# 3. Terminate + restart (back-to-back, minimize gap)
npx ts-node --project scripts/tsconfig.json scripts/terminate-workflows.ts --execute
pm2 restart orchestrator
```

### Safe Deploy (only activity/service changes)

When only activity implementations changed (service/repository code), no workflow termination needed:

```bash
pnpm build
pm2 restart orchestrator
```

---

## Terminate Workflows Script

`scripts/terminate-workflows.ts` connects to Temporal via `@temporalio/client` SDK to list and terminate running workflows.

**Usage:**

```bash
# Dry run — list running workflows without terminating
npx ts-node --project scripts/tsconfig.json scripts/terminate-workflows.ts --dry-run

# Execute — terminate all running workflows
npx ts-node --project scripts/tsconfig.json scripts/terminate-workflows.ts --execute

# Execute — only post + infrastructure workflows (skip on-demand)
npx ts-node --project scripts/tsconfig.json scripts/terminate-workflows.ts --execute --only-posts
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

## Recurring Post Architecture

For context on how recurring posts work with the cycle-clone mechanism, see the workflow code at `apps/orchestrator/src/workflows/post-workflows/post.workflow.v1.0.1.ts`.

**Key design decisions:**
- Original recurring post stays in `QUEUE` state permanently
- Each publish cycle creates a clone with `PUBLISHED`/`ERROR` state
- `publishDate` on the original is advanced after each cycle (regardless of success/failure)
- `changeState('ERROR')` on recurring originals is a no-op (service layer protection)
- `updatePost()` on recurring originals is blocked (service layer defense-in-depth)
- Failed cycles don't block subsequent cycles
