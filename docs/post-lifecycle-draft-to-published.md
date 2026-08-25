# Post lifecycle: DRAFT → QUEUE → PUBLISHED

Every gate a plan post passes through between "the generator wrote it" and "the
platform has it", in the order they are evaluated, with the code that owns each
one.

It exists because the chain spans three modules that each document their own
half — [Automation](./automation-api.md) owns the switches, [posts-api](./posts-api.md)
owns the queue, the [extension protocol](./extension-post-publish-protocol.md)
owns the browser — and the question people actually ask ("why has this post not
gone out?") is answered by none of them alone.

## The one thing to know first

**The Automation switches gate `DRAFT → QUEUE` only.** They are not consulted
again afterwards:

```
DRAFT ──[ ① master · ② feature · ③ platform ]──▶ QUEUE ──[ switches absent ]──▶ PUBLISHED
```

`getDuePublishPosts` — the query behind `POST /posts/publish-due` — reads neither
`automationEnabled`, nor `publishingEnabled`, nor the per-platform policy. It is
also **org-scoped, not project-scoped**: `claimDueExtensionPublishPosts(orgId, …)`
takes no `projectId`. Once a post reaches `QUEUE` it is detached from the project
configuration that put it there.

The consequence, stated plainly because it surprises people: **turning
Automation off does not stop posts that are already queued.** Switching off is a
configuration change, not a recall. A post mid-send finishes; a post sitting in
`QUEUE` still goes out at its `publishDate`. To stop a queued post you delete or
reschedule it.

## Stage 0 — materialization

`OperationPlanRepository.materializePlanPosts` writes every generated post as:

```ts
state: 'DRAFT',
publishDate: jitteredPublishDate(item),
integrationId: null,               // account binding deferred to commit time
providerIdentifier: resolvedPlatform,
operationPlanId: plan.id,
group: `${plan.id}:${item.contentId}:${resolvedPlatform}`,
```

**Nothing is auto-committed here.** A plan reaching `READY` produces drafts and
stops. `integrationId` is deliberately null — publishing routes by platform
(`settings.__type`), and binding an account at generation time would pin the post
to whichever integration happened to exist then.

Two rows never make it this far:

- a **reddit** item whose target did not resolve is dropped rather than persisted
  (it would throw at submit on `undefined.subreddit`);
- nothing else — every other platform's item is written.

**Supersede sweep.** When a plan materializes and owns at least one post, every
*earlier* plan's `DRAFT` posts in that project are soft-deleted
(`deletedAt = now`). `QUEUE` / `PUBLISHED` / `ERROR` rows survive — they are
committed work. The `planHasPosts` guard stops a degenerate plan (zero posts
resolved) from wiping a valid predecessor.

## Stage 1 — the commit gates (DRAFT → QUEUE)

Owned by `PostsService.schedulePlanPosts`. Evaluated in this order; the first
that fails ends the batch.

### ① Master switch — `metadata.automationEnabled`

Absent = **false** (`engage-config-metadata.ts`). A project that never configured
Automation has this off.

### ② Feature switch — `metadata.publishingEnabled`

```ts
publishingEnabled: explicit ?? (enabledPlatforms?.length ?? 0) > 0
```

**Not independent from ③ on legacy projects.** When the project never set the
column explicitly (`publishingConfigured === false`), this level is *derived*
from level ③ — publishing is "on" if any platform is on. Only a project that has
explicitly written the column has two genuinely separate gates here.

① and ② are ANDed by `isPublishingActive()`. Failing it returns an empty batch —
`{ scheduled: [], failed: [], total: 0, alreadyScheduled: 0 }` — not an error:
saving settings while the feature is off is legitimate, there is simply nothing
to commit.

### ③ Platform filter — `metadata.replyPolicies[p].publishingEnabled`

`resolveEnabledPlatforms` returns **three** states, and the difference matters:

| Value | Meaning | Effect |
| --- | --- | --- |
| `null` | no platform has ever been set true *or* false | **unconstrained — every platform passes** |
| `[]` | every platform explicitly turned off | nothing is committed |
| `['x', 'reddit']` | an explicit selection | only these |

`null` is not a gate. It preserves the pre-settings behaviour for projects that
predate per-platform publishing.

Resolution order: an explicit `platforms` argument wins, otherwise the project's
stored `enabledPlatforms`. Matching is `Post.providerIdentifier` lowercased, and
a post with **no** `providerIdentifier` is filtered out whenever a filter is
active — plan posts always carry one, hand-written legacy rows may not.

### ④ State filter

`state === 'DRAFT'`. `QUEUE` / `PUBLISHED` / `ERROR` roots are counted into
`total` and `alreadyScheduled` but never re-committed, which is what makes a
repeated commit idempotent.

### ⑤ Send-path resolution — `resolvePublishMethod`

Priority: **this request's choice → the persisted `publishMethod` → auto-resolve**.
Auto-resolve prefers `extension` for every extension-capable platform. A post
whose path cannot be resolved (for example an API-only platform whose integration
was deleted) lands in `failed` with a code and **stays DRAFT** — it is not an
error for the batch.

Surviving posts are flipped by `schedulePostGroupToQueue`, which moves the whole
`group` — anchor plus thread chain — so a thread never half-commits.

### Publish-time window, applied during the flip

The committed time is re-picked inside the platform's window
(project → admin platform override → admin global default), **but never
backwards across the clock**:

```ts
const usable = redistributed && redistributed.getTime() > now.valueOf()
  ? redistributed : undefined;
```

So an **overdue draft keeps its past `publishDate`** and becomes due the instant
it reaches `QUEUE`. Committing a backlog publishes it immediately, oldest first,
10 per poll — see [Operational consequences](#operational-consequences).

## Stage 2 — what commits, and when

| Trigger | Commits? |
| --- | --- |
| Plan reaches `READY` | ❌ drafts only |
| `POST /automation/enabled` OFF→ON (master) | ✅ |
| `POST /automation/enabled` ON→OFF | ❌ (and nothing is un-queued) |
| `POST /automation/publishing` with `enabled: true`, previously off | ✅ even without `commit` |
| `POST /automation/publishing` on an already-on switch | only with `commit: true` |
| `POST /automation/publishing` with `enabled: false` | ❌ |
| `POST /posts/schedule` | ✅ explicit, per id |

**Why a switch-on commits.** The switches used to be pure configuration. That
read as a clean separation and produced a dead end: a project whose plan
materialized while publishing was off kept its posts in `DRAFT`, the switch-on
did not move them, and nothing else ever would — the user saw "Scheduled
publishing: on", an empty queue, and no control that explained the gap.

**Only the OFF→ON edge.** A settings-only save (window edit, platform reorder) on
an already-on switch still needs an explicit `commit`, so editing a window never
silently queues a batch. The edge is detected **server-side** — only the server
sees the previous value, and every client has to get the same behaviour.

### Commit scope: plan-scoped, or project-scoped

`schedulePlanPosts` takes `operationPlanId: string | null`.

- **non-null** → that plan's roots, after `assertPlanBelongsToProject`.
- **null** → every live plan post of the *project*
  (`getPlanPostRootsForProject`), with no plan id to authorize; the caller was
  already authorized for the project, which is what the query is scoped to.

The null branch exists because `getActivePlan` requires
`startsAt <= now <= endsAt`. **A plan that simply ran past its end date stops
being "active"** while its `DRAFT` posts are still live, un-deleted rows on the
calendar — and the supersede sweep only deletes drafts when a *newer* plan
materializes. Before the null branch those posts were unreachable: nothing
queued them, nothing swept them, and the 7-day stale sweep does not look at
`DRAFT` at all. They sat forever.

Both branches keep the same two invariants:

- `operationPlanId: { not: null }` — a hand-authored post is never swept in.
- `deletedAt: null` — a superseded plan's soft-deleted drafts are never
  resurrected.

## Stage 3 — the queue gates (QUEUE → PUBLISHED)

None of the Automation switches appear here. `POST /posts/publish-due`
(`claimDueExtensionPublishPosts`) requires:

| Gate | Predicate |
| --- | --- |
| Due | `publishDate <= now` — **no lower bound**; overdue by any amount is still due |
| State | `state = QUEUE`, `deletedAt = null` |
| Root only | `parentPostId = null` — children ride along as segments |
| Routed to extension | `publishMethod = 'EXTENSION'`, or legacy `null` + an enabled extension-routed integration |
| Not a reply | `source != 'engage'` — the due-item shape carries no reply target |
| Not a recurring original | `intervalInDays = null` — those are a Temporal-only clone-per-cycle path |
| Lease-free | `releaseId = null`, or `claimedAt <= now − EXTENSION_PUBLISH_LEASE_MINUTES` (default 10) |

Ordered `publishDate asc`, `take` ≤ 50 (extension asks for 10). Each returned
post is stamped with a unique lease token so two browsers cannot double-publish.

### Runtime gates, in the browser

Past the query, the extension's own queue still has to agree:

| Gate | Where |
| --- | --- |
| Signed in to aisee | every alarm no-ops without a valid token |
| Task owner matches the signed-in account | `ownsEntry()` — a task waits, it is not dropped |
| `dueAt <= now()` | the queue's own copy of the due check |
| Correct platform account | `targetAccount` guard, checked before any segment goes out |
| Browser running with a live platform session | there is no server-side fallback |

A task that was mid-`publishing` when the service worker died is settled as
`error` on restore — segments may have partially posted, and blind re-running
would duplicate them.

## Stage 4 — what expires, and what does not

`markStaleQueuePostsAsError` (hourly, via `missingPostWorkflow`) marks `QUEUE`
posts older than **7 days** as `ERROR`. It excludes:

- **extension-routed posts** — they legitimately wait for a browser to come
  online. A pull executor is not a failed push, and an integration-less
  operation-plan post could not even be retried afterwards (`retryPost` needs an
  integration), so sweeping one strands it permanently.
- **engage replies** (`source = 'engage'`) — same footing, drained by
  `POST /api/engage/reply-due`.

It also never looks at `DRAFT`. So:

| State | Overdue behaviour |
| --- | --- |
| `DRAFT` | waits **forever** — never published, never errored, never swept |
| `QUEUE`, extension-routed | waits forever, publishes as soon as a browser is available |
| `QUEUE`, API-routed | `ERROR` after 7 days |

A draft that nothing ever commits is therefore silent: no error surfaces, and the
only symptom is a calendar entry in the past. That is the failure mode this
document exists to make diagnosable.

## Diagnosing "why has this post not gone out?"

Walk it in order:

```sql
-- 1. What state is it actually in, and is it still alive?
SELECT id, state, "deletedAt", "publishDate", "publishMethod",
       "providerIdentifier", "operationPlanId", "parentPostId",
       "releaseId", "claimedAt", error
FROM "Post" WHERE id = '<post-id>';
```

- `deletedAt` set → superseded by a newer plan. Gone; not recoverable.
- `state = DRAFT` → never committed. Check the stage-1 gates below.
- `state = QUEUE`, `publishDate` in the past → committed, waiting on a browser.
  Check the runtime gates (signed in? right account? browser open?).
- `state = ERROR` → read `error`.

```sql
-- 2. How many live drafts is this project holding?
SELECT "projectId", "providerIdentifier", count(*), min("publishDate") AS oldest
FROM "Post"
WHERE state = 'DRAFT' AND "deletedAt" IS NULL AND "parentPostId" IS NULL
  AND "operationPlanId" IS NOT NULL AND "intervalInDays" IS NULL
GROUP BY 1, 2 ORDER BY 3 DESC;
```

Then read the three switches for that project — `GET /projects/:projectId/automation`
reports all three levels, and
[Telling "never configured" from "everything off"](./automation-api.md#telling-never-configured-from-everything-off)
explains how to read `null` vs `[]` at the platform level.

## Operational consequences

**Committing a backlog publishes it immediately.** Overdue drafts keep their past
`publishDate` (see the window note in stage 1), so they are due the moment they
reach `QUEUE`. The extension then drains them `publishDate asc`, 10 per 1-minute
poll, serially, one segment at a time. A project holding 200 stranded drafts will
push them out over roughly 20 minutes.

If that is not wanted, do one of these **before** flipping the switch:

- move the drafts' `publishDate` into the future (they then wait normally), or
- commit one platform at a time via `POST /automation/publishing` with an
  explicit `platforms` slice.

There is deliberately no throttle in the commit path itself: the queue's pacing
(`segmentGapSeconds`, serial drain) shapes how a *batch* goes out, not how large
a batch may be.

## Where each gate lives

| Gate | File |
| --- | --- |
| Materialization, supersede sweep | `operation-plan/operation-plan.repository.ts` → `materializePlanPosts` |
| Switch resolution (①②③) | `automation/project-publishing.service.ts` → `resolve`, `isPublishingActive`, `resolveEnabledPlatforms` |
| Auto-commit on switch-on | `automation/automation.service.ts` → `savePublishing`, `saveEnabled`, `_commitPlanPosts` |
| Commit gates ③④⑤ + window | `posts/posts.service.ts` → `schedulePlanPosts`, `schedulePosts` |
| Commit scope queries | `posts/posts.repository.ts` → `getSchedulablePostRootsByPlan`, `getPlanPostRootsForProject` |
| Queue gates | `posts/posts.repository.ts` → `extensionDueWhere`, `extensionRoutedWhere`, `claimDueExtensionPublishPosts` |
| Stale sweep | `posts/posts.repository.ts` → `markStaleQueuePostsAsError` |
| Browser queue + runtime gates | extension `utils/post-publish/queue.ts`, `utils/executor/publish.runner.ts` |

## See also

- [Automation API](./automation-api.md) — the switches, their storage, and the endpoints
- [posts-api.md](./posts-api.md#post-postspublish-due) — the publish-due contract
- [Extension Post-Publish Protocol](./extension-post-publish-protocol.md) — the browser half
- [temporal-worker-modes.md](./temporal-worker-modes.md) — the API-routed path this one diverts from
