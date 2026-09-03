/**
 * Calibrate the write-path limits against what accounts ACTUALLY do.
 *
 * Every ceiling in docs/engage/write-path-limits.md was derived from a formula,
 * not from measurement. A formula tells you a bound is finite; it does not tell
 * you whether it is 10x or 1000x above real usage — and a ceiling nobody
 * approaches is indistinguishable from no ceiling at all, while one people graze
 * is an outage waiting for a busy week. This prints the ratio.
 *
 * Deliberately measures OUTCOMES, not breaches. A breach counter reads zero
 * whether the limit is perfectly tuned or absurdly high, so it cannot answer
 * "is this reasonable"; the distance between the busiest real account and the
 * cap can.
 *
 * Read-only. Touches no settings and writes nothing.
 *
 * Usage:
 *   npx tsx scripts/analyze-write-limits.ts              # last 30 days
 *   npx tsx scripts/analyze-write-limits.ts --days=90
 *   npx tsx scripts/analyze-write-limits.ts --json       # machine-readable
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';

const args = process.argv.slice(2);
const days = Number(args.find((a) => a.startsWith('--days='))?.split('=')[1] ?? 30);
const asJson = args.includes('--json');

const prisma = new PrismaClient();

/** Percentile of a sorted-ascending numeric array. */
function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

function describe(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: pct(sorted, 0.5),
    p95: pct(sorted, 0.95),
    max: sorted.length ? sorted[sorted.length - 1] : 0,
  };
}

/**
 * How much room a cap leaves above the busiest real account.
 *
 * `null` cap = unlimited, which is the finding, not a ratio. A busiest value of
 * 0 means nobody exercises the path at all — also a finding, and one a ratio
 * would hide behind Infinity.
 */
function headroom(cap: number | null, busiest: number): string {
  if (cap === null) return 'UNLIMITED — no ceiling to compare against';
  if (busiest === 0) return `${cap} cap — no usage measured on this path`;
  const ratio = cap / busiest;
  const verdict =
    ratio < 2 ? 'TIGHT — a busy week trips this'
      : ratio < 10 ? 'snug'
      : ratio < 1000 ? 'comfortable'
      : 'VERY LOOSE — nothing plausible reaches it';
  return `${ratio.toFixed(1)}x above the busiest account (${busiest} vs ${cap}) — ${verdict}`;
}

async function readSetting<T>(key: string): Promise<T | null> {
  const row = await prisma.settings.findUnique({ where: { key } });
  return (row?.value as T) ?? null;
}

async function main() {
  const since = new Date(Date.now() - days * 86_400_000);
  const out: Record<string, unknown> = { days, since: since.toISOString() };

  // ── Configured caps, read from the same settings the runtime reads ────────
  const rateLimits = await readSetting<Record<string, number>>('api_rate_limits');
  const ingestQuota = await readSetting<Record<string, unknown>>('engage_ingest_quota');
  const planLimits = await readSetting<Record<string, Record<string, number | null>>>(
    'post_plan_limits'
  );
  const allowlist = (await readSetting<string[]>('operation_plan.allowed_platforms')) ?? [];
  const platformCount = new Set(allowlist.map((p) => String(p).toLowerCase())).size || 8;

  // Mirrors DEFAULT_POST_PLAN_LIMITS. Applied per FIELD, exactly as
  // PostPlanLimitsService.getAll does: a stored row written before a field
  // existed is absent, not null, and the runtime falls back to the default —
  // reading the raw row alone would report "unlimited" for a path that is in
  // fact capped, which is worse than no report.
  const DEFAULTS = { draftsPerPlatformMax: 5000, draftsPerPlatformPerProjectMax: 500 };
  const growth = planLimits?.['growth-loop'] ?? {};
  const perPlatform = (field: keyof typeof DEFAULTS): number | null => {
    const raw = growth[field];
    if (raw === undefined) return DEFAULTS[field]; // absent → default
    if (raw === null) return null; // explicit → unlimited
    return Number(raw);
  };
  const scale = (v: number | null) => (v === null ? null : v * platformCount);
  const draftProjectCap = scale(perPlatform('draftsPerPlatformPerProjectMax'));
  const draftOrgCap = scale(perPlatform('draftsPerPlatformMax'));

  // ── 1. Live DRAFT rows, the thing the draft cap actually counts ───────────
  const draftRows = await prisma.post.groupBy({
    by: ['organizationId', 'projectId'],
    where: { state: 'DRAFT', deletedAt: null, parentPostId: null },
    _count: { _all: true },
  });
  const byOrgDrafts = new Map<string, number>();
  for (const r of draftRows) {
    byOrgDrafts.set(
      r.organizationId,
      (byOrgDrafts.get(r.organizationId) ?? 0) + r._count._all
    );
  }
  const projectDrafts = draftRows.filter((r) => r.projectId).map((r) => r._count._all);
  const orgDrafts = [...byOrgDrafts.values()];

  out.drafts = {
    caps: {
      perProject: draftProjectCap,
      perOrg: draftOrgCap,
      platformCount,
      source: growth.draftsPerPlatformPerProjectMax === undefined
        ? 'code defaults (post_plan_limits has no drafts* fields stored yet)'
        : 'post_plan_limits',
    },
    perProject: describe(projectDrafts),
    perOrg: describe(orgDrafts),
    verdictProject: headroom(draftProjectCap, describe(projectDrafts).max),
    verdictOrg: headroom(draftOrgCap, describe(orgDrafts).max),
  };

  // ── 2. Posts created per org per DAY — what the send path sustains ────────
  const posts = await prisma.$queryRaw<{ org: string; day: Date; n: bigint }[]>`
    SELECT "organizationId" AS org, date_trunc('day', "createdAt") AS day, COUNT(*) AS n
    FROM "Post"
    WHERE "createdAt" >= ${since} AND "deletedAt" IS NULL AND "parentPostId" IS NULL
    GROUP BY 1, 2`;
  const postsPerOrgDay = posts.map((r) => Number(r.n));
  // createPost is capped per HOUR; a daily peak is a lower bound on the hourly
  // one, so a daily max already near the hourly cap is the alarming case.
  out.postsCreated = {
    capPerHour: rateLimits?.createPost ?? 300,
    perOrgPerDay: describe(postsPerOrgDay),
    verdict: headroom(rateLimits?.createPost ?? 300, describe(postsPerOrgDay).max),
    note: 'daily counts vs an HOURLY cap — a daily max under the cap is safe by construction',
  };

  // ── 3. Engage opportunities persisted per org per HOUR — ingest proxy ─────
  // Accepted rows, not submitted ones: the quota counts submissions, and the
  // TTL/score/keyword gates drop a large share before persistence. So this is a
  // LOWER bound on ingest volume, and the real headroom is smaller than it looks.
  const ingest = await prisma.$queryRaw<{ org: string; hour: Date; n: bigint }[]>`
    SELECT "organizationId" AS org, date_trunc('hour', "createdAt") AS hour, COUNT(*) AS n
    FROM "EngageOpportunityState"
    WHERE "createdAt" >= ${since}
    GROUP BY 1, 2`;
  const ingestPerOrgHour = ingest.map((r) => Number(r.n));
  const ingestCap =
    ingestQuota?.recordsPerHour == null ? null : Number(ingestQuota.recordsPerHour);
  out.engageIngest = {
    capPerHour: ingestCap ?? 'computed from the formula (recordsPerHour: null)',
    perOrgPerHour: describe(ingestPerOrgHour),
    busiestOrgDay: describe(
      Object.values(
        ingest.reduce<Record<string, number>>((acc, r) => {
          const k = `${r.org}:${r.hour.toISOString().slice(0, 10)}`;
          acc[k] = (acc[k] ?? 0) + Number(r.n);
          return acc;
        }, {})
      )
    ),
    note: 'PERSISTED rows only — the quota counts SUBMITTED ones, so true usage is higher and the real headroom smaller',
  };

  // ── 4. Reply drafts per org per period — the credit-metered path ──────────
  const replies = await prisma.$queryRaw<{ org: string; day: Date; n: bigint }[]>`
    SELECT "organizationId" AS org, date_trunc('day', "createdAt") AS day, COUNT(*) AS n
    FROM "BillingRecord"
    WHERE "createdAt" >= ${since} AND "businessType" = 'engage_reply'
    GROUP BY 1, 2`;
  out.engageReplies = {
    capPerHour: rateLimits?.engageDraft ?? 20,
    perOrgPerDay: describe(replies.map((r) => Number(r.n))),
    verdict: headroom(rateLimits?.engageDraft ?? 20, describe(replies.map((r) => Number(r.n))).max),
    note: 'daily counts vs an HOURLY cap, same caveat as posts',
  };

  if (asJson) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log(`\n=== Write-path limits vs ${days} days of real usage ===\n`);
  console.log(`Platform allowlist: ${platformCount} platforms\n`);
  for (const [section, body] of Object.entries(out)) {
    if (typeof body !== 'object' || body === null) continue;
    console.log(`── ${section} ──`);
    console.log(JSON.stringify(body, null, 2));
    console.log('');
  }
  console.log(
    'Read the verdicts, not the counts: a cap thousands of times above the busiest\n' +
      'real account bounds nothing in practice, and one under ~2x will trip on a busy week.\n'
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
