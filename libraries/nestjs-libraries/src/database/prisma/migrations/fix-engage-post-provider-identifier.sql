-- Migration: Repair Post.providerIdentifier / settings.__type on engage replies
-- Date: 2026-08-31
-- Context: engage filed every non-X reply under reddit, on BOTH write paths:
--            * upsertDraft            — `platform === 'x' ? 'x' : 'reddit'`
--            * createManualRedditPost — hard-coded 'reddit' for every non-X
--                                       platform (now createManualCommunityPost)
--          so replies on hackernews, quora, linkedin, medium and devto were
--          persisted as reddit rows — visible as a reddit Post whose releaseURL
--          points at news.ycombinator.com. The admin Post list, the calendar and
--          the platform write clock all filter on providerIdentifier, so those
--          replies were both mislabelled and miscounted. Code is fixed at both
--          sources; this repairs the rows already written.
--
-- Scope: `source = 'engage'` only. A calendar/plan post's providerIdentifier is
--        resolved from its bound integration and is already correct — this must
--        not touch it.
-- Truth: EngageOpportunity.platform, reached through EngageSentReply. That is
--        the same column the send path claims by (claimDueEngageReplies), so it
--        is what the reply actually went out on.

-- settings is a free-form TEXT column written by JSON.stringify, and on an
-- engage reply it can also carry `engageAuthor` (who posted a manual reply) —
-- patch ONLY __type via jsonb_set, never rewrite the object. A single legacy
-- malformed row must not abort the backfill, so cast through an
-- exception-safe helper rather than a bare ::jsonb.
CREATE OR REPLACE FUNCTION pg_temp.try_jsonb(t text) RETURNS jsonb AS $$
BEGIN
  RETURN t::jsonb;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

UPDATE "Post" p
SET "providerIdentifier" = o.platform,
    settings = CASE
      WHEN jsonb_typeof(pg_temp.try_jsonb(p.settings)) = 'object'
        THEN jsonb_set(
               pg_temp.try_jsonb(p.settings),
               '{__type}',
               to_jsonb(o.platform),
               true
             )::text
      -- Null/unparseable/non-object settings: write the discriminator alone.
      -- Nothing is lost — there was nothing readable to preserve.
      ELSE json_build_object('__type', o.platform)::text
    END,
    "updatedAt" = NOW()
FROM "EngageSentReply" r
JOIN "EngageOpportunity" o ON o.id = r."opportunityId"
WHERE r."postId" = p.id
  AND p.source = 'engage'
  AND o.platform <> ''
  AND p."providerIdentifier" IS DISTINCT FROM o.platform;
