# Opportunity content — storage contract and client rendering

How `postContent` and `mediaUrls` are produced, and what a client MUST do when
rendering them. Read this before touching any surface that displays an
opportunity body (signal feed card, reply panel preview, sent view).

- Producers: `libraries/nestjs-libraries/src/engage/scan/x-scan-adapter.ts`
  (server-side X API path), the browser extension's `x.parse.ts` (session path).
- API shape: `docs/engage/api.md` → `EngageOpportunity`.

---

## 1. What is stored

### `postContent` — the body AS THE PLATFORM DISPLAYS IT

Not the platform's wire format. Both X paths normalise before storing:

| Wire format (what the platform's API returns) | Stored |
| --- | --- |
| `check this https://t.co/Pn764BHwyL` | `check this https://seo-stuff.com/free-audit` |
| `nice shot https://t.co/imgAAA` (an attached photo) | `nice shot` |
| `good thread https://t.co/quoteAA` (a quoted tweet) | `good thread` |
| `insane clip https://t.co/vidAAA` (another tweet's video) | `insane clip` |
| `R&amp;D on &lt;script&gt;` | `R&D on <script>` |

X never puts the real link in the body: it substitutes a `t.co` shortlink and
keeps the destination in the entity set.

Two kinds of shortlink are **removed** rather than expanded, because x.com
renders each as its own block below the text and never as a link inside it:

- **an attachment** — its real URL is kept in `mediaUrls` instead.
- **a quoted tweet** — its permalink is a `t.co` as well. Expanding it would put
  a link in the body the real post never showed (and X hands back a
  `twitter.com` permalink for it, which does not even match the `x.com` form
  every stored `externalPostUrl` uses).
- **someone else's media** — a `.../status/123/video/1` or `/photo/2`
  permalink, which X uses when a tweet embeds another tweet's media. It carries
  no `media_key` (the media is the other tweet's) and is not a quote, so it is
  recognised by the permalink shape. A *plain* `.../status/123` link is still
  expanded: linking to a tweet in your own words IS shown as text.

A shortlink can appear in more than one entity set at once — X lists the same
`t.co` as both a media entity and a url entity. Removal always wins.

An ordinary link in a tweet that also quotes one is still expanded normally.

**A `t.co` link can still appear** in two cases, so clients must tolerate it:

1. Rows ingested before this normalisation existed, which are repaired only when
   the same post is scanned again (X and LinkedIn refresh `postContent` on
   re-scan; see `engage-scan-ingest.service.ts`, `TITLELESS_PLATFORMS`).
2. A shortlink the platform gave no entity for — left as-is on purpose, because
   an unresolvable link still beats a dropped one.

### `mediaUrls` — attachment URLs

`string[]`, **always present, `[]` when the post has none** — which is most
rows. Photos are direct CDN URLs (`https://pbs.twimg.com/media/…`); video and
GIF resolve to the highest-bitrate MP4.

**Design every surface for "this post has no images", and treat images as the
exception** — most rows genuinely have none.

A re-scan DOES now backfill this field. It previously did not: the upsert left
`rawData` untouched so the extension's `{ mediaUrls }` could not overwrite the
`{ tweet, author }` payload the server-side adapter archives there. That read a
merge as an either/or — the two paths write different keys and never collide —
and the cost was that an existing row could never gain its images. Rows carrying
replies are exactly the ones that cannot be deleted and re-ingested, so they had
no route to them at all. The upsert now merges with Postgres `||` (a shallow
jsonb merge), so the archive survives and new keys land on top.

`rawData` itself is never returned. It is an archive with two different shapes
depending on which path ingested the row, and returning it per item would bloat
every list response.

---

## 2. Rendering rules

### 2.1 The body is untrusted text — never `innerHTML`

`postContent` is attacker-controlled content fetched from a public platform.
Anyone can post anything and wait for a scan to pick it up.

**Never render it through `dangerouslySetInnerHTML` / `v-html` / `.innerHTML`.**

Two live injection paths make this concrete:

- Reddit's `selftext` is stored **unescaped**, exactly as the author wrote it.
- X escapes `&`, `<`, `>` on the wire, but the scanner decodes those entities so
  the body reads like the site — which means real `<` and `>` reach the column.

A `<script>` tag inserted via `innerHTML` does not execute, but
`<img src=x onerror=…>` and `<svg onload=…>` do.

Render the body as **text nodes** (React/Vue escape these automatically) and
build links as real elements. Newlines need only `white-space: pre-wrap`, never
`innerHTML`.

> Status (2026-08-26): **resolved in `aisee-app`.** `ClampablePostContent`
> renders text nodes plus real `<a>` elements; it no longer uses
> `dangerouslySetInnerHTML`. The rule stands for every new surface, and for the
> mention/hashtag work in §2.2 — that must extend the segment renderer, never
> reintroduce HTML. `injectMentionLinks()` in `aisee-app`'s
> `app/(pages)/post/calendar/_lib/post-content.ts` builds `<a>` tags as an HTML
> string for the user's OWN drafts; it must NOT be reused here, where the body is
> attacker-controlled.

### 2.2 Linkifying the body

`postContent` is **plain text**. It stores no markup and no link metadata, by
design — its other consumers are the AI reply prompt
(`engage-draft.service._buildUserPrompt`, which wraps it in `<original_post>`)
and keyword matching (`engage-scorer.postSearchText`). Injecting markdown or
HTML at storage time would push URLs into the model's context and into keyword
matches. **Linkifying is the client's job, on render.**

Three kinds of span become links. Only the first is implemented today.

#### URLs — implemented

The body holds full URLs (`https://seo-stuff.com/free-audit`); x.com shows a
shortened label. Match that: shorten the label, keep the full address in `href`
and `title`.

- `target="_blank"` with `rel="noopener noreferrer nofollow"`.
- Only `http`/`https`. Never build an anchor from any other scheme.
- **Strip trailing punctuation** — the period in `see https://a.com/x.` is
  sentence punctuation, not part of the address. ⚠️ `aisee-app` does NOT do this
  yet; its `URL_PATTERN` swallows the trailing `.`.
- Keep stripping bare `t.co` from the *display* (the legacy rows in §1).

#### @mentions and #hashtags — NOT implemented anywhere

X never puts a URL in the body for these: `@nvidia` and `#AI` live in
`entities.user_mentions` / `entities.hashtags`, and x.com linkifies them at
render. Stored as bare text, they are correct — they just render as grey text
where the source post shows a blue link.

Resolve the target from the opportunity's `platform`. Linkify **only** where the
rule is unambiguous; a wrong guess sends the reader to a stranger's profile:

| platform | span | href |
|---|---|---|
| `x` | `@handle` (1–15 of `[A-Za-z0-9_]`) | `https://x.com/{handle}` |
| `x` | `#tag` | `https://x.com/hashtag/{tag}` |
| `reddit` | `u/name` | `https://reddit.com/user/{name}` |
| `reddit` | `r/name` | `https://reddit.com/r/{name}` |
| everything else | — | **leave as text** |

LinkedIn, Hacker News, dev.to, Medium and Quora have no portable handle syntax —
do not guess one for them.

#### Reference implementation

Two passes rather than one combined regex: URLs are segmented first, then
mentions/hashtags are matched **only inside the leftover text**. That ordering
is what keeps `https://a.com/p#section` from producing a `#section` hashtag, and
it needs no lookbehind (so no Safari floor).

```ts
const URL_RE = /https?:\/\/[^\s<>"']+/g;
const TRAILING = /[.,;:!?)\]}]+$/;
// A leading boundary char is CAPTURED, not looked behind: it is what keeps
// bob@example.com from reading as a mention of @example.
const ENTITY_RE = /(^|[^\w@#/])([@#])([A-Za-z0-9_]{1,30})/g;
```

Verified against the cases that actually occur:

| input | result |
|---|---|
| `1.) 'http://12ft.io' — Bypass any paywall` | link `12ft.io`, closing quote stays text |
| `Launching today for @nvidia DGX Spark.` | mention `@nvidia`, trailing `.` stays text |
| `see https://a.com/x. next` | link `https://a.com/x`, `.` stays text |
| `mail me at bob@example.com ok` | **no mention** — plain text |
| `read https://a.com/p#section here` | one link, **no hashtag** |

**Security:** return React elements. Never assemble an HTML string, and never
pass the result to `dangerouslySetInnerHTML` — see §2.1. Reddit `selftext` is
stored unescaped and X bodies carry decoded `<`/`>`.

**Styling (`aisee-app`):** reuse the existing link token `text-blue-4398ff`, per
its `AGENTS.md` ban on bare colour values.

#### A separate defect: `stripTcoUrls` eats the following character

`aisee-app`'s `stripTcoUrls` is `/https?:\/\/t\.co\/\S+/g`. `\S+` is greedy over
non-whitespace, so a quoted shortlink loses its closing quote too:

```
stored:   1.) 'https://t.co/ElNBmlQM4R' — Bypass any paywall
rendered: 1.) ' — Bypass any paywall
```

Every legacy row from §1 renders mangled this way, which reads as "the links
vanished" rather than "the links were never expanded". Bound the match to the
shortlink's own alphabet:

```ts
/https?:\/\/t\.co\/[A-Za-z0-9]+/g
```

### 2.3 Attachments

Render **below the body**, never inside it — that is how x.com lays out an
attachment, and the body no longer contains anything referring to it.

- Skip the whole block when `mediaUrls` is empty. Most rows are empty.
- Cap at 4 (X's own maximum).
- `loading="lazy"`, `referrerPolicy="no-referrer"`.
- On image error, hide that image; when all fail, render nothing. A CDN URL can
  expire — never leave a broken-image placeholder in the feed.
- Suggested layout: a single row of equal-height thumbnails in list cards
  (keeps card height predictable), a two-column grid in the detail/reply panel,
  full width for a single image.

---

## 3. Checklist for a new surface

- [ ] Body rendered as text nodes, not HTML.
- [ ] Links are real anchors, shortened label, full `href`, `rel` set.
- [ ] Trailing punctuation excluded from the matched URL.
- [ ] `@mention` / `#hashtag` linkified per the platform table, and left as text
      on platforms with no unambiguous rule.
- [ ] An email address in the body produces no mention.
- [ ] A URL fragment (`…/p#section`) produces no hashtag.
- [ ] `t.co` still stripped from display for legacy rows — with the bounded
      pattern, not `\S+`.
- [ ] `mediaUrls` empty → no media block at all.
- [ ] Image `onError` hides the image.
- [ ] `rawData` is not requested or relied on anywhere.

### Known gaps at the time of writing

| Surface | URL links | Trailing punct | mention/hashtag | `t.co` strip |
|---|---|---|---|---|
| `aisee-app` `ClampablePostContent` | ✅ | ❌ | ❌ | ⚠️ eats next char |
| `postiz-app` `apps/frontend` engage cards | ❌ plain text | — | ❌ | — |
