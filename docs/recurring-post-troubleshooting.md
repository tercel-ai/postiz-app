# Recurring Post Troubleshooting Guide

## Overview

Recurring posts use Temporal workflows that run indefinitely via `continueAsNew`. Each cycle: sleep until publishDate → create clone → post to platform → finalize clone → advance publishDate → continueAsNew.

This document covers common failure modes and their resolution steps.

---

## Diagnostic Scripts

| Script | Purpose | Usage |
|--------|---------|-------|
| `terminate-workflows.ts` | List/terminate Temporal workflows | `npx ts-node --project scripts/tsconfig.json scripts/terminate-workflows.ts --dry-run` |
| `start-post-workflow.ts` | Manually start workflow for specific posts | `npx ts-node --project scripts/tsconfig.json scripts/start-post-workflow.ts <postId>` |

---

## Problem 1: Recurring Post Stopped Sending

### Symptoms
- Post was sending daily but stopped
- No error in the UI
- Post shows as `PUBLISHED` or `ERROR` state in the database

### Diagnosis

```sql
-- Check if the recurring original is in QUEUE state
SELECT id, state, "publishDate", "intervalInDays", "releaseId", error
FROM "Post"
WHERE "intervalInDays" IS NOT NULL
  AND "intervalInDays" > 0
  AND "parentPostId" IS NULL
  AND "deletedAt" IS NULL
  AND state != 'QUEUE';
```

If results show `PUBLISHED` or `ERROR`, the original post's state was incorrectly changed (should always stay `QUEUE`).

### Fix

```sql
-- Reset to QUEUE so workflow can resume
UPDATE "Post"
SET state = 'QUEUE', "releaseId" = NULL, "releaseURL" = NULL, error = NULL
WHERE id IN ('...');  -- IDs from query above
```

Then check if a workflow exists for the post:

```bash
npx ts-node --project scripts/tsconfig.json scripts/terminate-workflows.ts --dry-run 2>&1 | grep "post_<postId>"
```

If no workflow exists, start one manually:

```bash
npx ts-node --project scripts/tsconfig.json scripts/start-post-workflow.ts <postId>
```

---

## Problem 2: Temporal Nondeterminism Errors After Deploy

### Symptoms

Orchestrator logs show:
```
[TMPRL1100] Nondeterminism error: Activity type of scheduled event
'xxx' does not match activity type of activity command 'yyy'
```

### Cause

Workflow activity sequence was changed (add/remove/reorder activities) but old workflow executions are still running with the old code's event history.

### Fix

```bash
# 1. Terminate all workflows
npx ts-node --project scripts/tsconfig.json scripts/terminate-workflows.ts --execute

# 2. Restart orchestrator (missingPostWorkflow auto-recreates post workflows)
pm2 restart orchestrator

# 3. Verify workflows are recreated (wait 1-2 minutes)
npx ts-node --project scripts/tsconfig.json scripts/terminate-workflows.ts --dry-run
```

If some recurring posts are not picked up (missingPostWorkflow may skip posts with terminated workflow history), start them manually:

```bash
npx ts-node --project scripts/tsconfig.json scripts/start-post-workflow.ts <postId1> <postId2> ...
```

### Prevention

See `docs/orchestrator-deploy.md` for deployment rules. Only changes to **activity call sequences** in workflow files require workflow termination. Changes to activity implementations (services, repositories) do not.

---

## Problem 3: Recurring Post Published But No Clone Record

### Symptoms
- Post was delivered to the platform
- Database has no clone (only the original with `intervalInDays`)
- Original may show `PUBLISHED` state

### Cause

Old code path (before the cycle-clone mechanism) published directly on the original post.

### Fix

1. Reset the original to QUEUE:
```sql
UPDATE "Post"
SET state = 'QUEUE', "releaseId" = NULL, "releaseURL" = NULL, error = NULL
WHERE id = '<postId>';
```

2. Start workflow:
```bash
npx ts-node --project scripts/tsconfig.json scripts/start-post-workflow.ts <postId>
```

The published-but-unrecorded cycle is a one-time loss. Future cycles will create clones normally.

---

## Problem 4: publishDate Stuck in the Past

### Symptoms
- Recurring post's `publishDate` is weeks/months in the past
- Workflow is not running

### Diagnosis

```sql
SELECT id, state, "publishDate", "intervalInDays"
FROM "Post"
WHERE "intervalInDays" IS NOT NULL
  AND "deletedAt" IS NULL
  AND "parentPostId" IS NULL
  AND "publishDate" < NOW() - INTERVAL '2 days'
  AND state = 'QUEUE';
```

### Fix

The `advancePublishDate` repository method has catch-up logic — it automatically skips past dates to the next future occurrence. Just ensure a workflow is running:

```bash
npx ts-node --project scripts/tsconfig.json scripts/start-post-workflow.ts <postId>
```

The workflow will:
1. Detect publishDate is in the past → sleep(0)
2. Create clone for the stale date → publish immediately
3. `advancePublishDate` catch-up → jump to next future date
4. `continueAsNew` → next cycle at the correct future date

If you don't want the stale cycle to be published, advance the date manually first:

```sql
-- Advance to tomorrow at the original time-of-day
UPDATE "Post"
SET "publishDate" = (
  DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC') + INTERVAL '1 day'
  + ("publishDate"::time)::interval
)
WHERE id = '<postId>';
```

---

## Problem 5: missingPostWorkflow Not Picking Up Posts

### Symptoms
- Post is in QUEUE state with all conditions met
- No workflow exists in Temporal
- `missingPostWorkflow` is running but didn't create a workflow

### Cause

`signalWithStart` with `workflowIdConflictPolicy: 'USE_EXISTING'` may not create a new workflow if a terminated/completed workflow with the same ID exists in Temporal's retention window.

### Fix

Use the manual start script which calls `client.workflow.start()` directly:

```bash
npx ts-node --project scripts/tsconfig.json scripts/start-post-workflow.ts <postId>
```

---

## Full Health Check

Run all checks at once:

```sql
-- 1. Recurring originals not in QUEUE (should be empty)
SELECT id, state, "publishDate", "intervalInDays"
FROM "Post"
WHERE "intervalInDays" IS NOT NULL AND "intervalInDays" > 0
  AND "parentPostId" IS NULL AND "deletedAt" IS NULL
  AND state NOT IN ('QUEUE', 'DRAFT')
ORDER BY "publishDate";

-- 2. Recurring originals with stale publishDate (may need workflow restart)
SELECT p.id, i.name, p."publishDate", p."intervalInDays"
FROM "Post" p
JOIN "Integration" i ON p."integrationId" = i.id
WHERE p."intervalInDays" IS NOT NULL AND p."intervalInDays" > 0
  AND p."parentPostId" IS NULL AND p."deletedAt" IS NULL
  AND p.state = 'QUEUE'
  AND p."publishDate" < NOW() - INTERVAL '2 days'
ORDER BY p."publishDate";
```

```bash
# 3. Check running workflows match QUEUE recurring posts
npx ts-node --project scripts/tsconfig.json scripts/terminate-workflows.ts --dry-run 2>&1 | grep "Found"
```

Compare post workflow count with the number of active QUEUE recurring + scheduled posts. If workflows are missing, use `start-post-workflow.ts` to create them.
