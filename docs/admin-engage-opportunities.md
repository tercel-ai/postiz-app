# Admin: EngageOpportunity clean-up

Backend contract for the extension's admin panel (options page → "Engage
opportunities"). Three endpoints: list, repair address, delete.

The delete half also exists as a standalone script that needs no API at all —
`scripts/cleanup-broken-url-opportunities.ts`. Use the script for a bulk one-off
clean-up; the endpoints are for the operator-driven flow in the extension.

## The damage being cleaned up

The LinkedIn scraper took a card's first link matching `[href*="/posts/"]`. On
a card authored by a company page that is the page's own "Posts" **tab** —
`https://www.linkedin.com/company/<slug>/posts/` — which sits in the card
header, before the timestamp permalink, and `querySelector` returns matches in
document order. So every company-authored row was stored pointing at a post
**list**.

A list page has no comment box. Every reply generated against those rows failed
to post, and the poster's failure path surfaced (rather than closed) its tab —
hence the browser filling up with `/company/<slug>/posts/` tabs.

A second, worse shape came from LinkedIn's SDUI search layout, which exposes
neither a `data-urn` nor a permalink: those rows were stored with
`externalPostUrl = ''`. Nothing downstream refused them — the reply driver
picked them up, **paid** to draft a reply, queued it, and only the in-browser
poster discovered there was nowhere to send it ("A LinkedIn post URL is required
to thread onto"). The record never leaves `QUEUE`, so the next lease cycle
offered it again, indefinitely. `EngageOpportunity 8007f51d` is the worked
example.

Both are fixed at the source now — the scraper no longer takes a list page for a
permalink, `toScanIngestPost` drops a row it cannot address, ingest drops one
that arrives anyway, and the reply driver excludes addressless opportunities
from both drafting and claiming. Rows already stored keep their bad address
until something rewrites them.

**Quora stores a scraped `href` too** (`scan.quora.ts`), so the list endpoint is
platform-filtered rather than LinkedIn-only. Repair is currently LinkedIn-only:
it needs a way to resolve an id back to an address, which only LinkedIn offers.

## Triage: repair vs delete

The panel splits rows on `replyCount`, and the split is the whole point:

| | meaning | action |
|---|---|---|
| `replyCount > 0` | Replies were generated — and **charged for** — then failed to post purely because the address was wrong. | **Repair.** The reply records stay queued, so fixing the address lets the reply runner finally deliver them. |
| `replyCount == 0` | Nothing was spent. An engage opportunity is perishable anyway. | **Delete.** A re-scan re-ingests what still matters, with a correct address. |

So `replyCount` must be accurate — it decides whether a row is repaired or
destroyed.

## Authorisation

**The extension cannot make this decision.** Its `isAdmin` flag comes from the
signed-in website — the JWT's role claims when present, otherwise the `user`
object in the page's `localStorage`, which anyone with devtools can rewrite. It
only decides whether the panel is *shown*.

All three endpoints must authorise against the session JWT server-side and
**fail closed with 403** for a non-admin. The extension deliberately does not
re-check its own flag before calling, so the server-side gate is the only gate
and cannot be mistaken for redundant.

Auth header is the one the extension already sends:
`Authorization: Bearer <access token>`.

---

## `GET /admin/engage/opportunities`

**Query**

| param | type | notes |
|---|---|---|
| `platform` | string | Omitted = every platform. |
| `page` | int | 1-based. |
| `pageSize` | int | 25 / 50 / 100 from this client. |
| `onlyBrokenUrls` | `"true"` | Only rows whose address is not a single post. Omitted = no URL filter. |

**Response `200`**

```json
{
  "items": [
    {
      "id": "b96dd1e2-4f5b-4928-b93a-90359d042360",
      "platform": "linkedin",
      "externalPostId": "7496785734394355712",
      "externalPostUrl": "https://www.linkedin.com/company/krovacloud/posts/",
      "postContent": "Not every website needs a DevOps engineer…",
      "authorDisplayName": "Krova Cloud",
      "authorUsername": "krovacloud",
      "postPublishedAt": "2026-08-18T16:14:59.473Z",
      "replyCount": 2
    }
  ],
  "total": 137,
  "page": 1,
  "pageSize": 25
}
```

- `id` is the `EngageOpportunity` primary key and must round-trip exactly — the
  other two endpoints address rows by it.
- `postContent` is compared against the live page during repair, so send the
  stored text as-is (including its `… more` truncation); the extension
  normalises before comparing.
- `authorUsername` is the `/in/<handle>` the repair falls back to. A row that
  stored NO address has no list of its own to search, and the author's
  recent-activity page is one — without this field those rows are unrepairable.
  Omit it only when the platform genuinely has no such handle.
- `total` is the count matching the filter, so the UI can page without guessing.

**Suggested `onlyBrokenUrls` predicate**

```sql
"externalPostUrl" ~ '^https?://(www\.)?linkedin\.com/(company|school|showcase)/'
  OR "externalPostUrl" = ''
```

Include `sdui-` rows. They are NOT a dead end: their id is a hash that resolves
to nothing, so recovery works by re-reading a post LIST and matching the card by
`postContent` — which is why `postContent` must be sent as-is. Two lists serve,
in this order:

1. **The address the row stored**, when it is a company / school / showcase post
   list. That is the page the row was scraped from, so the post is usually still
   on it.
2. **The author's recent-activity page**, when the row stored no address at all
   (`externalPostUrl = ''`). This is the case that matters most: those rows are
   the ones that reach the reply queue with nowhere to send to, so a reply is
   drafted, charged, queued — and can only ever fail. Recovering them needs
   `authorUsername`, which is why the list endpoint returns it.

Rows that genuinely cannot be recovered come back as `unresolved` or
`unrepairable`, so an operator still learns how many need doing by hand.

---

## `PATCH /admin/engage/opportunities/url`

**Body**

```json
{
  "items": [
    {
      "id": "b96dd1e2-4f5b-4928-b93a-90359d042360",
      "externalPostUrl": "https://www.linkedin.com/posts/krovacloud_not-every-website-needs-a-devops-engineer-activity-7496785734394355712-GDHh/"
    }
  ]
}
```

Only rows the extension verified are sent — never `unchanged`, `unresolved`,
`unrepairable`, `authwall` or `error` outcomes.

**`externalPostId` is never sent, even when the repair discovered the real one.**
A list-page recovery often turns up the post's true numeric id, and the panel
displays it, but applying it would rewrite the key behind
`@@unique([platform, externalPostId])` and could collide with a row a later scan
already ingested under that id. Fixing the address is what unblocks the queued
replies; re-keying a row is a separate, deliberate migration.

**Response `200`** — `{ "updated": 1 }`

**Requirements**

- **Idempotent.** Re-sending the same pair is a no-op, not an error; an operator
  may re-run a batch after a partial failure.
- **Validate server-side anyway.** Reject an `externalPostUrl` that is not a
  single post — the same rule the extension applies, restated because a client
  is never where a data invariant is enforced. Reject `/company/`, `/school/`,
  `/showcase/`; accept `/feed/update/urn:li:…`, `/posts/<slug>…`,
  `/pulse/<slug>`.
- **Touch nothing else** on the row — in particular not `externalPostId`, which
  is the identity the repair was verified against.
- `403` non-admin. A vanished id is skipped, not a batch failure.

### After repair: the replies must actually be retried

Repairing the address is only half the delivery. `reply.runner.ts` takes its
targets from `POST /engage/reply-due`, using the URL the backend supplies — so
a corrected address is picked up automatically **provided those reply records
are still handed out**.

The runner never PATCHes anything on failure (only a successful post calls
`publish-reply`), so the records should still be `QUEUE`. Confirm that:

- no failure counter or back-off has pushed them out of `reply-due`, and
- no lease/attempt cap has retired them.

If either has, reset it as part of the repair — otherwise the addresses get
fixed and nothing ever re-sends, which leaves the charge unfulfilled exactly as
before.

---

## `DELETE /admin/engage/opportunities`

**Body** — `{ "ids": ["…", "…"] }`

**Response `200`** — `{ "deleted": 12, "skipped": 1 }`

**Requirements**

- **Re-verify "no replies" server-side, per id, at delete time.** The extension
  filters on `replyCount === 0`, but its counts are only as fresh as its last
  list call. A row that gained a reply in between must be **skipped and counted
  in `skipped`**, never deleted — deleting it would destroy paid work. This is
  the single most important rule on this endpoint.
- **Cascade.** Remove the rows that reference the opportunity too, so no
  orphans are left behind. Do this in one transaction per batch: a partial
  delete that drops the parent and leaves children is worse than not deleting.
- `skipped` is reported to the operator, so it must reflect real refusals rather
  than being folded silently into `deleted`.
- `403` non-admin. Unknown ids are skipped, not a batch failure.

Whether this is a hard delete or a `deletedAt` soft delete is the backend's
call — the extension only reports the counts. Soft delete is the safer default
given the cascade, as long as the rows stop being served everywhere.

---

## Pacing

Repair probes one row at a time with a jittered **5–10s** gap, driving the
operator's personal LinkedIn session in a background tab. That pace is
deliberate — a flagged account costs far more than a slow repair — so a page of
25 takes roughly three minutes. Size pages with that in mind rather than raising
the limit.

Listing and deleting are ordinary API calls with no such constraint.
