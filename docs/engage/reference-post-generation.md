# Reference-Post → Original-Post Generation

Status: **backend implemented** (schema, API, generation, billing, similarity
gate, backfill script). **Frontend UI not built** — no signal-feed entry point
or composer wiring yet; the endpoint below is only reachable directly.

Implementation:
- Schema: `Post.referenceOpportunityId` (§4.2), `AiseeBusinessSubType.POST_GEN_REFERENCE` (§7) — **live**, pushed and backfilled (485 rows) against the deployment server on 2026-09-01
- Source adaptation (§6.3): `sourceAdaptation` = `PRESERVE_STRUCTURE` | `REFRAME` (default) | `FRESH_ANGLE`, prompt-side only — no mode relaxes the similarity gate, and the corrective retry is mode-aware so a rejected `PRESERVE_STRUCTURE` draft is not silently retried as a fresh angle.
- Threads (§6.2): opt-in `thread`/`maxThreadParts` (an EXACT post count INCLUDING the anchor, 1–5, default 3 — the name is historical, see §6.2), gated by the shared capability rule in [`integrations/thread-capability.ts`](../../libraries/nestjs-libraries/src/integrations/thread-capability.ts) (also adopted by `operation-plan.service.ts`, which previously judged by `comment()` alone and so dropped Hacker News threads). No schema change — a thread is N `value` entries, chained by the existing `createOrUpdatePost` path.
- Generation: [`engage-reference-post.service.ts`](../../libraries/nestjs-libraries/src/engage/engage-reference-post.service.ts), reusing [`prompt-source-envelope.ts`](../../libraries/nestjs-libraries/src/engage/prompt-source-envelope.ts), [`engage-brand-instruction.ts`](../../libraries/nestjs-libraries/src/engage/engage-brand-instruction.ts), and [`reference-similarity.ts`](../../libraries/nestjs-libraries/src/engage/reference-similarity.ts) (§6). Failures still carry every already-completed model call's usage via `ReferencePostGenerationError`/`TooSimilarToReferenceError(usages)`, so a similarity-gate rejection is billed like any other real spend (§7.1).
- Orchestration + billing + persistence: `EngageService.generateReferencePost` (§5/§7.1) — **one** call now does generate, bill, and save (see the second design revision below).
- API: `engage.controller.ts` `POST /opportunities/:id/generate-post` — see `docs/engage/api.md` §"Reference-Post Generation"
- Backfill: [`scripts/backfill-engage-reference-opportunity.ts`](../../scripts/backfill-engage-reference-opportunity.ts) (§4.4) — **run**, 485 reply posts across 14 orgs backfilled on the deployment server.
- Tests: `reference-similarity.spec.ts`, `reference-post-thread-parts.spec.ts`, `engage-reference-post.service.spec.ts`, `engage-service.reference-post.spec.ts`, `engage.controller.referencePost.spec.ts`, `thread-capability.spec.ts` — full repo suite green as of the last revision.
- Deployment: schema pushed, backend restarted, backfill run — see §10. **The API contract changed again since that deploy (thread support, then `maxThreadParts` becoming an exact count of TOTAL posts — this revision) — needs another `git pull` + backend restart, still no new schema/env changes.** ⚠️ That last one is a BEHAVIOURAL break for existing callers even though nothing starts 400-ing: the field name and its 1-5 range are unchanged, but the same value now yields one post fewer and is honoured exactly rather than as a ceiling (`thread:true` with no count went from 2-4 posts to always 3; `5` went from up to 6 posts to exactly 5). No in-repo caller sends the field, so this is an integrator-facing note.

Design revision 1 (post-deploy, still backend-only — no frontend consumes
this endpoint yet, so these were safe API-contract changes):
- `/generate-post` no longer takes `integrationId`/`tone`. The target platform
  is always the reference opportunity's OWN platform
  (`normalizeEngagePlatform(opportunity.platform)`), not a client choice —
  simpler, and it removes an entire class of "which platform is this for"
  mismatch. Creative controls now mirror `/draft`'s existing
  `strategy`/`brandStrength`/`mentions`/`outputLength` vocabulary instead of a
  bespoke `tone` axis, for UI/API consistency with the reply-draft feature
  users already know (§5/§6).

Design revision 2 (**`/save-generated-post` removed** — `/generate-post` now
does the whole job in one call):
- The original two-endpoint split copied `/draft` + `/save-draft`'s reasoning
  (persistence deferred so the user can review/edit before committing) — but
  that pair's *other* reason, supporting a reply typed by hand with `/draft`
  never called at all, doesn't apply here: "an original post inspired by
  opportunity X" only means something in the context of having actually
  generated it that way (see §5 for the fuller argument). A user who wants no
  AI involvement at all should just use the generic `POST /api/posts/`
  composer — these endpoints aren't a general-purpose "attribute any post to
  an opportunity" tool.
- `/generate-post` now always persists the result as an **account-less DRAFT**
  `Post` (`source='calendar'`, `providerIdentifier=opportunity.platform`, no
  bound integration, `referenceOpportunityId` + snapshot attached). Choosing
  which account to publish through, further content edits, and
  scheduling/publishing all go through the **existing generic
  `POST /api/posts/` edit flow** (re-post with the same `group` — the app's
  standard "edit an existing post" mechanism, per `posts.repository.ts`'s
  `createOrUpdatePost`), identical to how a user already manages any other
  draft sitting in their calendar. No new edit endpoint was needed for this.
- This also made the integration/opportunity platform-match check (added in
  revision 1) moot as a **dedicated enforcement point** — there's no longer a
  save call to enforce it at. Whatever account a user later attaches via the
  generic edit flow is subject to whatever validation that flow already has
  for every other post (none, today, for platform/content-length agreement —
  same as any hand-written draft). This is not a new gap this feature
  introduces; it's the existing, already-accepted behavior of the generic
  composer.

Known gaps vs this design (tracked, not silently dropped):
- §4.5 snapshot retention policy is still **undecided** — the full snapshot is
  stored indefinitely for now (the "keep everything forever" default this doc
  explicitly warned against), pending the product decision.
- §6's similarity thresholds (12-word run / 25% shingle overlap) are the
  starting numbers from this doc, unvalidated against real generations.
- Length targets/ceilings only really exist for X and Reddit
  (`engage-draft-length.ts`): every other platform gets X's 260-character
  target in the prompt and no hard ceiling check at all. Pre-dates thread
  support and applies equally to single posts, but it bites harder now that
  LinkedIn and Hacker News — both long-form-friendly — can produce chains.
  Fixing it means per-platform targets sourced from the provider's own
  `maxLength()`, the way `operation-plan.service.ts` already does it.

## 1. Overview

Users browsing the Engage signal feed can spot a high-performing opportunity
(a viral X post, a hot Reddit thread, …) and want to write **their own**
original post "in the same vein" — same topic/angle/format, own words, own
channel. This is the common self-media move of drafting off a proven-popular
post without republishing it.

This is **not** an Engage reply. The output is a normal calendar `Post` sent
through the org's own integration (or the extension), scheduled/published like
any other post — it does not target the original thread, does not create an
`EngageSentReply`, and does not touch the opportunity's `status` (`NEW` /
`REPLIED` / …).

## 2. Scope (V1)

- User explicitly picks **one** reference opportunity (`EngageOpportunity.id`)
  from the signal feed and asks to generate a post from it. That is the entire
  trigger — there is no automatic discovery, ranking, or suggestion of "posts
  worth copying."
- How closely the output may follow the reference is the caller's choice
  (`sourceAdaptation`, default `REFRAME` — §6.3); no setting of it permits
  reusing the reference's wording.
- Output is a single post by default, or a native **thread** on request
  (opt-in, `thread` — §6.2; the V1 "no thread expansion" bullet in §9 is
  lifted). Text is always AI-generated; the reference's own images/video may
  optionally be reused as-is (opt-in, `includeReferenceMedia` — §6.1), unlike
  the text itself they are not rewritten, since there is no equivalent of
  "paraphrase" for media.

## 3. User Flow

1. User is on an opportunity card in the signal feed and picks "Generate
   original post from this," and picks a strategy/brand-strength (same
   creative controls as reply generation — §5/§6).
2. Backend generates the text and **immediately saves it** as an
   account-less DRAFT `Post`, targeting the reference opportunity's OWN
   platform automatically, seeded with the opportunity's `title` +
   `postContent`, **not** a copy of it — see the anti-plagiarism requirement
   in §6. Streamed via SSE (mirrors the existing reply `/draft` endpoint's
   wire format — see §5), so the UX still shows the text arriving before the
   call resolves; unlike `/draft`, this call already persisted a real `Post`
   by the time it returns.
3. User reviews the draft in the normal calendar/composer UI (it's just
   another draft there — `GET`/edit by the returned `postId`), edits content
   if they want, picks which of their own connected accounts to publish
   through, and picks a send time — all through the **existing generic**
   `POST /api/posts/` edit flow (re-post with the same `group`), exactly like
   editing any other draft. No dedicated save/finalize endpoint for this
   feature — see the design-revision note at the top of this doc for why.

The opportunity itself is **not claimed or locked** by this flow (unlike
`claimOpportunityForReply` for replies). Referencing it does not consume it;
the same opportunity can be used as inspiration by multiple projects, or
multiple times by the same project.

## 4. Data Model

Needs a Prisma migration (`prisma db push`) for the new column in §4.2, plus a
one-time backfill (§4.4). `Post.source` itself (§4.1) does not change.

### 4.1 `Post.source` stays `'calendar'`

Earlier draft of this doc proposed a new `VALID_POST_SOURCES` value
(`'engage-inspired'`). Dropped: a generated post is, behaviorally, a normal
calendar post — same publish-due queue, same dashboard/traffic analytics, same
billing channel. Every one of those is decided by branching on `Post.source`
(`posts.repository.ts` publish-due/stale-sweep, `dashboard.repository.ts`,
`integration.repository.ts:693`, `posts.service.ts:1239`,
`aisee-credit.service.ts:resolveChannel` — all deny-list on the literal
`'engage'`). Keeping `source: 'calendar'` means **none of that code is
touched at all**, which is strictly safer than adding a value that has to be
proven to fall through every one of those branches the same way `'calendar'`
already does. Attribution — "this post came from the reference-post feature"
— is carried by §4.2 instead, which is a better fit for it anyway (see below).

### 4.2 `Post.referenceOpportunityId` (new column)

```prisma
model Post {
  ...
  referenceOpportunityId String?
  referenceOpportunity   EngageOpportunity? @relation("postReferenceOpportunity", fields: [referenceOpportunityId], references: [id], onDelete: SetNull)
  ...
  @@index([referenceOpportunityId])
}

model EngageOpportunity {
  ...
  referencedByPosts Post[] @relation("postReferenceOpportunity")
}
```

- `onDelete: SetNull`, not the default restrict. `EngageOpportunity` rows
  **are** hard-deleted — `engage.repository.ts:deleteOpportunitiesForAdmin`
  (backing `cleanup-engage-opportunities.ts`) — and that path already has to
  reason about one other FK pointing at it: `EngageSentReply.opportunityId`
  has no cascade, so a row with a reply is FK-refused unless
  `opportunityIdsWithPaidWork` filters it out first. `SetNull` avoids adding
  a second thing that path has to know about — the delete just proceeds and
  this column goes `null`, no exclusion-list change needed there.
- Not named `sourceEngageOpportunityId`. `Post` already has `sourcePostId`,
  which means something unrelated — release-clone/cycle-clone parent (a
  self-relation to another `Post`, see `clonedPosts`/templates-view
  filtering). A second `source*`-prefixed column with a different meaning
  next to it is a standing invitation to confuse the two later.
- "Reference" rather than "source" in the name because `source` already means
  the routing category (§4.1) — this column answers a different question
  ("which opportunity, if any, inspired this post"), not "how was this post
  created."

### 4.3 `Post.settings.referenceOpportunity` (snapshot — still needed)

The FK id alone is not durable: `EngageOpportunity` content can also drift on
re-scan, independent of deletion. `Post.settings` already carries this class
of "attribution/display data, not a query key" (`settings.engageAuthor`, the
operation-plan `campaignId`/`contentId`/`themeKey` trio —
`schema.prisma:539-553`). Same pattern here, merged in like
`mergeEngageAuthor`:

```ts
settings.referenceOpportunity = {
  opportunityId: string;       // == Post.referenceOpportunityId, duplicated
                                // here so it survives the id going null
  platform: string;            // the REFERENCE's platform (may differ from
                                // the generated post's own target platform)
  externalPostUrl: string;
  authorUsername: string;
  snapshotTitle: string | null;
  snapshotContent: string;
}
```

The column (§4.2) is for querying ("all posts generated from opportunity X",
dedup, per-opportunity counts); the snapshot is for display/audit once the id
has gone `null` or the live row has changed. Both are cheap and they answer
different questions, so keep both rather than picking one.

### 4.4 Backfill onto existing Engage reply posts

`referenceOpportunityId` should also be populated on the **existing**
`source: 'engage'` reply posts, so the column is a single, uniform way to ask
"does this post trace back to an opportunity" across the whole table —
instead of that meaning "check `referenceOpportunityId`" for reference-posts
but "join `EngageSentReply.opportunityId`" for replies.

```sql
SELECT p.id AS "postId", esr."opportunityId", esr."organizationId"
FROM "Post" p
JOIN "EngageSentReply" esr ON esr."postId" = p.id
WHERE p."referenceOpportunityId" IS NULL;
```

Implemented as [`scripts/backfill-engage-reference-opportunity.ts`](../../scripts/backfill-engage-reference-opportunity.ts):
select the candidate rows above (listed, not just counted — an operator gets
nothing actionable from a bare number), then update each by its exact `id`
via `prisma.post.update`, rather than re-running the `WHERE` clause inside a
single `UPDATE ... FROM` — so `--execute` is guaranteed to touch exactly the
set `--dry-run` just reported. `EngageSentReply.postId` is `@unique`, so this
is a safe 1:1 backfill — same shape as existing one-off scripts like
`backfill-engage-x-integration.ts`. Note this is pure data hygiene: reply
correctness never depended on it and still doesn't —
`EngageSentReply.opportunityId` remains the authoritative link for replies
(and is what protects a replied-to opportunity from
`deleteOpportunitiesForAdmin` in the first place, per §4.2). No
`settings.referenceOpportunity` snapshot backfill is proposed for these rows
— reply posts already carry their own provenance (`settings.engageAuthor`,
`EngageSentReply.inputData`); §4.3 is new surface only for the reference-post
feature's own rows.

### 4.5 `snapshotContent` retention — needs a product decision (§8)

§4.3's whole justification is that `EngageOpportunity` is not permanent —
housekeeping TTL-sweeps it and admin cleanup hard-deletes it. Storing
`snapshotContent` in `Post.settings` quietly inverts that: a full copy of
someone else's scraped third-party post now lives **forever** inside `Post`
(which has no TTL of its own), specifically for the rows this feature
creates. That is a real product/legal question, not an implementation detail
— pick one before shipping rather than defaulting into "keep everything
forever" by not deciding:

- Keep the full snapshot indefinitely (simplest, but permanently retains
  scraped third-party content the source table itself is designed to expire).
- Store a **truncated excerpt** (e.g. first ~500 chars) **+ a content hash**
  of the full original — enough for display/audit/dedup without holding a
  full copy of someone else's post forever. Leaning towards this by default,
  but flagging it as a recommendation, not a decision made on the product's
  behalf.
- Apply the **same TTL as the opportunity itself** to the snapshot (a sweep
  that nulls `snapshotContent` after N days, keeping only `opportunityId` /
  `platform` / `externalPostUrl` for provenance).

## 5. API

**One** endpoint — not the generate/save pair an earlier revision of this
doc had. That pair copied `/draft` + `/save-draft`'s split
(`docs/engage/api.md` §"Draft Generation"), but for the wrong reason:
`/save-draft`'s split exists so a reply typed **entirely by hand** can be
saved with `/draft` never called at all — replying is a natural action
independent of AI. Reference-post generation has no equivalent case: "an
original post inspired by opportunity X" only means something in the context
of having actually generated it that way. A user who wants no AI involvement
at all should just use the generic `POST /api/posts/` composer directly —
this endpoint isn't a general-purpose "attribute any post to an opportunity"
tool. So there is nothing for a second endpoint to decouple generation from;
`/generate-post` generates AND persists in one call.

### `POST /api/engage/opportunities/:id/generate-post`

Resolves the opportunity via
[`EngageService.getOpportunityById`](../../libraries/nestjs-libraries/src/engage/engage.service.ts)
(org+project scoped, **no** status gate) — **not** `getOpportunityForReply`,
which throws on `EXPIRED`/`REPLIED`/`SCHEDULED`/`DISMISSED`
(`NON_ACTIONABLE_REPLY_REASONS`). That gate exists because those statuses
mean "you can't reply to this anymore," which has no bearing on "can I still
use this as inspiration" — an already-replied-to or expired opportunity is
exactly as valid a reference as a fresh one.

Uses `@CheckPolicies([AuthorizationActions.Create, Sections.POSTS_PER_MONTH])`
— the same policy the generic `POST /api/posts/` and `/api/posts/generator`
endpoints already require — **not** any Engage-specific reply policy: the
output is a normal post, so it is gated like creating one. Carries
`@Throttle({ default: { limit: 20, ttl: 3_600_000 } })`, copied verbatim from
`/opportunities/:id/draft` — same risk shape (an authenticated user replaying
a request against a per-call Claude spend), same cap.

SSE stream, same wire format as `/draft` (`data: {...}` … `data: [DONE]`),
kept for the abort-on-disconnect behavior (cancels the in-flight model call
if the client navigates away — no point generating, billing, and persisting
for a request nobody is waiting on) and for the typed error-frame convention
— **not** because generation is truly token-streamed (it isn't; see §6, the
underlying Anthropic/OpenRouter calls are non-streaming, same as `/draft`).
Unlike `/draft`, the success frame also carries the created post's id, since
this call — unlike that one — actually persists something:

No `integrationId` or platform field: the target platform is always
`normalizeEngagePlatform(opportunity.platform)` — the reference's own
platform — never a client choice. The creative-control fields mirror
`GenerateDraftDto` (`/draft`'s own body) rather than a bespoke shape, for the
same UI the reply-draft composer already has:

| Field | Type | Required | Description |
|---|---|---|---|
| `strategy` | `string` (one of `VALID_STRATEGIES`) | ✓ | Same 7 strategy keys as `/draft` (`EXPERT_ANSWER`, `DATA_BACKED`, …), but resolved against **different, reworded prompt text** — see §6 on why the reply-draft wording (e.g. QUESTION_LED's literal "Reply with...") isn't reused as-is |
| `brandStrength` | `number` (0–3) | ✓ | Same brand-mention control as `/draft`, same mechanism (`engage-brand-instruction.ts`, shared with the reply flow) |
| `mentions` | `string[]` (≤20) | | Optional brand names, used when `brandStrength` ≥ 2 |
| `outputLength` | `integer` (≥ 2) | | Target length; same soft-target semantics as reply drafts |
| `projectId` | `string` | | Optional project scope |
| `sourceAdaptation` | `PRESERVE_STRUCTURE` \| `REFRAME` \| `FRESH_ANGLE` | | How closely the post may follow the reference; default `REFRAME`. A separate axis from `strategy` — that picks the voice, this picks the distance from the source. No mode relaxes the anti-plagiarism gate. See §6.3 |
| `includeReferenceMedia` | `boolean` | | Default `false`. Reuse the reference's own images/video as-is on the generated post — opt-in, no rewrite-mitigation exists for media the way it does for text. See §6.1 |
| `thread` | `boolean` | | Default `false`. Produce a native thread (anchor + `parentPostId`-chained follow-ups in one `group`) instead of a single post. Honoured only where the platform can chain one; elsewhere the call degrades to a single post and reports it. See §6.2 |
| `maxThreadParts` | `integer` (1–5) | | How many posts the chain has IN TOTAL, the anchor INCLUDED — `3` is the anchor plus 2 follow-ups. Default 3. Read only when `thread` is `true`. **Neither a max nor a count of parts: an EXACT count of POSTS.** The name is historical; the range is unchanged. See §6.2 |

**SSE success frame**: `data: {"text": "...", "postId": "...", "parts": ["..."], "thread": false}`
then `data: [DONE]`. `text` is the whole post (thread parts joined by a blank
line), `postId` is the ROOT post, `parts` is one entry per post in the chain,
and `thread` says whether one was actually produced — with
`threadSkippedReason` (`platform_unsupported` | `single_post_generated`)
present only when a requested thread came back as one post (§6.2).
`requestedParts` is present only when `parts` is SHORTER than the
`maxThreadParts` asked for, whether because a too-long tail part was dropped
(`droppedParts`) or because the model still wrote fewer posts after its
corrective retry (§6.2).

**On error**, a typed frame then `[DONE]` — see §7's `error code` table in
`docs/engage/api.md`; a persistence failure (rare — a DB error after a
successful, already-billed generation) falls into the generic
`generation_failed` case, same treatment as any other unexpected error, not a
distinct wire-level case. The generated text is not re-delivered in that case
— accepted as a rare-enough edge case not to warrant a partial-success frame
shape (see the design-revision note if this needs revisiting).

**Server-side flow** — matches `EngageService.generateReferencePost`'s
actual implementation:

```ts
const opportunity = await this._engageRepository.getOpportunityById(org.id, opportunityId, dto.projectId);

// ONE resolver, shared with the billing call below, so generation and the
// billing record can never disagree about which mode ran (§6.3).
const sourceAdaptation = resolveSourceAdaptation(dto.sourceAdaptation);

// A thread is only asked for on a platform that can publish one (§6.2); an
// unsupported platform degrades to a single post and is reported back.
const threadCapable = isThreadCapablePlatform(normalizeEngagePlatform(opportunity.platform));

// `parts` is the chain in publish order: [anchor] for a single post. Wrapped
// in a try/catch (elided here) that bills a ReferencePostGenerationError's
// own usages before rethrowing — see §7.1.
const { text, parts, usages } = await this._referencePostService.generate(opportunity, {
  strategy: dto.strategy,
  sourceAdaptation,
  brandStrength: dto.brandStrength,
  mentions: dto.mentions,
  outputLength: dto.outputLength,
  thread: !!dto.thread && threadCapable,
  maxThreadParts: dto.maxThreadParts,
  signal,
});
await this._billReferencePostUsages(
  org, opportunityId, opportunity.platform, dto.strategy, sourceAdaptation, usages
);

// Opt-in, best-effort, after generation succeeds — see §6.1.
const media = dto.includeReferenceMedia
  ? await this._fetchReferenceMedia(org.id, opportunityId)
  : [];

// Persist as an account-less draft — no integration chosen yet, and none is
// needed to represent "a draft exists." findFreeDateTime with no
// integrationId still returns a placeholder; CreatePostDto.date is
// unconditionally required even for a draft with nothing scheduled.
const date = await this._postsService.findFreeDateTime(org.id, undefined, dto.projectId);
const mapped = await this._postsService.mapTypeToPost(
  {
    type: 'draft',
    projectId: dto.projectId,
    source: 'calendar',   // §4.1 — always
    shortLink: false,
    tags: [],
    date,
    // One value entry per post in the chain — createOrUpdatePost chains
    // entries 2..N by parentPostId inside one group. Media on the ANCHOR
    // only: thread continuations are text-only on the extension path.
    posts: [{
      providerIdentifier: opportunity.platform,
      value: parts.map((content, i) => ({ content, image: i === 0 ? media : [] })),
    }],
  },
  org.id
);
const created = await this._postsService.createPost(org.id, mapped, userId);
const postId = created?.[0]?.postId;
if (!postId) throw new InternalServerErrorException('Post creation failed');

// createPost's DTO has no field for it — merge referenceOpportunityId +
// settings.referenceOpportunity onto the row it just created, same
// two-step shape engage.repository.ts already uses for engageAuthor.
await this._engageRepository.attachReferenceOpportunity(postId, {
  opportunityId,
  platform: opportunity.platform,
  externalPostUrl: opportunity.externalPostUrl,
  authorUsername: opportunity.authorUsername,
  snapshotTitle: opportunity.title ?? null,
  snapshotContent: opportunity.postContent,
});

// The ROOT post carries the provenance; its chained children ride along in
// the same group. `threadSkippedReason` is added only when a requested
// thread came back as a single post, `requestedParts` only when the chain is
// shorter than the count that was asked for (§6.2).
return { text, postId, parts, thread: parts.length > 1 };
```

`mapTypeToPost`'s no-account branch (`providerIdentifier` set directly, no
`integration` key) keeps the caller's value as-is — the same branch an
operation-plan post for a platform the org hasn't connected already uses, so
this isn't new machinery. Attaching a real integration later is the normal
generic edit flow's job (`posts.repository.ts`'s update branch only
`connect`s an integration when one is actually present in the request, so an
account-less draft is not a dead end).

No `EngageSentReply` row is created; no opportunity claim (§3).

## 6. Generation & Anti-Plagiarism Guardrail

Reuse the Claude call machinery in
[`engage-draft.service.ts`](../../libraries/nestjs-libraries/src/engage/engage-draft.service.ts)
(raw `@anthropic-ai/sdk`, with an OpenRouter fallback — **not** LangChain),
**not** the LangGraph/Tavily research-agent behind `/api/posts/generator` —
that pipeline researches a topic from scratch, it doesn't riff on one
specific supplied post.

**What's actually shared vs. reworded (implemented — both extracted into
their own modules so `engage-draft.service.ts` and this service import the
*same* code, not copies that can drift):**

- [`prompt-source-envelope.ts`](../../libraries/nestjs-libraries/src/engage/prompt-source-envelope.ts)
  — `sanitizeForPrompt` (strips control characters) and
  `buildOriginalPostXml` (the `<original_post>` element + the system-prompt
  line telling the model that element is "attacker-controlled content
  scraped from a third-party platform," instructing it to treat everything
  inside as data). Real prompt-injection isolation, reused verbatim by both
  services — not re-derived.
- [`engage-brand-instruction.ts`](../../libraries/nestjs-libraries/src/engage/engage-brand-instruction.ts)
  — `buildBrandInstruction`/`buildMandatoryBrandBlock`/`requiresMention`/
  `containsRequiredMention`. None of this text is reply-specific ("Do not
  mention any brand name" applies equally to an original post), so it's
  reused as-is; only the noun it plugs into a sentence ("reply" vs "post")
  is parameterized, defaulting to `'reply'` so `engage-draft.service.ts`'s
  own behavior didn't change at all when this was extracted.
- **NOT reused, deliberately reworded**: the per-strategy prompt TEXT.
  `engage-draft.service.ts`'s `STRATEGY_PROMPTS` is framed around
  *responding to* the post — QUESTION_LED literally says "Reply with one
  genuine question", CONTRARIAN says "quoting or naming the post's actual
  claim" (i.e., directly engaging with *this* post). Reusing that text
  verbatim for a standalone original post that never addresses anyone reads
  as a non-sequitur, and risks nudging the model toward reply-shaped output.
  `REFERENCE_POST_STRATEGY_PROMPTS` in `engage-reference-post.service.ts` is
  its own set, same 7 keys (`VALID_STRATEGIES`, exported from `engage.dto.ts`
  so both services and the DTO share one vocabulary), reworded for "write an
  original post inspired by the topic" instead of "reply to this post."

**Anti-plagiarism is a hard requirement, not prompt wording alone.** A system
prompt telling the model not to copy is necessary but not sufficient —
nothing stops a plausible near-verbatim output from slipping through, and
verbatim/near-verbatim reuse of someone else's post is a copyright/platform-
ToS problem for the *user*, not just a quality defect. Add an output-side
check after generation:

1. Compute word-level n-gram (e.g. 8-gram) shingles of the generated text and
   of `snapshotContent` (§4.3); if the overlap ratio exceeds a threshold (e.g.
   any 12+ consecutive words match verbatim, or shingle-set overlap exceeds
   ~25%), treat the draft as failed.
2. On failure, retry once with a corrective instruction appended to the
   system prompt (the same shape as the existing length/mention corrective
   retries in `engage-draft.service.ts`'s `_generateDraftWithConstraints` —
   reuse that retry *pattern*, not that method itself, since the failure
   condition here is different).
3. Still over threshold after the retry → surface a typed SSE error frame
   (`{"error": "too_similar_to_reference"}`, `[DONE]`), mirroring the
   existing `generation_failed` error-frame convention
   (`docs/engage/api.md` §"Draft Generation"). Do not silently deliver a
   near-copy.

This needs test coverage in at least two directions before it ships: prompt
injection via the reference content (adversarial `<original_post>` payloads
attempting to override the system prompt — mirrors whatever test suite backs
the existing reply-injection defense), and non-English/CJK references (n-gram
shingling on whitespace-delimited "words" does not work for CJK text with no
spaces — needs a character-n-gram fallback for those scripts, or the
similarity check silently no-ops on exactly the languages most likely to be
copied verbatim).

### 6.1 Reference media reuse (opt-in)

`GenerateReferencePostDto.includeReferenceMedia?: boolean`, default `false`.
Unlike the text, reused media has **no equivalent mitigation** — there is no
"rewrite it in your own words" for an image or video; using it means using
the literal file. Copyright exposure is direct, not a plagiarism-adjacent
quality concern, which is why this defaults to *off* rather than mirroring
how the text is always AI-touched: an explicit opt-in keeps that exposure to
requests where a caller actually asked for it.

When on:

1. [`EngageRepository.getOpportunityMediaUrls`](../../libraries/nestjs-libraries/src/engage/engage.repository.ts)
   reads `EngageOpportunity.rawData` (via the existing `opportunityMediaUrls`
   extractor) — a dedicated, narrowly-`select`ed query, not exposed on the
   general opportunity fetch path, since `_merge()` deliberately omits
   `rawData` everywhere else ("bloats every _merge-based response").
2. Each URL is downloaded through
   [`safe-media-fetch.ts`](../../libraries/nestjs-libraries/src/engage/safe-media-fetch.ts)'s
   `fetchMediaAsDataUri` — **not** handed to `storage.uploadSimple(url)`
   directly, which is what `agent.graph.service.ts`'s DALL-E flow does. See
   the SSRF note below for why this path can't reuse that one as-is. The
   result is an inert `data:` URI, which `uploadSimple` already ingests (it
   is the shape the DALL-E path uses), then `MediaService.saveFile` creates
   the `Media` row. No video-specific handling is needed: the storage layer
   doesn't distinguish image from video (no transcoding either way; `.mp4`
   already renders correctly wherever the composer renders post media,
   decided purely by file extension — see `video.or.image.tsx`).
3. The re-hosted path is re-checked against `hasValidMediaExtension`
   (exported from `valid.url.path.ts`, the same allowlist `MediaDto.path`'s
   `ValidUrlExtension` enforces) and dropped if it fails. Necessary because
   `uploadSimple` names files from the response content type
   (`mime.getExtension(ct) || 'png'`) and real CDNs serve types that
   allowlist rejects — X hands out `image/avif`, Reddit `video/webm`. Without
   this, one such attachment reaches `mapTypeToPost`'s `ValidationPipe`,
   which throws and destroys the whole already-generated, already-billed
   post. Checked *before* `saveFile` so a rejected file also leaves no orphan
   `Media` row in the user's library.
4. Capped at 4 items (`_maxReferenceMediaItems`), 20s
   (`_referenceMediaTimeoutMs`) and 64MB (`_maxReferenceMediaBytes`) per
   item. The size and timeout caps are enforced inside `fetchMediaAsDataUri`
   — `uploadSimple` has neither and buffers whole responses into memory.
5. **Best-effort per item, not per request.** A blocked/broken/slow/oversized
   URL is skipped and logged, not fatal — the post is still created with
   whatever media succeeded (possibly none). Runs strictly *after* generation
   succeeds, not in parallel with it, so a failed/too-similar generation
   never pays for downloads that would just be discarded.

**SSRF: why this path needs its own downloader.** `mediaUrls` come from
`EngageOpportunity.rawData`, which the browser extension scrapes off
third-party pages and ingests with only `@IsString()` validation
(`scan-ingest.dto.ts` — no scheme or host check). Until this feature, those
URLs were only ever rendered client-side. Fetching them *from the backend*
would turn a hostile post author into an SSRF vector —
`http://169.254.169.254/…` (cloud instance metadata), `http://localhost:…`,
internal RFC1918 hosts — with the response body landing in the org's media
library, i.e. readable exfiltration. `uploadSimple`'s bare `axios.get` has no
scheme check, no host check, and follows redirects, so a URL pre-check
wrapped around it would also be bypassable by a 302 from a public host.
`fetchMediaAsDataUri` therefore: allows only http/https; rejects literal
private/loopback/link-local IPs; rejects hostnames that *resolve* into those
ranges; follows redirects manually, re-running every check on each hop; caps
bytes and time; and requires an `image/*` or `video/*` content type (which
also closes `uploadSimple`'s `|| 'png'` fallback, under which a
content-type-less internal response would be stored as a viewable `.png`).
This is a deliberate, tested baseline (`safe-media-fetch.spec.ts`), **not** a
hardened egress proxy — notably it does not defeat DNS rebinding, which
needs a custom agent pinning the checked address. Prefer a network-level
egress policy if this app ever fetches untrusted URLs more broadly.

Not addressed, left for a future pass if it matters in practice: no
size/dimension validation against the eventual publish platform's own media
limits (X/Reddit/etc. each cap image/video size and duration differently) —
since the account to publish through isn't even chosen until the generic edit
flow runs later (§5), any such check would be premature here regardless;
whatever validation the generic publish path already applies to any other
post's media is all that applies to this one too, same as content length is
already not cross-checked (§9).

### 6.2 Thread generation (opt-in)

`thread: true` asks for a native thread instead of a single post: an anchor
plus follow-up parts that publish as a reply chain beneath it (an X thread,
Reddit follow-up comments, a LinkedIn comment chain, HN comment follow-ups).
Default `false` — a thread is a different artifact from a single post, never
something to hand back by surprise.

**Which platforms can carry one.** Resolved by ONE shared rule,
[`integrations/thread-capability.ts`](../../libraries/nestjs-libraries/src/integrations/thread-capability.ts),
which accepts a platform when EITHER publish path can chain it: the
provider's own `comment()` (server/API path, the same flag `isCommentable`
checks at publish time) or the extension's in-browser segment chaining
(everything in `EXTENSION_PUBLISHABLE_PLATFORMS` except
`SINGLE_SEGMENT_PLATFORMS`). Across the seven engage platforms:

| Platform | Thread | Why |
|---|---|---|
| `x` | ✅ | reply chain, both paths |
| `reddit` | ✅ | self-post + follow-up comments, both paths |
| `linkedin` | ✅ | comment chain, both paths |
| `hackernews` | ✅ | extension only — HN has no write API at all (its provider's `post()` throws by design), so every HN post publishes in-browser, where follow-ups chain fine |
| `medium` | ❌ | long-form article; a thread has no meaning there |
| `quora` | ❌ | same |
| `devto` | ❌ | same |

`operation-plan.service.ts` used to answer this question from `comment()`
alone and therefore called Hacker News unthreadable; it now imports the same
rule, so the two features cannot drift and HN plan threads are no longer
dropped.

**A `thread: true` on an unsupported platform is not an error.** The client
never picks the platform — it is always the opportunity's own (§3) — so
400-ing a request whose only fault is the opportunity it points at would be
punishing the caller for something it cannot control. The call degrades to a
single post and *says so*: the final SSE frame carries `thread: false` plus
`threadSkippedReason: "platform_unsupported"` (or `"single_post_generated"`
when the platform could have chained one but the model judged a single post
enough). Both reasons answer "you asked for a thread and did not get one", so
neither is emitted for `maxThreadParts: 1` — that asks for a single post
outright, the generator is told to write one and emits no thread instructions
at all, and reporting it as a skipped thread would blame the model for a
decision the caller made. See `docs/engage/api.md`.

**Generation.** One model call produces the whole chain, with the posts
separated by a `[[PART]]` sentinel line — a bracketed token rather than the
usual `---`/`1/5` conventions precisely because those DO occur inside real
post text. The token cannot, so splitting on it can never cut a post in half;
a response that carries it when no thread was asked for is joined back into
one post rather than leaking the sentinel into published text. `max_tokens`
scales with the number of posts requested so the last part is never truncated
mid-sentence.

`maxThreadParts` (1–5, default 3) is the TOTAL number of posts including the
anchor, and it is an **exact count, not a ceiling**. Both halves of the name
are historical:

- **"max"** — it really was a ceiling, and the prompt told the model to "use
  only as many follow-ups as the topic genuinely earns".
- **"parts"** — it counted FOLLOW-UPS beyond the anchor, so the chain was
  `1 + this`.

Together those made the endpoint look broken from outside: `2` and `3` both
came back as 2 posts, `4` and `5` both came back as 5, and nothing in the
response explained why. A caller asking for a 4-post thread wants 4 posts.
The field kept its name and its 1–5 range so existing clients did not have to
be rewritten; only the meaning of the number moved.

So the count is now enforced on three levels:

- **The prompt** asks for EXACTLY N posts and says where the extra posts come
  from — break the material down further (steps, examples, caveats), never
  pad with restatement or a summary post. Padding was and remains forbidden;
  the fix for "this topic does not fill 5 posts" is finer cuts, not 2 posts.
- **A corrective retry** when the chain comes back short. The generator's
  whole budget is `MAX_ATTEMPTS = 2` — one initial call plus one retry — and
  that retry is SHARED with the similarity and length correctives, so
  whichever problem surfaces first spends it. Accepted deliberately: every
  attempt is a paid model call, and of the three only similarity hard-fails
  without its retry (a short count ships with `requestedParts`, an over-long
  tail truncates to its valid prefix). The shortening corrective also
  restates the exact count, so fixing length can never cost a post.
- **A reported shortfall.** If the retry does not take, the short chain still
  ships — it is coherent and already billed, and a post the model refused to
  write would have been filler — but the response carries `requestedParts` so
  the client can say the thread is short instead of silently showing fewer
  posts than the user asked for.

An over-long chain is still truncated to the requested count rather than
failing an already-paid generation. `operation_plan.max_thread_parts` keeps
its own follow-ups-beyond-the-anchor CEILING semantics — despite the near
identical name, the two fields no longer mean the same thing.

**Both guardrails still apply, at the right granularity:**

- The **similarity gate** (§6) runs over the JOINED chain, not part by part.
  A thread that scatters the reference's own sentences across its parts is
  exactly as much of a copy as one that reproduces them in a single post —
  checking each part alone would be a way around the whole check.
- The **platform character ceiling** runs PER PART, since every part is its
  own published post facing that ceiling on its own — not a budget shared
  across the chain. The failure names the offending part
  (`… (thread part 2 of 3)`).

**Persistence needs no new mechanism.** The chain is written as N `value`
entries on the single `posts[]` entry, which `createOrUpdatePost` already
turns into `parentPostId`-chained rows inside one `group` — the same rows the
operation plan's thread support produces, and the shape the whole app
already treats as one post (one `POSTS_PER_MONTH` slot, one calendar entry,
group-wide scheduling and publish-method resolution). `postId` in the
response is the ROOT; the returned `parts` array lets a client render the
segments without re-splitting `text`. Reference media rides on the ANCHOR
only: thread continuations are text-only on the extension publish path
(`getDuePublishPosts` drops images on segments), so attaching it further down
would silently lose it.

### 6.3 Source adaptation

`sourceAdaptation` controls the RELATIONSHIP between the generated post and
the reference — a separate axis from `strategy`, which controls the voice the
post is written in. The two compose: a `CONTRARIAN` `FRESH_ANGLE` post and a
`CONTRARIAN` `PRESERVE_STRUCTURE` post are both contrarian, but only the
second walks the reference's own beats.

| Value | Carries over | Always rewritten |
|---|---|---|
| `PRESERVE_STRUCTURE` | Information order and overall shape (hook → detail → takeaway, list, story arc) | Every sentence |
| `REFRAME` (default) | The core point | Opening, order of ideas, structure, wording |
| `FRESH_ANGLE` | The topic and why it resonates | Everything else — different aspect/audience/question, no mirrored argument or structure |

**Why these names and not Close / Balanced / Fresh.** "Close" reads as a
promise that the system will imitate the source, which is precisely the thing
this feature must not be understood to do — a user who picks a mode called
"close" and gets a near-copy will reasonably think that is the intended
product. Each name here states what is preserved, so the safe boundary is
visible in the option itself rather than in a tooltip nobody reads.

**The default is `REFRAME`** because it keeps what made the reference worth
riffing on (its point) while forcing the post to be organized by its own
author — the most useful output and the least exposed one.

**No mode relaxes the guardrail.** All three sit under the same
do-not-copy system-prompt requirement and the same output-side similarity gate
(§6) with the same thresholds. The one prompt-level difference is a
contradiction that had to be resolved rather than a softening: the blanket
clause forbids reusing the reference's "sentences, distinctive phrases, or
structure", and under `PRESERVE_STRUCTURE` that last word contradicts the mode
itself — the model would be told to keep the shape and to drop it in the same
prompt. There the prohibition narrows to WORDING (the part that actually
carries the copyright exposure) and states why, so it cannot read as a general
carve-out. `PRESERVE_STRUCTURE` preserves the ORDER OF
IDEAS, never sentences, and its prompt says so explicitly ("Keeping its
structure is NOT permission to keep its sentences"). The natural consequence
is that this mode trips the gate — and therefore the corrective retry, and
occasionally `too_similar_to_reference` — more often than the other two. That
is the gate working, not a defect: a structure-preserving draft is exactly
where near-verbatim reuse is most likely to creep in.

The corrective retry is adaptation-aware for the same reason. Its generic
wording ("keep only the topic and general angle from the reference") would
silently downgrade a `PRESERVE_STRUCTURE` request into a `FRESH_ANGLE` one on
the second attempt; under that mode it instead says the order of ideas may
stay while no sentence or distinctive phrase of the reference may survive.

`sourceAdaptation` is recorded in the billing record's `data` alongside
`platform`/`strategy` (§7.1) — audit-only, it changes nothing about what is
charged, but it is the axis that most affects how close the output sits to the
source, so a billed generation should say which mode produced it. Generation
and that record resolve the mode through ONE function
(`resolveSourceAdaptation`, in `engage.dto.ts`) rather than each applying its
own fallback: HTTP callers are gated by the DTO's `@IsIn`, internal callers
build the dto by hand and are not, and two independent fallbacks meant such a
caller's invalid value was generated as `REFRAME` but billed as whatever it
sent.

## 7. Billing

Two independent charges, at two different points in the flow — do not
conflate them into one line item, and do not gate one on the other:

1. **Generation** — fires once per `/generate-post` call (§5), i.e. once per
   draft/regenerate, same *category* as the existing chat/composer
   "AI-generate-a-post" feature — `AiseeBusinessType.AI_COPYWRITING`,
   token-usage-based via `AiseeCreditService.billCollectedUsages` (see
   `agent.graph.service.ts` `billUsages`) — but **not** the same `subType`.
   `BillingRecord.subType` is an indexed column (`@@index([subType])`)
   whose whole purpose (per its own comment: "fine-grained categorization
   within businessType") is separating flows like this one. Reusing the
   existing `AiseeBusinessSubType.POST_GEN` (`'post_gen'`, the chat/composer
   generator's value) would make the two features indistinguishable in
   billing reports without parsing the unindexed `data` JSON on every row —
   exactly the same mistake §4.1 avoided by not reusing `Post.source:
   'calendar'` for routing. Add a new value instead, e.g.
   `AiseeBusinessSubType.POST_GEN_REFERENCE = 'post_gen_reference'`, in
   [`aisee.client.ts`](../../libraries/nestjs-libraries/src/database/prisma/ai-pricing/aisee.client.ts:37).
   Also set `BillingRecord.relatedId` (indexed, "e.g. post ID, media ID") to
   the **opportunity id** — at generation time there is no `Post` yet (§5:
   `/generate-post` doesn't persist), so the opportunity is the only stable
   handle available, and it directly ties a copywriting charge back to what
   triggered it. **Not** engage reply credits
   (`EngageEntitlementService`'s length-based reply pricing) — that model is
   specific to replies and doesn't apply here; a regenerate should cost like
   any other AI copywriting call, not like a reply.
2. **Send/publish** — the **standard** post-publish charge every `Post`
   already goes through when it exceeds the plan's included post quota
   (`POST_OVERAGE` / `deductIfOverage` — see the existing
   `post-now-failure-overage-todo` note). This is not new work for this
   feature: because `source` stays `'calendar'` (§4.1),
   `aisee-credit.service.ts:resolveChannel` already routes it to the normal
   post channel, not `ENGAGE_CHANNEL`, with no extra code — it behaves
   exactly like every other calendar post at send time.

So one generation can be billed for AI copywriting multiple times (each
regenerate) before the user ever saves/sends anything, and the eventual
publish is billed separately and unconditionally, same as any other post —
generating a draft that is never sent never reaches charge 2, and charge 1
already happened regardless of what the user does with the draft afterward.

### 7.1 Usage capture — `engage-draft.service.ts` does not have this today

`billCollectedUsages` needs an `AiUsageInfo[]` — each entry carries
`usage.{prompt_tokens,completion_tokens,total_tokens}` (`openai.service.ts`
`AiUsageInfo`). The LangGraph path gets this for free from a LangChain
callback (`AiUsageCollector`, `agent.graph.service.ts`). The Engage Claude
path does not: `_generateViaAnthropic` calls the Anthropic SDK directly and
returns only the joined text — `response.usage` (which the Anthropic
Messages API does return) is read nowhere
(`engage-draft.service.ts:404-417`). This has to be added, not assumed:

- Change the raw-call helper (or add a sibling used only by this feature) to
  return `{ text, usage }` instead of `text`, capturing
  `response.usage.input_tokens` / `output_tokens` from the same
  `messages.create()` response already being made.
- **Retries count.** `_generateDraftWithConstraints` can call the model up to
  3 times for one logical draft (length + brand-mention corrective retries,
  `MAX_ATTEMPTS = 3`). This feature adopted the same retry shape but a
  tighter budget — `MAX_ATTEMPTS = 2`, one initial call plus a single retry
  shared by its similarity, part-count and length correctives (§6.2) — and
  every attempt is a real, separately-billed Anthropic call. Push one `AiUsageInfo` entry per attempt into an array and
  pass the whole array to a single `billCollectedUsages` call after the loop
  ends — one `BillingRecord` per `/generate-post` request, not one per
  attempt (fragmenting the ledger) and not just the last attempt (undercounts
  actual spend).
- **Idempotency**: one `taskId` per `/generate-post` call via
  `AiseeClient.buildTaskId(...)`, same as `agent.graph.service.ts`
  (`BillingRecord.taskId` is `@unique`; a duplicate `taskId` is how
  `billing-taskid-idempotency` already prevents double-charging elsewhere in
  this codebase — reuse that mechanism, don't invent a new one).
- **Client disconnect**: bill in a `finally` around the generation call, keyed
  on "did the model actually run," not on "is the SSE response still
  writable." The Anthropic call is real spend the moment it returns, whether
  or not `res.write()` afterward succeeds — a client that aborts the
  `EventSource` mid-stream must not skip billing for tokens already consumed.
- **No balance pre-check, by design, not oversight.** Every existing
  `AI_COPYWRITING` subtype (`chat`, `image`, `video`, `post_gen`) bills
  *after* the call, with no pre-flight balance check — `billCollectedUsages`
  itself has none. Adding one only for this subtype would make it behave
  differently from its own siblings under the same `businessType` for no
  stated reason. Accept the same behavior and the same accepted risk this
  codebase already carries elsewhere for post-side overage (see
  `post-now-failure-overage-todo`): a failed/negative-balance deduction is
  recorded (`BillingRecord.status: 'failed'`, `debtAmount`) but does **not**
  block delivering the generated draft to the client — the generation already
  happened; withholding the text the user already paid Anthropic tokens for
  fixes nothing and only makes the failure worse.

## 8. Open Questions

Genuinely undecided — needs a product call before/during implementation, not
settled by engineering judgment alone:

- **`snapshotContent` retention (§4.5)** — full snapshot kept indefinitely,
  truncated-excerpt + hash, or TTL-swept alongside the opportunity? No
  default is assumed; see §4.5.
- Similarity-threshold tuning for §6 (12-word / 25% shingle-overlap are
  starting points, not validated numbers) — needs a first real-traffic pass
  before it's trusted as a hard gate.

## 9. Explicitly Out of Scope (V1)

Settled, not open — pulled in from what used to be open questions, so scope
does not re-diverge once implementation starts:

- ~~**Single post — no thread expansion**~~ — **now in scope, opt-in** (§6.2).
  The open question this bullet parked was how a thread interacts with
  `parentPostId` chaining, and the answer turned out to need no new mechanism:
  a thread is already just N `value` entries on one `posts[]` entry, which
  `createOrUpdatePost` chains by `parentPostId` inside a single `group` — the
  same rows the operation plan's own thread support produces. `PublishMethod`
  is likewise unaffected: it is resolved per post and applied group-wide, so
  the chain commits, schedules and publishes as one unit either way.
- Automatic discovery/ranking of "posts worth copying" — no scan, no
  scoring dimension, no proactive suggestion surface.
- Batch/multi-reference generation.
- **No upsert/regenerate-in-place.** Every `/generate-post` call is
  independent and always creates a brand-new draft `Post` — there is no
  `postId` param to say "replace the draft I'm already working on" instead of
  "give me another one." Deliberate, not an oversight: unlike replies (one
  live draft per opportunity, upserted by `/save-draft`), this feature
  intentionally allows several distinct posts inspired by the same
  opportunity, so there's no natural "the one draft for this opportunity" to
  upsert against. The accepted cost is real — a user who regenerates because
  they didn't like the wording leaves the earlier attempt behind as an
  orphaned draft, cleaned up manually (or not at all) rather than replaced.
  Revisit only if this proves to matter in practice; the fix (an optional
  `postId` that, when it names an existing DRAFT owned by this org/
  opportunity, updates it in place instead of creating a new row) is
  straightforward but was decided against for V1.
- **Scheduling or publishing** with no connected integration (i.e. actually
  going out via the extension's no-account publish path). This feature DOES
  use `mapTypeToPost`'s no-account branch (§5), but only to create the
  initial DRAFT — a real integration must be attached via the generic edit
  flow before the post can move to `schedule`/`now`; this feature itself
  never schedules or publishes anything.
- Any change to `EngageOpportunity`/`EngageOpportunityState` — this feature
  only *reads* an opportunity, it never writes one.

## 10. Deployment

This is a **backend-only, upgrade-path** change against an existing Engage
deployment — follow `docs/engage/startup-checklist.md` §0.B's shape, but most
of that checklist's steps don't apply here and are called out as skipped
below so this isn't run as a full Engage-launch procedure by mistake.

```bash
# 1) Pull the code
git pull

# 2) Regenerate the Prisma client + push the new column/relation/index
#    (Post.referenceOpportunityId, its FK to EngageOpportunity, the index —
#    §4.2) to the database. Additive only — a new nullable column + a new
#    index on an existing table — so despite the script's standard
#    --accept-data-loss flag (see startup-checklist.md §4), there is nothing
#    for it to actually drop here; safe against a live database with data.
pnpm run prisma-db-push

# 3) Restart ONLY the backend — no new frontend code shipped (§9: no UI),
#    so, unlike a typical Engage feature upgrade, frontend does NOT need
#    restarting here.
pm2 restart backend                 # dev
# pm2 restart backend-prod          # prod

# 4) (Optional, any time after step 3 — not blocking) Backfill
#    referenceOpportunityId onto existing Engage reply posts. Pure data
#    hygiene (§4.4); the feature works without it.
npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-reference-opportunity.ts
npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-reference-opportunity.ts --execute
```

**Explicitly skipped, vs. the general Engage upgrade checklist:**
- [ ] **No orchestrator/Temporal redeploy.** This feature adds no workflow —
  generation and save are both plain request/response. Do not run
  `scripts/redeploy-orchestrator.sh` for this change alone.
- [ ] **No new/changed `.env` variables.** Generation reuses whichever
  provider `engage-draft.service.ts` already uses —
  `ANTHROPIC_API_KEY`/`CLAUDE_API_KEY` or `OPENROUTER_API_KEY` — already
  required for the existing reply-draft feature. If that already works in
  the target environment, nothing to add.
- [ ] **No `pnpm install`.** No new npm dependency was introduced.

**Smoke test** (mirrors `startup-checklist.md` §8's style — manual checks,
not an automated suite):

- [ ] `POST /api/engage/opportunities/:id/generate-post` with
  `strategy: 'EXPERT_ANSWER'`, `brandStrength: 1` on any existing
  opportunity → SSE stream ends with a `data: {"text": "...", "postId":
  "..."}` frame then `[DONE]`; the generated text should read as an original
  post (not a reply, not addressed to anyone), and not a copy of the
  opportunity's `postContent`.
- [ ] Query that `postId`'s `Post` row directly (Prisma Studio or `psql`):
  `state` is `'DRAFT'`, `integrationId` is `NULL`, `providerIdentifier`
  equals the opportunity's platform, `source` is `'calendar'` (not
  `'engage'`), `referenceOpportunityId` is set to the opportunity's id, and
  `settings` (parsed) contains a `referenceOpportunity` key with
  `snapshotContent`.
- [ ] Attach a real account to that draft via the **generic** composer/edit
  flow (`POST /api/posts/` with the same `group`, or however the frontend
  normally edits a draft) and confirm it schedules/publishes normally — this
  feature does none of that itself, so it's worth confirming the generic
  path actually picks up an account-less draft correctly.
- [ ] Confirm generation does **not** create an `EngageSentReply` row and does
  **not** change the opportunity's `EngageOpportunityState.status`.
- [ ] Existing-business regression: `POST /api/engage/opportunities/:id/draft`
  (reply generation) still works unchanged — the shared
  `prompt-source-envelope.ts`/`engage-brand-instruction.ts` extraction (§6)
  touched `engage-draft.service.ts` too, so this is the one path a
  schema-only change wouldn't otherwise exercise.
- [ ] Rate limit: a 21st call within an hour from the same user returns `429`.
