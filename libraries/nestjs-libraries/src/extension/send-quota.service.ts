import { organizationSendModeKey } from './send-mode.service';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AccountWriteState, Prisma, SendIntent } from '@prisma/client';
import { readEngageConfigMetadata } from '../engage/engage-config-metadata';
import {
  daysSince,
  ENGAGE_REPLY_CHANNEL_LIMIT_KEY,
  ENGAGE_REPLY_DAILY_CEILING_KEY,
  ENGAGE_REPLY_WARMUP_KEY,
  localDayRange,
  minutesLeftInWindow,
  replyGapMinutes,
  resolveChannelDailyLimits,
  resolveReplyDailyCeilings,
  resolveReplySchedule,
  resolveReplyWarmupTiers,
  warmupFactorForDays,
} from '../engage/engage-reply-schedule';
import { sanitizePlatformPacing } from '../engage/platform-pacing-config.service';
import {
  resolvePacingRangeMs,
  resolvePacingWindow,
  withinPacingWindow,
} from '@gitroom/helpers/extension/platform-pacing';
import { resolveMinGaps } from '../database/prisma/posts/extension-publish-config.service';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { sendHash } from './send-coordination.utils';
dayjs.extend(utc);
dayjs.extend(timezone);

export interface SendBudget {
  key: string;
  scope: string;
  dimension: string;
  limit: number;
  units: number;
  windowStart: Date;
  windowEnd: Date;
  timezone: string;
  policyVersion: string;
  enforce?: boolean;
  accountKey?: string;
  projectId?: string;
  platform?: string;
  channel?: string;
  keyword?: string;
}
export interface SendQuotaPlan {
  gapMs: number;
  budgets: SendBudget[];
}
const integer = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 2147483647;

@Injectable()
export class SendQuotaService {
  async resolve(
    tx: Prisma.TransactionClient,
    intent: SendIntent,
    account: AccountWriteState,
    segmentIndex: number,
    now: Date
  ): Promise<SendQuotaPlan> {
    const modeKey = organizationSendModeKey(intent.organizationId);
    const keys = [
      modeKey,
      'platform_pacing',
      'extension_publish.min_gap',
      'engage_reply_pacing',
      'engage_reply_account_daily_cap',
      ENGAGE_REPLY_DAILY_CEILING_KEY,
      ENGAGE_REPLY_WARMUP_KEY,
      ENGAGE_REPLY_CHANNEL_LIMIT_KEY,
    ];
    const settings = await tx.settings.findMany({
      where: { key: { in: keys } },
    });
    const values = new Map(settings.map((row) => [row.key, row.value]));
    const modeConfiguration = values.get(modeKey) as { revision?: number } | null | undefined;
    const modeRevision = modeConfiguration?.revision ?? 0;
    if (!integer(modeRevision)) throw new ForbiddenException('SEND_QUOTA_POLICY_INVALID');
    const pacing = sanitizePlatformPacing(values.get('platform_pacing'));
    const window = resolvePacingWindow(pacing, intent.platform);
    if (
      !withinPacingWindow(window, now, (at, zone) => {
        try {
          const d = zone ? dayjs(at).tz(zone) : dayjs.utc(at);
          return d.hour() * 60 + d.minute();
        } catch {
          return null;
        }
      })
    )
      throw new ForbiddenException('PLATFORM_WRITE_WINDOW_CLOSED');
    let gapMs = resolvePacingRangeMs(pacing, intent.platform, 'write')[0];
    const config = await tx.engageConfig.findFirst({
      where: {
        organizationId: intent.organizationId,
        projectId: intent.projectId,
      },
    });
    const metadata = readEngageConfigMetadata(config);
    const policy = metadata.replyPolicies[intent.platform];
    const automatic = intent.sendOrigin === 'AUTOMATION';
    if (
      automatic &&
      (!metadata.automationEnabled ||
        (intent.action === 'REPLY'
          ? !metadata.autoReplyEnabled || policy?.autoReplyEnabled !== true
          : metadata.publishingEnabled === false ||
            policy?.publishingEnabled !== true))
    )
      throw new ForbiddenException('AUTOMATION_DISABLED');
    const zone =
      (account as AccountWriteState & { timezone?: string }).timezone ?? 'UTC';
    try {
      new Intl.DateTimeFormat('en', { timeZone: zone });
    } catch {
      throw new ForbiddenException('ACCOUNT_TIMEZONE_INVALID');
    }
    const accountDay = localDayRange(zone, now);
    const budgets: SendBudget[] = [];
    const add = (
      scope: string,
      dimension: string,
      limit: number,
      range: { since: Date; until: Date },
      timezone: string,
      extra: Partial<SendBudget> = {}
    ) => {
      if (!integer(limit))
        throw new ForbiddenException('SEND_QUOTA_POLICY_INVALID');
      if (extra.accountKey) extra = { platform: intent.platform, ...extra };
      const key = sendHash([
        intent.organizationId,
        // Reopening controlled sending reseeds from all facts in the same window.
        // A prior bucket cannot observe autonomous publications made while it was inactive.
        'organization-mode-revision', modeRevision,
        scope,
        dimension,
        range.since.toISOString(),
        range.until.toISOString(),
        extra.accountKey,
        extra.projectId,
        extra.platform,
        extra.channel,
        extra.keyword,
      ]);
      budgets.push({
        key,
        scope,
        dimension,
        limit,
        units: 1,
        windowStart: range.since,
        windowEnd: range.until,
        timezone,
        policyVersion: sendHash([
          modeRevision,
          limit,
          timezone,
          policy,
          settings.map((s) => [s.key, s.updatedAt]),
        ]),
        ...extra,
      });
    };
    const dailyWriteLimit = (
      account as AccountWriteState & { dailyWriteLimit?: number | null }
    ).dailyWriteLimit;
    if (dailyWriteLimit != null)
      add('ACCOUNT', 'PLATFORM_WRITES', dailyWriteLimit, accountDay, zone, {
        accountKey: intent.canonicalAccountKey!,
      });
    const replyWrite = intent.action === 'REPLY' || segmentIndex > 0;
    if (replyWrite) {
      const ceilings = resolveReplyDailyCeilings(
        values.get(ENGAGE_REPLY_DAILY_CEILING_KEY)
      );
      const tiers = resolveReplyWarmupTiers(
        values.get(ENGAGE_REPLY_WARMUP_KEY)
      );
      const age = daysSince(account.firstConfirmedAt, now);
      const capRaw = values.get('engage_reply_account_daily_cap') ?? 50;
      if (!integer(capRaw))
        throw new ForbiddenException('SEND_QUOTA_POLICY_INVALID');
      const safety = Math.max(
        1,
        Math.floor(
          (ceilings[intent.platform] ?? 50) * warmupFactorForDays(age, tiers)
        )
      );
      add(
        'ACCOUNT',
        'REPLY_WRITES',
        capRaw > 0 ? Math.min(capRaw, safety) : safety,
        accountDay,
        zone,
        { accountKey: intent.canonicalAccountKey! }
      );
      const context = (intent as SendIntent & { context?: unknown })
        .context as { channel?: string; matchedKeywords?: string[] } | null;
      const channelLimit = resolveChannelDailyLimits(
        values.get(ENGAGE_REPLY_CHANNEL_LIMIT_KEY)
      )[intent.platform];
      if (context?.channel && channelLimit !== undefined)
        add('ACCOUNT_CHANNEL', 'REPLY_WRITES', channelLimit, accountDay, zone, {
          accountKey: intent.canonicalAccountKey!,
          channel: context.channel,
        });
      if (intent.action === 'REPLY' && segmentIndex === 0) {
        const schedule = resolveReplySchedule(policy, intent.platform, {
          ceilings,
          warmupDays: age,
          warmupTiers: tiers,
        });
        const localDay = localDayRange(schedule.timezone, now);
        add(
          'PROJECT',
          'REPLY_ROOTS_AUTO',
          schedule.dailyReplyLimit,
          localDay,
          schedule.timezone ?? 'UTC',
          {
            projectId: intent.projectId,
            platform: intent.platform,
            enforce: automatic,
          }
        );
        if (automatic) {
          if (minutesLeftInWindow(schedule, now) <= 0)
            throw new ForbiddenException('PROJECT_REPLY_WINDOW_CLOSED');
          const pacingValue = values.get('engage_reply_pacing') as {
            minGapMinutes?: number;
          } | null;
          // Automatic project cadence must not extend the shared account safety clock.
          const projectGapMs = Math.max(
            gapMs,
            replyGapMinutes(schedule, now, {
              minGapMinutes: Math.max(
                0,
                Number(pacingValue?.minGapMinutes ?? 30)
              ),
            }) * 60_000
          );
          // Project spacing is shared across all actual producers.
          const last = await tx.sendSegment.findFirst({
            where: {
              segmentIndex: 0,
              status: 'CONFIRMED',
              execution: {
                intent: {
                  organizationId: intent.organizationId,
                  projectId: intent.projectId,
                  platform: intent.platform,
                  action: 'REPLY',
                },
              },
            },
            orderBy: { confirmedAt: 'desc' },
          });
          // Read pending roots in the same serializable transaction as authorization.
          // A different account must not bypass project spacing before the first receipt arrives.
          const pending = await tx.sendSegment.findFirst({
            where: {
              organizationId: intent.organizationId,
              segmentIndex: 0,
              status: { in: ['AUTHORIZED', 'UNKNOWN'] },
              authorizedAt: { not: null },
              OR: [
                { submitBefore: { gt: new Date(now.getTime() - projectGapMs) } },
                { submitBefore: null, authorizedAt: { gt: new Date(now.getTime() - projectGapMs - 30_000) } },
              ],
              execution: {
                intent: {
                  organizationId: intent.organizationId,
                  projectId: intent.projectId,
                  platform: intent.platform,
                  action: 'REPLY',
                },
              },
            },
          });
          if (pending)
            throw new ForbiddenException('PROJECT_REPLY_INTERVAL');
          if (
            last?.confirmedAt &&
            now.getTime() < last.confirmedAt.getTime() + projectGapMs
          )
            throw new ForbiddenException('PROJECT_REPLY_INTERVAL');
        }
        const utcDay = localDayRange('UTC', now);
        const plan = await tx.operationPlan.findFirst({
          where: {
            organizationId: intent.organizationId,
            projectId: intent.projectId,
            status: 'READY',
            startsAt: { lte: utcDay.since },
            endsAt: { gte: utcDay.since },
          },
          orderBy: { createdAt: 'desc' },
        });
        const planPolicy = (
          (plan?.planPayload as any)?.engagePolicies as any[] | undefined
        )?.find((p) => p?.platform === intent.platform && p.enabled === true);
        if (planPolicy) {
          const target =
            planPolicy.dailyTargets?.find(
              (d: any) => d.date === utcDay.since.toISOString().slice(0, 10)
            )?.target ?? planPolicy.targetRepliesPerDay;
          const caps = [
            target,
            planPolicy.dailyHardCap ?? planPolicy.hardCapRepliesPerDay,
          ].filter(integer);
          if (caps.length)
            add(
              'PROJECT',
              'REPLY_ROOTS_PLAN',
              Math.min(...caps),
              utcDay,
              'UTC',
              {
                projectId: intent.projectId,
                platform: intent.platform,
                enforce: !automatic,
              }
            );
          const raw = planPolicy.keywordTargets ?? {};
          const keywords = Object.keys(raw).length
            ? await tx.engageKeyword.findMany({
                where: {
                  organizationId: intent.organizationId,
                  id: { in: Object.keys(raw) },
                },
                select: { id: true, keyword: true },
              })
            : [];
          const labels = new Map(keywords.map((k) => [k.id, k.keyword]));
          for (const [id, limit] of Object.entries(raw)) {
            const keyword = labels.get(id) ?? id;
            if (
              integer(limit) &&
              limit > 0 &&
              context?.matchedKeywords?.includes(keyword)
            )
              add('PROJECT_KEYWORD', 'REPLY_ROOTS_PLAN', limit, utcDay, 'UTC', {
                projectId: intent.projectId,
                platform: intent.platform,
                keyword,
                enforce: !automatic,
              });
          }
        }
      }
    } else {
      const gaps = resolveMinGaps(
        values.get('extension_publish.min_gap') as Parameters<
          typeof resolveMinGaps
        >[0]
      );
      gapMs = Math.max(gapMs, (gaps[intent.platform] ?? 30) * 60_000);
    }
    return { gapMs: Math.min(43_200_000, Math.ceil(gapMs)), budgets };
  }

  private async baseline(
    tx: Prisma.TransactionClient,
    org: string,
    budget: SendBudget
  ) {
    const executionWhere: Prisma.SendExecutionWhereInput = {
      organizationId: org,
      ...(budget.accountKey ? { canonicalAccountKey: budget.accountKey } : {}),
      ...(budget.projectId
        ? { projectId: budget.projectId, platform: budget.platform }
        : {}),
      ...(budget.dimension.startsWith('REPLY_ROOTS')
        ? { action: 'REPLY' }
        : {}),
    };
    // New buckets include historical facts; existing buckets use only their ledger.
    const segmentWhere: Prisma.SendSegmentWhereInput = {
      organizationId: org,
      authorizedAt: { gte: budget.windowStart, lt: budget.windowEnd },
      ...(budget.dimension.startsWith('REPLY_ROOTS')
        ? { segmentIndex: 0 }
        : {}),
      execution: executionWhere,
    };
    const rows = await tx.sendSegment.findMany({
      where: {
        ...segmentWhere,
        status: { in: ['CONFIRMED', 'AUTHORIZED', 'UNKNOWN', 'NOT_SUBMITTED'] },
      },
      include: { execution: { include: { intent: true } } },
    });
    const relevant = rows.filter((row) => {
      const ctx = row.execution.context as {
        channel?: string;
        matchedKeywords?: string[];
      } | null;
      if (
        budget.dimension === 'REPLY_WRITES' &&
        row.segmentIndex === 0 &&
        row.execution.action !== 'REPLY'
      )
        return false;
      return (
        (!budget.channel || ctx?.channel === budget.channel) &&
        (!budget.keyword || ctx?.matchedKeywords?.includes(budget.keyword))
      );
    });
    const account = budget.accountKey
      ? await tx.accountWriteState.findUnique({
          where: {
            organizationId_canonicalAccountKey: {
              organizationId: org,
              canonicalAccountKey: budget.accountKey,
            },
          },
        })
      : null;
    const legacy = await tx.post.findMany({
      where: {
        organizationId: org,
        sendIntentId: null,
        state: 'PUBLISHED',
        publishDate: { gte: budget.windowStart, lt: budget.windowEnd },
        ...(account
          ? {
              OR: [
                { integrationId: { in: [...new Set([account.integrationId, ...account.identityIntegrationIds])] } },
                // Unattributed autonomous writes may belong to this actor. Unknown platforms are conservative holds.
                { integrationId: null, OR: [
                  ...(budget.platform ? [{ providerIdentifier: { in: budget.platform === 'linkedin'
                    ? ['linkedin', 'linkedin-page'] : [budget.platform] } }] : []),
                  { providerIdentifier: null }, { providerIdentifier: '' },
                ] },
              ],
            }
          : {}),
        ...(budget.projectId
          ? { projectId: budget.projectId, providerIdentifier: budget.platform === 'linkedin' ? { in: ['linkedin', 'linkedin-page'] } : budget.platform }
          : {}),
      },
      include: {
        sourcePost: { select: { parentPostId: true } },
        engageSentReply: {
          include: { opportunity: { select: { channelId: true } } },
        },
      },
    });
    const legacyCount = legacy.filter((post) => {
      let settings: any = {};
      try {
        settings = JSON.parse(post.settings ?? '{}');
      } catch {
        /* Legacy malformed settings cannot prove a reply target. */
      }
      const threadReply = !!post.parentPostId || !!post.sourcePost?.parentPostId;
      const reply =
        !!post.engageSentReply ||
        !!settings.reply_to_tweet_id ||
        !!settings.replyToId ||
        post.source === 'engage' ||
        threadReply;
      if (
        (budget.dimension === 'REPLY_WRITES' ||
          budget.dimension.startsWith('REPLY_ROOTS')) &&
        !reply
      )
        return false;
      if (budget.dimension.startsWith('REPLY_ROOTS') && threadReply)
        return false;
      const channel =
        post.engageSentReply?.opportunity?.channelId ??
        settings.subreddit?.[0]?.value?.subreddit;
      return (
        (!budget.channel || channel === budget.channel) &&
        (!budget.keyword ||
          post.engageSentReply?.matchedKeywords.includes(budget.keyword))
      );
    }).length;
    // These autonomous account writes have no Post row. POST/COMMENT receipts
    // are represented by their published Posts and must not be charged twice.
    let autonomousUnits = 0;
    if (account && ['PLATFORM_WRITES', 'REPLY_WRITES'].includes(budget.dimension)) {
      const actorIds = new Set([account.integrationId, ...account.identityIntegrationIds]);
      const receipts = await tx.sendMutationReceipt.findMany({
        where: { organizationId: org, operation: 'autonomous-side-effect' },
      });
      for (const receipt of receipts) {
        const fact = receipt.result as {
          status?: string; action?: string; integrationId?: string; confirmedAt?: string;
          quotaWriteKind?: string; quotaUnits?: number;
        } | null;
        if (!fact || fact.status !== 'CONFIRMED' || !actorIds.has(fact.integrationId!) ||
            !['THREAD_FINISHER', 'PLUG', 'INTERNAL_PLUG'].includes(fact.action!)) continue;
        // Admission time does not prove completion time; old receipts must fail closed.
        if (typeof fact.confirmedAt !== 'string') throw new ForbiddenException('SEND_QUOTA_BASELINE_UNRESOLVED');
        const at = new Date(fact.confirmedAt);
        if (!Number.isFinite(at.getTime())) throw new ForbiddenException('SEND_QUOTA_BASELINE_UNRESOLVED');
        if (at < budget.windowStart || at >= budget.windowEnd) continue;
        const kind = fact.quotaWriteKind ?? (fact.action === 'THREAD_FINISHER' ? 'REPLY' : undefined);
        const units = fact.quotaUnits ?? (fact.action === 'THREAD_FINISHER' ? 1 : undefined);
        if (units === 0) continue;
        if (!['WRITE', 'REPLY'].includes(kind!) || !integer(units))
          throw new ForbiddenException('SEND_QUOTA_BASELINE_UNRESOLVED');
        if (budget.dimension === 'REPLY_WRITES' && kind !== 'REPLY') continue;
        // Missing channel attribution cannot prove this write belonged elsewhere.
        autonomousUnits += units;
        if (!Number.isSafeInteger(autonomousUnits)) throw new ForbiddenException('SEND_QUOTA_BASELINE_UNRESOLVED');
      }
    }
    return {
      confirmedUnits:
        legacyCount + autonomousUnits + relevant.filter((r) => r.status === 'CONFIRMED').length,
      heldUnits: relevant.filter((r) => ['AUTHORIZED', 'UNKNOWN'].includes(r.status)).length,
      holds: relevant
        .filter((r) => ['AUTHORIZED', 'UNKNOWN', 'NOT_SUBMITTED'].includes(r.status))
        .map((r) => ({
          executionId: r.executionId,
          segmentIndex: r.segmentIndex,
          state: r.status === 'NOT_SUBMITTED' ? 'RELEASED' : 'HELD',
        })),
    };
  }

  async reserve(
    tx: Prisma.TransactionClient,
    org: string,
    executionId: string,
    index: number,
    budgets: SendBudget[],
    now: Date
  ) {
    for (const budget of [...budgets].sort((a, b) =>
      a.key.localeCompare(b.key)
    )) {
      if (
        !integer(budget.limit) ||
        !integer(budget.units) ||
        budget.units < 1 ||
        budget.windowStart > now ||
        budget.windowEnd <= now
      )
        throw new ForbiddenException('SEND_QUOTA_POLICY_INVALID');
      const prior = await tx.sendQuotaReservation.findUnique({
        where: {
          executionId_segmentIndex_bucketId: {
            executionId,
            segmentIndex: index,
            bucketId: budget.key,
          },
        },
      });
      if (prior) throw new ConflictException('SEGMENT_QUOTA_ALREADY_RESERVED');
      let bucket = await tx.sendQuotaBucket.findUnique({
        where: { id: budget.key },
      });
      if (!bucket) {
        const { holds, ...baseline } = await this.baseline(tx, org, budget);
        bucket = await tx.sendQuotaBucket.create({
          data: {
            id: budget.key,
            organizationId: org,
            scope: budget.scope,
            dimension: budget.dimension,
            windowStart: budget.windowStart,
            windowEnd: budget.windowEnd,
            timezone: budget.timezone,
            policyVersion: budget.policyVersion,
            limit: budget.limit,
            ...baseline,
          },
        });
        // Released attempts also need a ledger entry for contradictory late confirmations.
        for (const hold of holds)
          await tx.sendQuotaReservation.create({
            data: {
              id: sendHash([hold.executionId, hold.segmentIndex, bucket.id]),
              organizationId: org,
              ...hold,
              bucketId: bucket.id,
              units: 1,
              policyVersion: budget.policyVersion,
            },
          });
      }
      if (
        bucket.organizationId !== org ||
        bucket.windowStart.getTime() !== budget.windowStart.getTime() ||
        bucket.windowEnd.getTime() !== budget.windowEnd.getTime()
      )
        throw new ConflictException('QUOTA_BUCKET_CONFLICT');
      if (
        budget.enforce !== false &&
        bucket.confirmedUnits + bucket.heldUnits + budget.units > budget.limit
      )
        throw new ForbiddenException('SEND_QUOTA_EXHAUSTED');
      const saved = await tx.sendQuotaBucket.updateMany({
        where: {
          id: bucket.id,
          organizationId: org,
          revision: bucket.revision,
        },
        data: {
          heldUnits: { increment: budget.units },
          revision: { increment: 1 },
          limit: budget.limit,
          policyVersion: budget.policyVersion,
        },
      });
      if (saved.count !== 1) throw new ConflictException('SEND_QUOTA_CHANGED');
      await tx.sendQuotaReservation.create({
        data: {
          id: sendHash([executionId, index, bucket.id]),
          organizationId: org,
          executionId,
          segmentIndex: index,
          bucketId: bucket.id,
          units: budget.units,
          state: 'HELD',
          policyVersion: budget.policyVersion,
        },
      });
    }
  }

  async correctLateConfirmation(
    tx: Prisma.TransactionClient,
    org: string,
    executionId: string,
    index: number,
    now: Date
  ) {
    const rows = await tx.sendQuotaReservation.findMany({
      where: {
        organizationId: org,
        executionId,
        segmentIndex: index,
        state: 'RELEASED',
      },
      orderBy: { bucketId: 'asc' },
    });
    for (const row of rows) {
      const bucket = await tx.sendQuotaBucket.findUnique({ where: { id: row.bucketId } });
      if (!bucket || bucket.organizationId !== org)
        throw new ConflictException('QUOTA_LEDGER_INCONSISTENT');
      const saved = await tx.sendQuotaBucket.updateMany({
        where: { id: bucket.id, organizationId: org, revision: bucket.revision },
        data: {
          confirmedUnits: { increment: row.units },
          revision: { increment: 1 },
        },
      });
      if (saved.count !== 1) throw new ConflictException('SEND_QUOTA_CHANGED');
      const settled = await tx.sendQuotaReservation.updateMany({
        where: { id: row.id, organizationId: org, state: 'RELEASED' },
        data: { state: 'COMMITTED', settledAt: now },
      });
      if (settled.count !== 1) throw new ConflictException('QUOTA_SETTLEMENT_CHANGED');
    }
  }

  async settle(
    tx: Prisma.TransactionClient,
    org: string,
    executionId: string,
    index: number,
    confirmed: boolean,
    now: Date
  ) {
    const rows = await tx.sendQuotaReservation.findMany({
      where: {
        organizationId: org,
        executionId,
        segmentIndex: index,
        state: 'HELD',
      },
      orderBy: { bucketId: 'asc' },
    });
    for (const row of rows) {
      const bucket = await tx.sendQuotaBucket.findUnique({
        where: { id: row.bucketId },
      });
      if (
        !bucket ||
        bucket.organizationId !== org ||
        bucket.heldUnits < row.units
      )
        throw new ConflictException('QUOTA_LEDGER_INCONSISTENT');
      const saved = await tx.sendQuotaBucket.updateMany({
        where: {
          id: bucket.id,
          organizationId: org,
          revision: bucket.revision,
          heldUnits: { gte: row.units },
        },
        data: {
          heldUnits: { decrement: row.units },
          ...(confirmed ? { confirmedUnits: { increment: row.units } } : {}),
          revision: { increment: 1 },
        },
      });
      if (saved.count !== 1) throw new ConflictException('SEND_QUOTA_CHANGED');
      const result = await tx.sendQuotaReservation.updateMany({
        where: { id: row.id, state: 'HELD' },
        data: { state: confirmed ? 'COMMITTED' : 'RELEASED', settledAt: now },
      });
      if (result.count !== 1)
        throw new ConflictException('QUOTA_SETTLEMENT_CHANGED');
    }
  }
}
