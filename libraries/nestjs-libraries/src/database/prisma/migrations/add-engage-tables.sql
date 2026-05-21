-- CreateEnum
CREATE TYPE "EngageOpportunityStatus" AS ENUM ('NEW', 'DISMISSED', 'REPLIED', 'SCHEDULED', 'AUTO_QUEUED', 'EXPIRED');

-- CreateTable
CREATE TABLE "EngageConfig" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "setupCompleted" BOOLEAN NOT NULL DEFAULT false,
    "lastScanAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EngageConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EngageKeyword" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'CORE',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "weeklyHitCount" INTEGER NOT NULL DEFAULT 0,
    "totalHitCount" INTEGER NOT NULL DEFAULT 0,
    "lastCountedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EngageKeyword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EngageMonitoredChannel" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "channelName" TEXT NOT NULL,
    "audienceSize" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastScannedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EngageMonitoredChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EngageTrackedAccount" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'x',
    "username" TEXT NOT NULL,
    "displayName" TEXT,
    "categoryLabel" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EngageTrackedAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EngageXReplyAccount" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "engageEnabled" BOOLEAN NOT NULL DEFAULT true,
    "autoReplyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoReplyTimeStart" TEXT,
    "autoReplyTimeEnd" TEXT,
    "autoReplyTimezone" TEXT,
    "defaultStrategy" TEXT NOT NULL DEFAULT 'EXPERT_ANSWER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EngageXReplyAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EngageOpportunity" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "externalPostId" TEXT NOT NULL,
    "externalPostUrl" TEXT NOT NULL,
    "channelId" TEXT,
    "channelName" TEXT,
    "authorUsername" TEXT NOT NULL,
    "authorDisplayName" TEXT,
    "authorFollowers" INTEGER,
    "authorAvatarUrl" TEXT,
    "postContent" TEXT NOT NULL,
    "postPublishedAt" TIMESTAMP(3) NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "scoreKeyword" INTEGER NOT NULL DEFAULT 0,
    "scoreHeat" INTEGER NOT NULL DEFAULT 0,
    "scoreAuthority" INTEGER NOT NULL DEFAULT 0,
    "scoreRecency" INTEGER NOT NULL DEFAULT 0,
    "scoreTracked" INTEGER NOT NULL DEFAULT 0,
    "scoreBreakdown" JSONB,
    "intentTags" TEXT[],
    "primaryIntent" TEXT NOT NULL DEFAULT 'discussion',
    "intentScore" DOUBLE PRECISION,
    "status" "EngageOpportunityStatus" NOT NULL DEFAULT 'NEW',
    "bookmarked" BOOLEAN NOT NULL DEFAULT false,
    "metricLikes" INTEGER NOT NULL DEFAULT 0,
    "metricReplies" INTEGER NOT NULL DEFAULT 0,
    "metricRetweets" INTEGER NOT NULL DEFAULT 0,
    "metricQuotes" INTEGER NOT NULL DEFAULT 0,
    "metricScore" INTEGER NOT NULL DEFAULT 0,
    "metricUpvoteRatio" DOUBLE PRECISION,
    "metricComments" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "EngageOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EngageSentReply" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "brandStrength" INTEGER NOT NULL DEFAULT 1,
    "authorReplied" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EngageSentReply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EngageDataTicks" (
    "organizationId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "timeUnit" TEXT NOT NULL,
    "statisticsTime" TIMESTAMP(3) NOT NULL,
    "value" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "EngageConfig_organizationId_key" ON "EngageConfig"("organizationId");

-- CreateIndex
CREATE INDEX "EngageKeyword_organizationId_idx" ON "EngageKeyword"("organizationId");

-- CreateIndex
CREATE INDEX "EngageKeyword_configId_enabled_idx" ON "EngageKeyword"("configId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "EngageKeyword_configId_keyword_key" ON "EngageKeyword"("configId", "keyword");

-- CreateIndex
CREATE INDEX "EngageMonitoredChannel_organizationId_idx" ON "EngageMonitoredChannel"("organizationId");

-- CreateIndex
CREATE INDEX "EngageMonitoredChannel_configId_platform_enabled_idx" ON "EngageMonitoredChannel"("configId", "platform", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "EngageMonitoredChannel_configId_platform_channelId_key" ON "EngageMonitoredChannel"("configId", "platform", "channelId");

-- CreateIndex
CREATE INDEX "EngageTrackedAccount_organizationId_enabled_idx" ON "EngageTrackedAccount"("organizationId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "EngageTrackedAccount_configId_platform_username_key" ON "EngageTrackedAccount"("configId", "platform", "username");

-- CreateIndex
CREATE UNIQUE INDEX "EngageXReplyAccount_integrationId_key" ON "EngageXReplyAccount"("integrationId");

-- CreateIndex
CREATE INDEX "EngageXReplyAccount_organizationId_engageEnabled_idx" ON "EngageXReplyAccount"("organizationId", "engageEnabled");

-- CreateIndex
CREATE UNIQUE INDEX "EngageXReplyAccount_configId_integrationId_key" ON "EngageXReplyAccount"("configId", "integrationId");

-- CreateIndex
CREATE INDEX "EngageOpportunity_organizationId_idx" ON "EngageOpportunity"("organizationId");

-- CreateIndex
CREATE INDEX "EngageOpportunity_organizationId_status_idx" ON "EngageOpportunity"("organizationId", "status");

-- CreateIndex
CREATE INDEX "EngageOpportunity_organizationId_platform_idx" ON "EngageOpportunity"("organizationId", "platform");

-- CreateIndex
CREATE INDEX "EngageOpportunity_createdAt_idx" ON "EngageOpportunity"("createdAt");

-- CreateIndex
CREATE INDEX "EngageOpportunity_deletedAt_idx" ON "EngageOpportunity"("deletedAt");

-- CreateIndex
CREATE INDEX "EngageOpportunity_organizationId_score_idx" ON "EngageOpportunity"("organizationId", "score");

-- CreateIndex
CREATE INDEX "EngageOpportunity_organizationId_scoreKeyword_idx" ON "EngageOpportunity"("organizationId", "scoreKeyword");

-- CreateIndex
CREATE INDEX "EngageOpportunity_organizationId_scoreHeat_idx" ON "EngageOpportunity"("organizationId", "scoreHeat");

-- CreateIndex
CREATE INDEX "EngageOpportunity_organizationId_scoreAuthority_idx" ON "EngageOpportunity"("organizationId", "scoreAuthority");

-- CreateIndex
CREATE INDEX "EngageOpportunity_organizationId_scoreTracked_idx" ON "EngageOpportunity"("organizationId", "scoreTracked");

-- CreateIndex
CREATE INDEX "EngageOpportunity_organizationId_bookmarked_idx" ON "EngageOpportunity"("organizationId", "bookmarked");

-- CreateIndex
CREATE UNIQUE INDEX "EngageOpportunity_organizationId_platform_externalPostId_key" ON "EngageOpportunity"("organizationId", "platform", "externalPostId");

-- CreateIndex
CREATE UNIQUE INDEX "EngageSentReply_opportunityId_key" ON "EngageSentReply"("opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "EngageSentReply_postId_key" ON "EngageSentReply"("postId");

-- CreateIndex
CREATE INDEX "EngageSentReply_organizationId_idx" ON "EngageSentReply"("organizationId");

-- CreateIndex
CREATE INDEX "EngageDataTicks_organizationId_platform_type_timeUnit_idx" ON "EngageDataTicks"("organizationId", "platform", "type", "timeUnit");

-- CreateIndex
CREATE INDEX "EngageDataTicks_organizationId_type_statisticsTime_idx" ON "EngageDataTicks"("organizationId", "type", "statisticsTime");

-- CreateIndex
CREATE UNIQUE INDEX "EngageDataTicks_organizationId_platform_type_timeUnit_stati_key" ON "EngageDataTicks"("organizationId", "platform", "type", "timeUnit", "statisticsTime");

-- AddForeignKey
ALTER TABLE "EngageConfig" ADD CONSTRAINT "EngageConfig_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EngageKeyword" ADD CONSTRAINT "EngageKeyword_configId_fkey" FOREIGN KEY ("configId") REFERENCES "EngageConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EngageMonitoredChannel" ADD CONSTRAINT "EngageMonitoredChannel_configId_fkey" FOREIGN KEY ("configId") REFERENCES "EngageConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EngageTrackedAccount" ADD CONSTRAINT "EngageTrackedAccount_configId_fkey" FOREIGN KEY ("configId") REFERENCES "EngageConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EngageXReplyAccount" ADD CONSTRAINT "EngageXReplyAccount_configId_fkey" FOREIGN KEY ("configId") REFERENCES "EngageConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EngageXReplyAccount" ADD CONSTRAINT "EngageXReplyAccount_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EngageOpportunity" ADD CONSTRAINT "EngageOpportunity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EngageSentReply" ADD CONSTRAINT "EngageSentReply_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EngageSentReply" ADD CONSTRAINT "EngageSentReply_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "EngageOpportunity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EngageSentReply" ADD CONSTRAINT "EngageSentReply_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes added 2026-05-21 (review fix F-02 / F-03):
--   • postPublishedAt range filter
--   • GIN on intentTags array (intent filter @> queries)
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateIndex
CREATE INDEX "EngageOpportunity_organizationId_postPublishedAt_idx" ON "EngageOpportunity"("organizationId", "postPublishedAt");

-- CreateIndex (GIN — array contains queries for { intentTags: { has: 'help_seeking' } })
CREATE INDEX "EngageOpportunity_intentTags_idx" ON "EngageOpportunity" USING GIN ("intentTags");
