-- An org may reply to the same opportunity more than once (batch send from
-- several accounts), so EngageSentReply tracking is now keyed per-post
-- (postId is already @unique) instead of per-opportunity.

-- Step 1: drop the per-opportunity unique constraint that limited an org to one
-- reply per opportunity (the cause of swallowed P2002s on batch send/schedule).
ALTER TABLE "EngageSentReply"
  DROP CONSTRAINT IF EXISTS "EngageSentReply_organizationId_opportunityId_key";

-- Step 2: add a composite index so the per-opportunity reads
-- (getOpportunityDetail / getSentReplyByOpportunity) stay fast now that they
-- are findFirst rather than findUnique.
CREATE INDEX IF NOT EXISTS "EngageSentReply_organizationId_opportunityId_idx"
  ON "EngageSentReply" ("organizationId", "opportunityId");
