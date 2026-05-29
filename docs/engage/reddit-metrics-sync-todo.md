# TODO: Reddit Manual Reply Metrics Sync

## Status (2026-05-29)

**Items 1–3 implemented.** `engageMetricsSyncWorkflow` → `EngageDataTicksActivity.syncEngageMetrics` (mirrored in `EngageService.resyncEngageMetrics` for `/engage/admin/resync-metrics`) now:
- parses the comment ID from `releaseURL`,
- fetches `score` / `num_comments` (prefers authenticated `oauth.reddit.com`, falls back to the public JSON endpoint),
- writes `Post.impressions = (score+comments)×20`, `Post.trafficScore = score×1 + num_comments×3`, and `Post.analytics` (`score` / `comments` labels),
- and checks `authorReplied`.

**Item 4 (multi-stage schedule) still open**: the workflow currently runs a **single** sync 24 h after the reply. The 1 h / 24 h / 7-day cadence below is not yet implemented. The on-demand `POST /engage/admin/resync-metrics` endpoint covers manual re-sync in the meantime.

## Background

Reddit manual reply posts are stored in the `Post` table with:
- `source = 'engage'`
- `settings = '{"__type":"reddit"}'`
- `releaseURL` = the Reddit comment permalink (e.g. `https://www.reddit.com/r/nba/comments/abc123/title/kh3def5/`)
- No `integrationId`, no `releaseId`

The `EngageSentReply` table links `opportunityId` → `postId` → Post.

`startMetricsSyncForReply` already fires `engageMetricsSyncWorkflow` after each manual reply is recorded, but that workflow does not yet implement Reddit data fetching.

## What Needs to Be Implemented

### 1. Parse comment ID from `releaseURL`

```
https://www.reddit.com/r/<sub>/comments/<postId>/<title>/<commentId>/
                                                                ↑
                                                       t1_<commentId> in Reddit API
```

### 2. Fetch metrics via Reddit public API

```
GET https://www.reddit.com/api/info.json?id=t1_<commentId>
```

Returns: `score` (upvotes), `num_comments` (replies to the comment).

No auth required for public posts. Route through `REDDIT_PROXY` if configured.

### 3. Write metrics back

Options (pick one):
- `Post.impressions` / `Post.trafficScore` (reuse existing fields)
- `EngageSentReply` custom fields (requires schema migration)

### 4. Scheduling

The `engageMetricsSyncWorkflow` should:
- Check once after 1 hour (initial traction)
- Check again after 24 hours
- Stop after 7 days (Reddit comments go cold)

## Entry Points

- Workflow trigger: `engage.service.ts:startMetricsSyncForReply(sentReplyId)`
- Workflow ID: `engage-metrics-${sentReplyId}`
- Task queue: `main`
- Sent reply lookup: `EngageSentReply` → `Post.releaseURL`
