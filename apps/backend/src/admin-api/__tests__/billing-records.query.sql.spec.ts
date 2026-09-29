import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  BILLING_AMOUNT,
  buildBillingOrderBy,
  buildBillingWhere,
  buildSceneGrouping,
  normalizeBillingQuery,
} from '../billing-records.query';
import { AdminBillingRecordsQueryDto } from '@gitroom/nestjs-libraries/dtos/admin/admin-billing-records-query.dto';
import {
  BILLING_SCENES,
  BILLING_SCENE_OTHER,
  resolveBillingSceneId,
} from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/billing-scene';

/**
 * The only tests in this change that a mocked `$queryRaw` cannot fake.
 *
 * Why they exist: the compiler used to bind each `data` key twice, so the same
 * jsonb expression carried a different `$n` in the SELECT list than in GROUP BY.
 * Postgres matches a grouping item to a select-list expression with `equal()`
 * over the parse tree, and two Param nodes with different paramids are never
 * equal, so `/stats` was rejected at parse-analyze on every single call — while
 * every assertion about the compiled SQL text and its parameters stayed green.
 * Only the database can answer "does this statement actually run".
 *
 * STRICTLY READ-ONLY, and deliberately so — this repo forbids tests that mutate
 * a database:
 *   • `EXPLAIN` (never `EXPLAIN ANALYZE`) parses and plans a statement and
 *     executes nothing, so it proves parse-analysis on the real table without
 *     reading a row.
 *   • the parity and amount checks evaluate expressions against literal
 *     subselects and never reference a table at all.
 * No INSERT, UPDATE, DELETE, DDL or transaction anywhere.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const query = (over: Partial<AdminBillingRecordsQueryDto> = {}) =>
  ({
    sortBy: 'createdAt',
    sortOrder: 'desc',
    page: 1,
    pageSize: 50,
    ...over,
  } as AdminBillingRecordsQueryDto);

/** The widest filter the admin UI can produce, so every fragment is exercised. */
const EVERY_FILTER = query({
  scene: ['engage_reply', 'copilot_editor', BILLING_SCENE_OTHER],
  status: ['failed', 'unbilled'],
  businessType: ['ai_copywriting'],
  subType: ['chat'],
  source: 'engage',
  surface: 'copilot_chat',
  platform: 'reddit',
  projectId: 'proj-1',
  model: 'gpt-4.1',
  relatedId: 'rel-1',
  taskId: 'postiz_',
  transactionId: 'txn-1',
  search: '50%_off',
  dateFrom: '2026-09-01',
  dateTo: '2026-09-30T23:59:59.000Z',
  minAmount: '0.5',
  maxAmount: '250',
});

/** Exactly the statements admin-billing.controller.ts issues. */
function statements(dto: AdminBillingRecordsQueryDto): Record<string, Prisma.Sql> {
  const normalized = normalizeBillingQuery(dto, undefined);
  const where = buildBillingWhere(normalized);
  const { select, groupBy } = buildSceneGrouping();

  return {
    'records: totals': Prisma.sql`
      SELECT COUNT(*)::int AS "count",
             COALESCE(SUM(${BILLING_AMOUNT}), 0)::text AS "amount"
      FROM "BillingRecord"
      WHERE ${where}
    `,
    'records: id page': Prisma.sql`
      SELECT "id"
      FROM "BillingRecord"
      WHERE ${where}
      ORDER BY ${buildBillingOrderBy(normalized)}
      LIMIT ${normalized.pageSize} OFFSET ${0}
    `,
    stats: Prisma.sql`
      SELECT ${select},
             "status",
             COUNT(*)::int AS "count",
             COALESCE(SUM(${BILLING_AMOUNT}), 0)::text AS "totalAmount",
             MIN(${BILLING_AMOUNT})::text AS "minAmount",
             MAX(${BILLING_AMOUNT})::text AS "maxAmount",
             MAX("createdAt") AS "lastAt"
      FROM "BillingRecord"
      WHERE ${where}
      GROUP BY ${groupBy}, "status"
    `,
  };
}

/** One fixture row per scene, plus the legacy shapes that land in `other`. */
const FIXTURE_ROWS: {
  label: string;
  businessType: string;
  subType: string | null;
  data: Record<string, unknown> | null;
}[] = [
  { label: 'editor copilot', businessType: 'ai_copywriting', subType: 'chat', data: { surface: 'copilot_chat' } },
  { label: 'agent chat', businessType: 'ai_copywriting', subType: 'chat', data: { surface: 'agent_chat' } },
  { label: 'agent chat (legacy, no surface)', businessType: 'ai_copywriting', subType: 'chat', data: {} },
  { label: 'agent chat (legacy, null data)', businessType: 'ai_copywriting', subType: 'chat', data: null },
  { label: 'post generation', businessType: 'ai_copywriting', subType: 'post_gen', data: { source: 'calendar' } },
  { label: 'reference post', businessType: 'ai_copywriting', subType: 'post_gen_reference', data: { platform: 'x' } },
  { label: 'image (calendar)', businessType: 'image_gen', subType: 'image', data: { source: 'calendar' } },
  { label: 'image (chat)', businessType: 'image_gen', subType: 'image', data: { source: 'chat' } },
  { label: 'image (legacy, no source)', businessType: 'image_gen', subType: 'image', data: {} },
  { label: 'engage reply', businessType: 'engage_reply', subType: null, data: { length: 'short' } },
  { label: 'overage (engage)', businessType: 'post_overage', subType: null, data: { source: 'engage' } },
  { label: 'overage (calendar)', businessType: 'post_overage', subType: null, data: { source: 'calendar' } },
  { label: 'overage (legacy, null data)', businessType: 'post_overage', subType: null, data: null },
  { label: 'analytics', businessType: 'post_analytics', subType: null, data: { platform: 'reddit' } },
  { label: 'operation plan', businessType: 'operation_plan', subType: null, data: { projectId: 'p1' } },
  // The genuinely ambiguous legacy row: ai_copywriting predating the subType
  // column. It must land in `other` on BOTH sides, not be guessed either way.
  { label: 'legacy, no subType', businessType: 'ai_copywriting', subType: null, data: null },
  { label: 'unknown business type', businessType: 'brand_new_business', subType: null, data: {} },
];

describe.skipIf(!DATABASE_URL)(
  'billing-records.query against a real PostgreSQL (read-only)',
  () => {
    let prisma: PrismaClient;

    beforeAll(async () => {
      prisma = new PrismaClient();
    });

    afterAll(async () => {
      await prisma?.$disconnect();
    });

    // EXPLAIN, not EXPLAIN ANALYZE: it runs parse-analysis and planning and
    // executes nothing. Parse-analysis is precisely the stage the GROUP BY bug
    // failed at, so this is the cheapest possible check that catches it.
    describe.each(['no filters', 'every filter'])('%s', (variant) => {
      const dto = variant === 'no filters' ? query() : EVERY_FILTER;

      it.each(Object.keys(statements(dto)))(
        'PostgreSQL accepts and plans the %s statement',
        async (name) => {
          const statement = statements(dto)[name];
          await expect(
            prisma.$queryRawUnsafe(
              `EXPLAIN ${statement.text}`,
              ...statement.values
            )
          ).resolves.toBeDefined();
        }
      );
    });

    // Pins the REASON dataText inlines the key instead of binding it. Without
    // this, a future edit could switch back to a bound key and every
    // text-and-parameters assertion would still pass while /stats 500s.
    it('rejects a BOUND grouping key, which is why the key is a literal', async () => {
      // The exact shape the compiler used to emit: one expression, a different
      // bind parameter in the SELECT list than in GROUP BY.
      const bound = Prisma.sql`
        SELECT "data"->>CAST(${'source'} AS text) AS "data_source",
               COUNT(*)::int AS "count"
        FROM "BillingRecord"
        GROUP BY "data"->>CAST(${'source'} AS text)
      `;

      await expect(
        prisma.$queryRawUnsafe(`EXPLAIN ${bound.text}`, ...bound.values)
      ).rejects.toThrow(/must appear in the GROUP BY clause/i);
    });

    // The rule is implemented twice — as SQL (what `?scene=` filters on) and as
    // TypeScript (what labels every row) — so a row could be labelled one scene
    // and excluded by the filter for that same scene, with no error anywhere.
    it('classifies every fixture row identically in SQL and in TypeScript', async () => {
      const sceneIds = [...BILLING_SCENES.map((s) => s.id), BILLING_SCENE_OTHER];
      const mismatches: string[] = [];

      for (const row of FIXTURE_ROWS) {
        const expected = resolveBillingSceneId(row);

        for (const sceneId of sceneIds) {
          const where = buildBillingWhere(
            normalizeBillingQuery(query({ scene: [sceneId] }), undefined)
          );
          // A literal subselect: the predicate names only the three columns it
          // reads, so this never touches BillingRecord.
          const statement = Prisma.sql`
            SELECT (${where}) AS matched
            FROM (
              SELECT CAST(${row.businessType} AS text)       AS "businessType",
                     CAST(${row.subType} AS text)            AS "subType",
                     CAST(${JSON.stringify(row.data)} AS jsonb) AS "data"
            ) AS t
          `;
          const [result] = await prisma.$queryRawUnsafe<{ matched: boolean }[]>(
            statement.text,
            ...statement.values
          );

          if (result.matched !== (expected === sceneId)) {
            mismatches.push(
              `${row.label}: SQL says scene=${sceneId} ${
                result.matched ? 'MATCHES' : 'does not match'
              }, TS resolved it to ${expected}`
            );
          }
        }
      }

      expect(mismatches).toEqual([]);
    });

    // A decimal-string column read as a number. The CASE guard exists so one
    // malformed row cannot error a SUM over the whole filtered set.
    it.each([
      ['0.250000', '0.250000'],
      ['1', '1'],
      ['-0.5', '-0.5'],
      ['250', '250'],
      // Guarded shapes: scored 0 rather than raising.
      ['n/a', '0'],
      ['', '0'],
      ['.5', '0'],
      ['1e3', '0'],
      [' 1 ', '0'],
    ])('reads amount %j as %s', async (stored, expected) => {
      const statement = Prisma.sql`
        SELECT ${BILLING_AMOUNT}::text AS amount
        FROM (SELECT CAST(${stored} AS text) AS "amount") AS t
      `;
      const [row] = await prisma.$queryRawUnsafe<{ amount: string }[]>(
        statement.text,
        ...statement.values
      );

      expect(Number(row.amount)).toBe(Number(expected));
    });
  }
);

// Guard the skip itself: a spec that silently stops running leaves the claim
// "the SQL executes" unverified while the suite still reports green — which is
// exactly the failure mode this file was added to close.
describe('billing SQL spec preconditions', () => {
  it('reports whether the real-database assertions actually ran', () => {
    if (!DATABASE_URL) {
      console.warn(
        '[billing-records.query.sql] DATABASE_URL unset — the PostgreSQL ' +
          'accept/plan and SQL↔TS parity assertions did NOT run. The compiled ' +
          'SQL is unverified against a real engine.'
      );
    }
    // The statements must at least still compile, with or without a database.
    expect(Object.keys(statements(EVERY_FILTER))).toHaveLength(3);
  });
});
