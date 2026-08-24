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
| `R&amp;D on &lt;script&gt;` | `R&D on <script>` |

X never puts the real link in the body: it substitutes a `t.co` shortlink and
keeps the destination in the entity set. An attachment gets a `t.co` placeholder
too, but x.com renders that as an image rather than as text, so it is stripped
from the body and its real URL is kept in `mediaUrls` instead.

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

Only rows ingested **after** this field shipped carry it. Re-scanning an older
row does NOT backfill it: the upsert deliberately leaves `rawData` untouched so
the extension's `{ mediaUrls }` cannot overwrite the whole tweet payload that
the server-side adapter archives there. **Design every surface for "this post
has no images", and treat images as the exception.**

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

> Status: `aisee-app`'s `ClampablePostContent` currently renders the body with
> `dangerouslySetInnerHTML`. All four of its call sites pass plain text, so the
> fix is to render text nodes plus the link elements below — nothing needs HTML.

### 2.2 Links inside the body

The body holds full URLs (`https://seo-stuff.com/free-audit`). x.com displays a
shortened label. Match that: split the body into text and link segments, render
each link as an anchor whose label is shortened but whose `href` is the full URL.

Label: drop the scheme and a leading `www.`, drop a trailing slash, truncate
long labels with an ellipsis. Keep the full address in `href` and `title` so
nothing is lost.

```
https://seo-stuff.com/free-audit   →   seo-stuff.com/free-audit
```

Requirements:

- `target="_blank"` with `rel="noopener noreferrer nofollow"`.
- Only linkify `http`/`https`. Never build an anchor from any other scheme.
- Strip trailing punctuation from the matched URL — the period in
  `see https://a.com/x.` is sentence punctuation, not part of the address.
- Keep stripping bare `t.co` links from the *display* (the legacy rows in §1).
  It is a no-op on normalised bodies.

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
- [ ] `t.co` still stripped from display for legacy rows.
- [ ] `mediaUrls` empty → no media block at all.
- [ ] Image `onError` hides the image.
- [ ] `rawData` is not requested or relied on anywhere.
