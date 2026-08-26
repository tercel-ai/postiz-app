# `authorFollowers` is null on every X opportunity

`EngageOpportunity.authorFollowers` is null across the board on X rows, which
silently zeroes the author half of `scoreAuthority` (15 of the 105 total — see
`docs/engage/api.md` §Scoring). Nothing throws and nothing looks broken: a null
scores, renders, and sorts exactly like a genuine low-follower author.

Three independent causes, in three different places. Fixing any one alone does
not restore the value.

---

## Cause 1 — the extension read a container X deleted (FIXED)

`aisee-browser-extension`, `src/utils/executor/x.parse.ts`.

X reshaped the GraphQL author node. Here is a real one, captured 2026-08-26 for
`@ArifAIHQ` via TweetDetail:

```json
{
  "__typename": "User",
  "avatar": { "image_url": "https://pbs.twimg.com/…_normal.jpg" },
  "core": { "name": "Arif AI", "screen_name": "ArifAIHQ", "created_at": "…" },
  "relationship_counts": { "followers": 2992, "following": 154 },
  "relationship_perspectives": { "followed_by": false, "following": false, … },
  "tweet_counts": { "media_tweets": 333, "tweets": 19656 },
  "rest_id": "1973761301416427520"
}
```

**There is no `legacy` object at all.** The parser read
`legacy.followers_count`, so the value had been undefined on every scan since
the reshape. The handle, display name and avatar had already been given
`core.*` / `avatar.*` fallbacks when this shape landed; the follower count was
the one field missed.

The count now lives at `relationship_counts.followers`.

**Fix applied:** the parser resolves the count **by key name** across the author
node and its direct object children, instead of from one literal path. X's
observed migration pattern is *move the field, keep the name* (`screen_name` and
`name` both survived the move into `core` unrenamed), so a key search survives
the next reshape where a second hardcoded path would not. `friends_count` is
explicitly excluded — it sits in the same object and means the opposite.

Pinned by tests in `src/utils/executor/__tests__/x-parse.spec.ts`, including the
verbatim node above, so a future reshape can be diffed against real evidence.

---

## Cause 2 — the server-side v2 path (UNVERIFIED)

`libraries/nestjs-libraries/src/engage/scan/x-scan-adapter.ts:510`

```ts
authorFollowers: author?.public_metrics?.followers_count,
```

This reads the X API **v2** shape, which is a different contract from the
GraphQL node above and looks correct: `user.fields` requests `public_metrics`
(line 318) and `expansions=author_id` (line 321) puts the author into
`includes.users`, which line 258 indexes by `u.id`.

So this path *should* populate the field — but rows known to come from it are
null too. Not yet diagnosed. The v2 path archives the whole payload, so one
query settles whether the author was resolved at all:

```sql
SELECT "rawData"->'author' FROM "EngageOpportunity"
WHERE "externalPostId" = '<id>';
```

- `author` present with `public_metrics` → the read is fine, look downstream
  (Cause 3 explains a null surviving a re-scan).
- `author` null/absent → the `includes.users` lookup missed; check whether
  `tweet.author_id` matches any `u.id` in that response.

---

## Cause 3 — the upsert never updated the column (FIXED)

`libraries/nestjs-libraries/src/engage/engage-scan-ingest.service.ts`

`authorFollowers` is written in the **create** branch (line ~516) but is absent
from the **update** branch (~line 543), which refreshes only `channelFollowers`:

```ts
const update = {
  externalPostUrl: post.externalPostUrl,
  channelFollowers: post.channelFollowers ?? null,   // ← author counterpart missing
  …metrics…
};
```

The comment there — *"refresh the channel audience size so authority tracks
growth"* — states the intent for the channel side. The author side feeds the
**same** `scoreAuthority` dimension on X (where `channelFollowers` is always
null, because X has no channel), so its omission looks like an oversight rather
than a decision.

**Consequence, and why this one matters most:** every existing null row stays
null forever. Re-scanning cannot repair it, so shipping the Cause 1 fix alone
only helps posts scanned for the *first* time after the rollout.

**Fix applied** — the update branch now writes the field, but deliberately NOT
with `?? null` the way `channelFollowers` beside it does:

```ts
...(post.authorFollowers != null
  ? { authorFollowers: post.authorFollowers }
  : {}),
```

### Why not `?? null`

Every ingest source was enumerated before choosing. Only **X** reports the field
at all, and it does so from both of its paths:

| Reports `authorFollowers` | Never reports it |
| --- | --- |
| `scan/x-scan-adapter.ts:510` (server, X API v2) | `scan/reddit-scan-adapter.ts:249` (explicit `undefined`) |
| extension `scan.x.ts` (session path) | extension devto / hackernews / linkedin / medium / quora / reddit |

For every non-X platform the column is null already, so clobbering would be a
no-op there. The risk is entirely **within X**, and it is real rather than
theoretical: the field is `@IsOptional()` on `ScanIngestPostDto`, and the
extension ships to browsers on their own upgrade schedule. Any build predating
the `relationship_counts.followers` fix reports nothing, because it reads a
container X deleted. Under `?? null` the sequence

1. current extension scans a post → stores `2992`
2. older extension re-scans the same post → clears it to `null`

silently undoes the repair. A stale follower count still scores; a null scores
as zero authority.

`channelFollowers` keeps `?? null` because Reddit's `subreddit_subscribers` is
reported by every version that reports the row at all — it has no skew window.

The create branch also keeps `?? null`: there is no prior value to protect, and
a genuine `0` must still be storable (covered by tests).

---

## Backfill

Existing rows need a pass; the X path can only refill rows a live scan
re-surfaces. `scripts/backfill-engage-opportunity-content.ts` is the closest
precedent for shape (batch, re-fetch, update in place).

Order matters: Cause 3 had to land first, or a backfill would write values the
next re-scan's update branch could not maintain. That ordering is now satisfied.

---

## Checklist

- [x] Extension parser resolves the count by key, with real-node test coverage.
- [x] Update branch writes `authorFollowers`, non-clobbering; 3 tests in
      `engage-scan-ingest.service.spec.ts` pin refresh / no-clobber / zero.
- [ ] Cause 2 diagnosed via the `rawData->'author'` query above.
- [ ] Backfill run for existing null rows.
- [ ] `docs/engage/api.md:308` updated once "when is this null" is settled.
