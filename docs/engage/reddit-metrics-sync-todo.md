# TODO: Reddit Manual Reply Metrics Sync

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
