# Temporal Worker Modes & Provider Allowlist

How the orchestrator spawns Temporal workers, and how to tune it for your resource budget.

---

## Why This Matters

Each Temporal worker holds a persistent gRPC long-poll connection to the Temporal server and a worker-thread pool. On a 4-core / 8 GB machine, spawning one worker per social platform (≈20 providers) can burn **600 MB–1 GB of resident memory at idle** before you've processed a single post.

Two knobs control this:

| Knob | Env var | Default | Effect |
|---|---|---|---|
| Worker mode | `TEMPORAL_WORKER_MODE` | `merged` | One shared worker vs. one per platform |
| Provider allowlist | `ENABLED_PROVIDERS` | `""` (all) | Which providers participate at all |

---

## Worker Modes

### `merged` (default)

One worker on queue `social-activities` serves **all providers**. Concurrency budget = sum of every enabled provider's `maxConcurrentJob`.

**Pros**
- Lowest resource footprint — 2 workers total (`main` + `social-activities`)
- Resource usage doesn't grow with number of supported platforms

**Cons**
- Loses per-platform worker isolation. Platform-specific rate limits (e.g., Reddit's 1-req/sec cap) are no longer enforced by worker concurrency — you'd need an in-activity semaphore to reinstate that

### `per-provider`

Every enabled provider spawns its own worker on queue `<identifier>` (e.g., `x`, `linkedin`, `reddit`). Concurrency is limited per-platform by the provider's `maxConcurrentJob`.

**Pros**
- Platform-level rate limiting is enforced by the worker itself — no extra code needed
- One provider's activity surge can't starve another

**Cons**
- N workers = N gRPC long-poll connections + N thread pools. At 20+ providers this adds up fast
- Mostly wasted if you only use 2–3 platforms

---

## Provider Allowlist (`ENABLED_PROVIDERS`)

Comma-separated list of provider identifiers. Empty = all providers enabled (backward-compatible default).

Identifiers match by full form (`linkedin-page`) or by root (`linkedin`, which matches both `linkedin` and `linkedin-page`).

```bash
# Nothing — all providers active
ENABLED_PROVIDERS=""

# Only X and LinkedIn (including LinkedIn Page — see root-level gate note below)
ENABLED_PROVIDERS="x,linkedin"

# Same effect in per-provider mode — 'linkedin-page' shares the 'linkedin' queue
ENABLED_PROVIDERS="x,linkedin-page"
```

In `merged` mode, listing only `linkedin-page` excludes LinkedIn (personal) from the concurrency budget. In `per-provider` mode, the two lines above are **functionally identical** because LinkedIn personal and LinkedIn Page share a worker queue.

### Semantics differ by mode — important

The allowlist does **not** mean the same thing in both modes:

| Behavior | `merged` | `per-provider` |
|---|---|---|
| Worker count change | none — still 1 shared worker | one worker per unique **root** among enabled variants |
| Concurrency sum | only enabled providers contribute to `maxConcurrentActivityTaskExecutions` | each root's worker uses the **strictest** `maxConcurrentJob` among its enabled variants |
| If a post is created for a provider whose **root has no enabled variant** | **Still publishes** — shared worker serves everyone | **Hangs** — no root worker exists, queue has no listener |
| If a post is created for a provider whose **root has any enabled variant** | Same as above | **Publishes** — root worker exists and serves every variant on that queue |
| Is the allowlist a real "gate"? | No — only a budget filter | Root-level gate, not provider-level — see note below |

> **Subtle: allowlist is a root-level gate, not a provider-level gate.** Because per-provider mode uses one queue per root identifier, all variants sharing that root share a worker. So `ENABLED_PROVIDERS="linkedin-page"` spawns the `linkedin` queue worker, and posts to `LinkedinProvider` (the root) will also succeed even though `linkedin` isn't in the list. To gate individual variants (e.g., disable personal LinkedIn while keeping company pages), add in-activity filtering inside `PostActivity.postSocial` — not available out of the box.

The **big resource win** from an allowlist shows up in `per-provider` mode. In `merged` mode it's only useful for tuning the shared worker's concurrency budget.

> **Known limitation**: The UI (via `IntegrationManager.getAllIntegrations()`) does not filter by `ENABLED_PROVIDERS`. Users can "connect" a disabled provider in the UI. In `merged` mode that works (no gate). In `per-provider` mode, posts to that provider will hang until you either enable the provider or the activity times out. If this matters for your deployment, add a filter at `libraries/nestjs-libraries/src/integrations/integration.manager.ts:74`.

---

## How Routing Works Internally

Understanding this helps debug unexpected behavior when mixing modes.

### Two-layer queue design

Post workflows split work across two worker types:

```
┌─────────────────────────────────────────────────────────┐
│  Workflow: postWorkflowV101  (always on 'main' queue)   │
│                                                         │
│  ├─ Light activities (getPostsList, changeState,        │
│  │   logError, updatePost, claimPostForPublishing,      │
│  │   prepareRecurringCycle, finalizeRecurringCycle,     │
│  │   sendWebhooks, isCommentable, inAppNotification)    │
│  │     → run on workflow's queue = 'main'               │
│  │                                                      │
│  └─ Social activities (postSocial, postComment,         │
│      postThreadFinisher, getIntegrationById,            │
│      refreshToken, internalPlugs, globalPlugs,          │
│      processInternalPlug, processPlug)                  │
│        → run on taskQueue arg = 'social-activities'     │
│          (merged) or '<provider>' (per-provider)        │
└─────────────────────────────────────────────────────────┘
```

Configured in `apps/orchestrator/src/workflows/post-workflows/post.workflow.v1.0.1.ts`:

- **Default `proxyActivities`** (no `taskQueue`) → inherits the workflow's queue (`main`).
- **`proxyTaskQueue(taskQueue)`** → explicit routing to the social queue (for activities that need provider-specific routing but aren't heavy).
- **`proxyTaskQueueHeavy(taskQueue)`** → same routing, with a longer `startToCloseTimeout` (30 min) for large media uploads.

### Why both workers register every activity

Both the `main` worker and the social worker(s) get `activityClasses: activityClasses!` in `temporal.module.ts`. That means either worker **can** execute any activity — routing is determined purely by the taskQueue the workflow dispatches to, not by activity availability.

This makes mode switches safe: the code you get after `switch-worker-mode.sh` doesn't care which worker ends up executing what, only that _some_ worker is listening on the routed queue.

### Dispatch sites (where `getSocialTaskQueue` is called)

These are the only places that decide which social queue a post workflow uses. Each resolves the provider from DB state and lets `getSocialTaskQueue` pick the right queue based on current mode:

| File | Line | Context |
|---|---|---|
| `libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts` | 804 | `createPost`, immediate publish |
| `libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts` | 821 | `createPost`, scheduled |
| `libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts` | 956 | `retryPost` |
| `libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts` | 996 | `changeDate` |
| `apps/orchestrator/src/activities/post.activity.ts` | 63 | `searchForMissingThreeHoursPosts` batch recovery |
| `scripts/start-post-workflow.ts` | 45 | Manual recovery script |

The workflow's _own_ `taskQueue: 'main'` at these call sites is intentional — only the activities inside it are routed per-provider.

### Non-post workflows stay on `main`

These always run on `main` regardless of mode — no social routing needed:
- `missingPostWorkflow`, `dataTicksSyncWorkflow` (infra, auto-restart)
- `autoPostWorkflow`, `refreshTokenWorkflow`, `digestEmailWorkflow`, `sendEmailWorkflow` (on-demand)

---

## Usage Scenarios

### Scenario 1: Single machine, 2 platforms, small team (common dev/small-prod)

You're running on an 8 GB VM, only connected X and LinkedIn, serving a handful of users.

**Goal:** Minimize idle footprint.

```bash
# .env
TEMPORAL_WORKER_MODE="merged"
ENABLED_PROVIDERS="x,linkedin"
```

**Result:** 2 Temporal workers regardless of platform count. `maxConcurrentActivityTaskExecutions` sums to 5 (X=1, LinkedIn=2, LinkedIn Page=2) — plenty for a low-traffic setup.

**Commands:**
```bash
bash scripts/switch-worker-mode.sh merged
bash scripts/update-enabled-providers.sh set "x,linkedin"
```

---

### Scenario 2: Multi-tenant prod, strict platform rate limits

You host hundreds of customers, each with multiple accounts. Reddit/TikTok/X will punish you if you exceed their caps.

**Goal:** Enforce per-platform concurrency limits automatically.

```bash
# .env
TEMPORAL_WORKER_MODE="per-provider"
ENABLED_PROVIDERS="x,linkedin,linkedin-page,reddit,tiktok,instagram,facebook,threads,youtube,pinterest,discord,slack,bluesky"
```

**Result:** Each platform worker has its own concurrency cap from `maxConcurrentJob`. When 100 Reddit posts land in the same minute, only 1 runs at a time.

**Commands:**
```bash
bash scripts/switch-worker-mode.sh per-provider
bash scripts/update-enabled-providers.sh set "x,linkedin,linkedin-page,reddit,tiktok,instagram,facebook,threads,youtube,pinterest,discord,slack,bluesky"
```

---

### Scenario 3: Adding a new platform to an existing deployment

You just obtained Reddit API credentials and want to enable posting to Reddit.

**Path A — allowlist empty (all enabled):** Nothing to do. Reddit auto-enables once users connect accounts.

**Path B — allowlist set:**
```bash
bash scripts/update-enabled-providers.sh add "reddit"
```

This script:
1. Detects it's a pure add (no removals) → skips workflow termination
2. Updates `.env`
3. Rebuilds
4. Restarts backend + orchestrator with `--update-env`

In `per-provider` mode, a new Reddit worker comes online. In `merged` mode, Reddit's `maxConcurrentJob` gets added to the shared pool.

---

### Scenario 4: Temporarily disabling a misbehaving platform

Pinterest's API is down for a day, their SDK is throwing at scale, and it's pulling down your queue workers.

```bash
bash scripts/update-enabled-providers.sh remove "pinterest"
```

This script:
1. Detects it's a removal
2. **In `per-provider` mode**: terminates in-flight `postWorkflowV101` workflows on the `pinterest` queue (via `--task-queues=pinterest`). Those posts stay in `QUEUE` state and will be re-dispatched by `missingPostWorkflow` within ~1 hour once Pinterest is re-enabled.
3. **In `merged` mode**: no termination needed (shared queue, same worker).
4. Updates `.env`, rebuilds, restarts.

When Pinterest recovers:
```bash
bash scripts/update-enabled-providers.sh add "pinterest"
```

---

### Scenario 5: Growing from small to multi-tenant (mode switch)

Your deployment scaled from "two users on a VM" to "paying customers across 10 platforms." Time to enable platform-level rate limiting.

```bash
bash scripts/switch-worker-mode.sh per-provider
```

This script:
1. Reads current mode from `.env` (`merged`)
2. Updates `.env` → `TEMPORAL_WORKER_MODE="per-provider"`
3. Rebuilds
4. **Terminates all in-flight post workflows** — they're bound to the old `social-activities` queue, which will have no listener after restart. `missingPostWorkflow` will re-dispatch them in ~1h.
5. Restarts backend + orchestrator with `--update-env`

To switch back:
```bash
bash scripts/switch-worker-mode.sh merged
```

---

### Scenario 6: Adding a brand-new provider (code-level)

You added a `TumblrProvider` class and pushed it into `socialIntegrationList`.

**If `ENABLED_PROVIDERS` is empty:** Just deploy — new provider auto-enabled.

**If `ENABLED_PROVIDERS` has values:** You MUST add the new identifier, otherwise the new provider's worker never starts and posts to it will hang.

```bash
# Deploy code change + widen allowlist in one go:
pnpm build
bash scripts/update-enabled-providers.sh add "tumblr"
```

---

### Scenario 7: You don't know what mode you're in

```bash
grep -E "^(TEMPORAL_WORKER_MODE|ENABLED_PROVIDERS)=" .env
pm2 env "$(grep ^PM2_ORCHESTRATOR_NAME .env | cut -d'=' -f2 | tr -d '"')" 2>/dev/null \
  | grep -E "TEMPORAL_WORKER_MODE|ENABLED_PROVIDERS"
pm2 logs orchestrator --lines 30 --nostream 2>&1 | grep "\[Temporal\]"
```

The orchestrator logs a line like this at boot, which is authoritative:

```
[Temporal] Worker mode=merged, enabled providers: x, linkedin, linkedin-page
```

---

## Scripts Reference

All scripts read deployment identity (`TEMPORAL_NAMESPACE`, `PM2_BACKEND_NAME`, `PM2_ORCHESTRATOR_NAME`) from `.env`. No `dev`/`prod` argument is needed — whatever the running app uses is what the scripts target.

### `scripts/switch-worker-mode.sh`

Atomically switches `TEMPORAL_WORKER_MODE` with the termination + restart dance required for correctness.

```bash
bash scripts/switch-worker-mode.sh merged
bash scripts/switch-worker-mode.sh per-provider
```

Does nothing if already in the target mode (idempotent).

### `scripts/update-enabled-providers.sh`

Single entry point for any `ENABLED_PROVIDERS` change. Computes diff, decides whether to terminate workflows, commits `.env`, restarts.

```bash
bash scripts/update-enabled-providers.sh set    "x,linkedin"
bash scripts/update-enabled-providers.sh add    "reddit"
bash scripts/update-enabled-providers.sh remove "reddit"
bash scripts/update-enabled-providers.sh set    ""            # disable allowlist
```

Decision matrix for workflow termination:

|  | `merged` | `per-provider` |
|---|---|---|
| Add | skip | skip |
| Remove | skip (shared queue) | terminate removed providers' queues |
| Widen to all (`set ""`) | skip | skip (new workers are supersets) |
| Narrow from all (previously empty → set) | skip | terminate all `postWorkflowV101` (can't diff) |

### `scripts/terminate-workflows.ts`

Low-level tool both scripts use. Supports precise targeting:

```bash
# Everything in the current namespace
npx ts-node --project scripts/tsconfig.json scripts/terminate-workflows.ts --execute

# Only post + infrastructure (skip on-demand)
... --execute --only-posts

# Only post workflows on specific task queues (implies --only-posts scope)
... --execute --task-queues=reddit,pinterest

# Different namespace override (otherwise reads TEMPORAL_NAMESPACE from .env)
... --execute --namespace=staging
```

---

## FAQ

**Q: Do I need to restart both backend and orchestrator? Why?**

Yes, whenever `TEMPORAL_WORKER_MODE` or `ENABLED_PROVIDERS` changes.
- Orchestrator reads these at boot to decide which workers to spawn and on which queues
- Backend reads them when dispatching workflows (to decide which queue to send them to)

If only one restarts, backend sends to old queues while orchestrator listens on new ones (or vice versa), and activities hang forever. The provided scripts always restart both.

**Q: Does `pm2 restart` pick up `.env` changes?**

Not by default. PM2 caches env from when the process was first started. The scripts pass `--update-env` to force a refresh. If you restart manually, do the same:
```bash
pm2 restart "$PM2_BACKEND_NAME" "$PM2_ORCHESTRATOR_NAME" --update-env
```

**Q: What happens to in-flight posts when I disable a provider in `per-provider` mode?**

Their workflows get terminated by the script. The posts stay in `QUEUE` state in the DB. If you re-enable the provider later, `missingPostWorkflow` picks them up within ~1 hour (or you can force it with `bash scripts/redeploy-orchestrator.sh`). If you don't re-enable, the posts stay in `QUEUE` indefinitely until `markStaleQueuePostsAsError` sweeps them to `ERROR` after 7 days.

**Q: Is there a third option — limit concurrency but don't spawn per-provider workers?**

Yes, though not built into this setup. You could run `merged` mode with an in-activity semaphore (e.g., `p-limit` keyed by `providerIdentifier`) inside `PostActivity.postSocial`. That preserves the one-worker resource win while still enforcing per-platform rate limits. Not wired up currently — see `apps/orchestrator/src/activities/post.activity.ts` for where it would go.

**Q: A post to a disabled provider hangs — how do I recover it?**

This only happens in `per-provider` mode (merged mode still publishes). Two options:
1. Re-enable the provider: `bash scripts/update-enabled-providers.sh add "<provider>"`. `missingPostWorkflow` picks up the QUEUE posts on the next cycle (within ~1 hour).
2. Give up on the post: terminate the workflow with `scripts/terminate-workflows.ts --execute --task-queues=<provider>`. The post stays `QUEUE` until `markStaleQueuePostsAsError` sweeps it to `ERROR` after 7 days.

**Q: Why do I see `getAllIntegrations()` return every provider in the UI even with an allowlist?**

Intentional — `IntegrationManager` is a discovery layer, not an enforcement layer. AI chat tools and admin flows need the full catalog regardless of current allowlist. The allowlist is only wired into worker startup and `maxConcurrentActivityTaskExecutions` budgeting. If you want to hide disabled providers in the UI, filter `getAllIntegrations()` with `isProviderEnabled` from `libraries/nestjs-libraries/src/temporal/task-queue.ts`.

**Q: How do I confirm my config took effect after a restart?**

Check the boot log line the orchestrator emits:

```bash
pm2 logs "$(grep ^PM2_ORCHESTRATOR_NAME .env | cut -d'=' -f2 | tr -d '\"')" \
  --lines 100 --nostream 2>&1 | grep "\[Temporal\]"
```

Expected output, one line per boot:

```
[Temporal] Worker mode=per-provider, enabled providers: x, linkedin, linkedin-page
```

If you see `enabled providers: all`, the allowlist is empty and every provider in `socialIntegrationList` is active.
