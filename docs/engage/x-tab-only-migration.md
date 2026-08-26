# X reads move to the extension's browser tab

**Principle:** X content is collected by opening a background browser tab and
intercepting the request x.com's OWN JavaScript fires — never by calling the X
API directly from the server. A tab-driven read carries the browser's authentic
fingerprint (`x-client-transaction-id`, `Referer`, `sec-fetch-*`, page context)
because x.com's own code produced the request. A server-side API call does not.

This doc inventories every remaining server-side X read, states what the
extension already covers, and sequences the retirement. It is a migration plan,
not a completed state — check the boxes as they land.

Extension paths referenced here live in the **`aisee-browser-extension`** repo.

---

## 1. Why the two paths produce different data

This is not only a policy preference. The two paths see different payloads, and
the server-side one is strictly poorer for X:

| | Server (X API v2) | Extension (tab + internal GraphQL) |
|---|---|---|
| Long-form (`note_tweet`) t.co expansion | entity set incomplete → **body keeps raw `t.co/…`** | `note_tweet_results.result.entity_set` present → expanded |
| Attached media | not collected → `mediaUrls: []` | `collectMediaUrls()` → real CDN URLs |
| Author follower count | `public_metrics.followers_count` | `relationship_counts.followers` |

A concrete pair of stored rows, same copied content, different paths:

- `Grow_withAI/2091161941939302900` — extension: links expanded, media present.
- `ArifAIHQ/2092059641702412560` — server v2: 50 unexpanded `t.co`, no media.

So retiring the server path is also a **data-quality fix**, not only a
risk-control one. See [`author-followers-null.md`](./author-followers-null.md)
for the follower-count half of this.

---

## 2. Inventory — every server-side X read

Found via `grep -rn "api.twitter.com\|api.x.com" libraries/nestjs-libraries/src`.

| # | Location | Reads | Credential chain | Whose data | Extension cover |
|---|---|---|---|---|---|
| 0 | `engage/scan/x-scan-adapter.ts:41` | keyword / tracked search | per-integration OAuth | **third party** | ✅ `scan.x.ts` (complete) |
| 1 | `database/prisma/posts/posts.service.ts:676` | our reply's own metrics | org OAuth → app bearer | **our own post** | ✅ `metrics.reply.ts` |
| 2 | ~~`engage-metrics-sync.ts:209`~~ | original author's user id | app bearer only | third party | **REMOVED** (§5) |
| 3 | ~~`engage-metrics-sync.ts:223`~~ | did the author reply after us | app bearer only | third party | **REMOVED** (§5) |
| 4 | `engage/x-tweet.ts:68` | reply author id / name / avatar | org OAuth → app bearer | **our own reply's handle** | ✅ **keep as fallback** (§6) |

`integrations/social/x.provider.ts` also calls the X API — that is **publishing
to the org's own account**. It is out of scope and must stay: OAuth is exactly
the right mechanism for writing as yourself.

### The dividing line

Only **#0, #2, #3** read third-party content, which is what carries scraping
risk. **#1 and #4** use the org's own token to read the org's own post or a
public profile — the sanctioned use of the API. Batch accordingly rather than
cutting all five at once.

---

## 3. Done

- [x] **Extension build gate removed.** The extension carried a build-time
      `ENGAGE_X_ENABLED` flag (`flags.ts`, default OFF) from when the X read path
      was suspended outright. X is a supported platform now, and a build-time
      switch is the wrong shape: it cannot be changed for users already running
      an older build, and it had silently diverged between the two prod build
      paths (`pack-ext:prod` reads `scripts/env/prod.env`; `build:prod` does
      not). X now follows the same contract as every other session-driven
      platform — **a leased task IS the authorization to run it** — governed by
      `settings.operation_plan.allowed_platforms` / `ENGAGE_SUPPORTED_PLATFORMS`.
      Requires one more extension release to reach existing installs; after
      that, X is a runtime toggle.

---

## 4. Retire #0 — the scan adapter

The extension's `scanX` is feature-complete, so this is a switch flip, not
development. It cannot be flipped before the release above reaches users, or X
collection drops to zero on both paths.

Switches, in the order they should be used:

| Switch | Scope | Reversible |
|---|---|---|
| `engage_touch_x_switch=false` (DB, admin UI) | server only | **instantly, no redeploy** |
| `ENGAGE_X_SCAN_ENABLED=false` (env) | server only | needs orchestrator restart |
| `ENGAGE_SUPPORTED_PLATFORMS` excluding `x` | ⚠️ **server AND extension** | — |

⚠️ **Do not reach for `ENGAGE_SUPPORTED_PLATFORMS`** to do this: per
[`startup-checklist.md`](./startup-checklist.md) it disables X on *both* paths,
which is the opposite of the goal.

- [ ] Ship the extension release; confirm the allowlist includes `x`.
- [ ] Observe extension X collection volume against the current server baseline.
- [ ] `engage_touch_x_switch=false` (revert instantly if coverage disappoints).
- [ ] After a stable period, `ENGAGE_X_SCAN_ENABLED=false` to make it permanent.
- [ ] Only then consider deleting `x-scan-adapter.ts`.

---

## 5. Retire #2 / #3 — author-replied detection — **DONE**

Both were hard-gated on one variable, with **no** org-OAuth fallback (unlike #1
and #4):

```ts
const bearerToken = process.env.X_BEARER_TOKEN;
if (!bearerToken) return outcome;   // ← no token, no call
```

Production never set `X_BEARER_TOKEN`, so **neither call had ever executed**.
Removing them changed no runtime behaviour — it turned de-facto dead code into
deleted code.

### What was removed

- The author-replied block in `syncXMetrics` (both API calls).
- `syncXMetrics`' now-unread parameters — `sentReplyId`, `replyTweetUrl`,
  `originalTweetId`, `authorUsername`. It takes `{ orgId, postDbId }` now.
- The `recordApiUsage` / `X_USAGE` imports, unused once the calls went.

### What deliberately stayed

Verified before deleting — none of this is orphaned:

| Kept | Why |
|---|---|
| `EngageSentReply.authorReplied` column | Reddit still writes it |
| `EngageRepository.markAuthorReplied` | still called by `syncRedditMetrics` |
| `MetricsSyncDeps.markAuthorReplied` | same |
| `responseRate` in `getSentStats` / stats | still meaningful for Reddit |
| Frontend badges (`sent-card-x.tsx`, `sent-card-reddit.tsx`) | Reddit's still lights up |

Reddit's detection is unaffected and needs no bearer: it reads `childReplies`
out of the thread `.json` it already fetches for comment counts.

### ⚠️ Standing consequence — X `responseRate` is structurally 0

`responseRate = repliedCount / total` counts `authorReplied: true` rows. No
producer sets it for X, so:

- Filtered to X, `responseRate` is always **0%**.
- Unfiltered ("All"), X replies sit in the denominator only and **drag the
  org-wide number down**, with nothing in the data explaining why.

This was already true before the deletion (the calls never ran), but the
deletion changes its character: it is no longer "a token away" from working.
Setting `X_BEARER_TOKEN` later will NOT bring it back.

**If the product needs author-replied on X, it is now a new feature**, and it
belongs in the extension. The material is there: `fetchXPostFromPage` requests
**TweetDetail**, whose `threaded_conversation_with_injections_v2` is the whole
thread, and `collectRawTweetNodes` already walks every node including replies
nested under `content.items`. The old server test

```ts
t.author_id === originalAuthorId && BigInt(t.id) > BigInt(replyTweetId)
```

becomes "author handle matches AND id is greater" — no user-id lookup needed,
because the extension compares handles directly.

⚠️ Capability gap to accept up front: the conversation search returned up to 50
results in one call; TweetDetail is paginated. Where our reply sits deep in a
busy thread, the author's reply may not be on the first page and the check would
produce a false negative. Closing that needs thread pagination.

## 6. #4 — reply author profile — **not a retirement; coverage widened**

Investigating this one changed the conclusion. **#4 is already the
extension-first / server-fallback shape** that §7 recommends building for #1 —
it is not a path to cut.

All three call sites are guarded:

```ts
if (!author) {
  this._storeReplyAuthorInBackground(orgId, sentReplyId, platform, url);
}
```

`engage.service.ts:1377`, `:1507`, `:2792`. The comment at `:1507` states the
contract outright: *"The extension usually supplies the real poster (X
CreateTweet capture); when it doesn't, resolve it out of band."* The field
exists **because of** the extension — `engageAuthor` records who ACTUALLY
posted, which for an in-browser X session need not be the selected integration.

It also differs from #2/#3 in two ways that matter:

- It has an `org OAuth → app bearer → handle-only` chain, so unlike #2/#3 it
  **does run in production** (no `X_BEARER_TOKEN` needed). Deleting it would
  really remove avatars/names, not dead code.
- It reads the handle in **our own reply's URL** — us, or the user's own manual
  reply. Not a third party. Lowest risk of anything in this inventory.

So the work is not deleting the fallback; it is **making the fallback fire less
often**.

### Gap found and closed

The url-backfill path recovers a lost permalink by opening the tweet in a real
tab. `resolveSentTweet` reads the author out of that same node — and
`findXReplyUrl` was **throwing it away**:

```ts
const found = await resolveSentTweet(tabId, text, RECOVERY_READBACK_MS);
return found?.permalink;          // found.author discarded
```

Every backfilled row therefore reached `PATCH /engage/sent/:id/reply-url` with
no author, and the backend went out to the X API for a profile **the extension's
own tab had already loaded**.

Fixed in the extension (`aisee-browser-extension`), no backend change needed —
`submitManualReplyUrl` already accepts `body.author`:

- `findXReplyUrl` returns `{ url, author? }` instead of a bare url.
- `reply.url-backfill.ts` threads it through to the PATCH body, omitting the key
  entirely when absent (the backend branches on the field being **missing**).
- Zero extra network calls: same tab, same response, one field no longer dropped.

- [x] url-backfill forwards the author it already resolved.
- [ ] Manual URL submission (user pastes a reply link) could resolve the author
      the same way via `fetchXPostFromPage`; still falls through to the server.

### Recommendation: keep the server fallback

It is cosmetic and fire-and-forget (it degrades to handle-only and never
throws), it reads our own side rather than a third party, and it works when the
user's browser does not. Removing it would trade a real availability guarantee
for almost no risk reduction. Widen extension coverage instead; let the fallback
become rare.

## 7. Retire #1 — our own reply's metrics — **hold**

The extension's coverage is complete on capability: `fetchReplyMetrics` returns
impressions / likes / replies / retweets / quotes / bookmarks, matching the
OAuth side field for field. **The problem is availability, not capability.**

| | Server | Extension |
|---|---|---|
| Trigger | daily job + event-driven `resyncEngageMetrics` | `engage-metrics-bridge.ts` — the web page asks for it |
| Requires | nothing | user's browser open, logged into x.com, aisee-app page open |

Metrics are a **time series**: a gap is permanent. A missed scan is recovered by
the next scan; a metrics sample never taken is lost. Moving #1 to a
user-presence-dependent trigger structurally lowers sampling density.

**Recommendation: do not retire #1 on the same schedule as the others.** It
reads our own post with our own token — a categorically lower risk than #0/#2/#3
— and paying for that with discontinuous metrics is a poor trade. If it must
move, make the extension the *preferred* source with the server as fallback,
rather than an either/or, and give the extension a periodic task instead of
relying only on the page bridge.

- [ ] (Prerequisite) Extension gains a periodic engage-reply metrics task.
- [ ] Only then reconsider; prefer extension-first-with-fallback over a cutover.

---

## 8. Sequence

```
extension release (gate removal)
        ↓
#0 scan   → switch flip, no code           ← highest value, lowest cost
        ↓
#2 #3     → DONE (was dead code; X_BEARER_TOKEN was never set)
        ↓
#4        → NOT a retirement — already extension-first; coverage widened
        ↓
#1        → HOLD; needs a periodic extension task first
```

Value per unit of effort drops steeply down this list, and so does risk
reduction: #0 is most of both.
