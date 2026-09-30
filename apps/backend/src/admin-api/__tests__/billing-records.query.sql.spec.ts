import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  BILLING_AMOUNT,
  BILLING_TOKEN_SPLIT_PRESENT,
  billingTokenSum,
  buildBillingOrderBy,
  buildBillingWhere,
  buildSceneGrouping,
  normalizeBillingQuery,
} from '../billing-records.query';
import { AdminBillingRecordsQueryDto } from '@gitroom/nestjs-libraries/dtos/admin/admin-billing-records-query.dto';
import {
  AiseeCostItem,
  deriveTokenColumns,
} from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/aisee.client';
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
    // The primary token path once the backfill has run: plain SUMs over the
    // denormalised columns, no cast, no JSON expansion.
    'stats: token columns': Prisma.sql`
      SELECT ${select},
             COALESCE(SUM("totalTokens"), 0)::text AS "totalTokens",
             COALESCE(SUM("promptTokens"), 0)::text AS "promptTokens",
             COALESCE(SUM("completionTokens"), 0)::text AS "completionTokens",
             COALESCE(SUM("cachedPromptTokens"), 0)::text AS "cachedTokens",
             COUNT(*) FILTER (WHERE "promptTokens" IS NOT NULL)::int AS "chargesWithSplit",
             COUNT(*) FILTER (WHERE "totalTokens" IS NOT NULL)::int AS "chargesWithTokenData",
             COUNT(*) FILTER (WHERE "totalTokens" IS NULL)::int AS "chargesNeedingFallback"
      FROM "BillingRecord"
      WHERE ${where}
      GROUP BY ${groupBy}
    `,
    // Isolated on purpose — see statsTokens(). It is the only statement here
    // that casts costItems, and PostgreSQL 15 cannot guard that cast. Issued only
    // for rows the backfill has not reached.
    'stats: tokens': Prisma.sql`
      SELECT ${select},
             COALESCE(SUM(${billingTokenSum('quantity')}), 0)::text AS "totalTokens",
             COALESCE(SUM(${billingTokenSum('prompt_tokens')}), 0)::text AS "promptTokens",
             COALESCE(SUM(${billingTokenSum(
               'completion_tokens'
             )}), 0)::text AS "completionTokens",
             COALESCE(SUM(${billingTokenSum(
               'cached_prompt_tokens'
             )}), 0)::text AS "cachedTokens",
             COUNT(*) FILTER (
               WHERE ${BILLING_TOKEN_SPLIT_PRESENT}
             )::int AS "chargesWithSplit",
             COUNT(*)::int AS "chargesWithTokenData"
      FROM "BillingRecord"
      WHERE ${where} AND "totalTokens" IS NULL
      GROUP BY ${groupBy}
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
    /**
     * The denormalised token columns are declared in schema.prisma, so they exist
     * only once `pnpm run prisma-db-push` has run. Until then the statements that
     * reference them cannot be planned — which is a correct failure, not a broken
     * test, so those cases skip and say so.
     */
    let hasTokenColumns = false;

    beforeAll(async () => {
      prisma = new PrismaClient();
      const [row] = await prisma.$queryRawUnsafe<{ present: number }[]>(
        `SELECT COUNT(*)::int AS present
         FROM information_schema.columns
         WHERE table_name = 'BillingRecord'
           AND column_name IN ('totalTokens', 'promptTokens',
                               'completionTokens', 'cachedPromptTokens')`
      );
      hasTokenColumns = row.present === 4;
      if (!hasTokenColumns) {
        console.warn(
          `[billing-records.query.sql] BillingRecord has ${row.present}/4 token ` +
            `columns — run \`pnpm run prisma-db-push\` to add them, then ` +
            `backfill-billing-record-token-columns.sql. The statements that read ` +
            `them are SKIPPED until then.`
        );
      }
    });

    afterAll(async () => {
      await prisma?.$disconnect();
    });

    // Pins the server capabilities this compiler's SQL depends on. A compose file
    // pinning postgres:16 says nothing about the database the app actually
    // connects to — prod's is external — so the version is asserted here, where
    // it is read from the live connection.
    it('runs on a server version whose features this SQL stays within', async () => {
      const [row] = await prisma.$queryRawUnsafe<
        { version: string; database: string }[]
      >(`SELECT current_setting('server_version') AS version,
                current_database() AS database`);

      const major = Number(row.version.split('.')[0]);
      console.info(
        `[billing-records.query.sql] PostgreSQL ${row.version} on database "${row.database}"`
      );

      // Anything the compiler emits must parse here. `IS JSON` (PostgreSQL 16+)
      // is the feature this file exists to keep us honest about: it is NOT
      // available below 16, and using it would make /stats a syntax error.
      const supportsIsJson = major >= 16;
      const probe = await prisma
        .$queryRawUnsafe(`SELECT ('[]'::text IS JSON ARRAY) AS ok`)
        .then(() => true)
        .catch(() => false);

      expect(probe).toBe(supportsIsJson);
      expect(major).toBeGreaterThanOrEqual(12);
    });

    // EXPLAIN, not EXPLAIN ANALYZE: it runs parse-analysis and planning and
    // executes nothing. Parse-analysis is precisely the stage the GROUP BY bug
    // failed at, so this is the cheapest possible check that catches it.
    describe.each(['no filters', 'every filter'])('%s', (variant) => {
      const dto = variant === 'no filters' ? query() : EVERY_FILTER;

      // A plain loop, not it.each: it.each spreads the case values as arguments
      // and never passes the TestContext, so ctx.skip() would be unavailable.
      for (const name of Object.keys(statements(dto))) {
        it(`PostgreSQL accepts and plans the ${name} statement`, async (ctx) => {
          // Both token statements reference the denormalised columns.
          if (name.startsWith('stats: token') && !hasTokenColumns) {
            ctx.skip();
            return;
          }
          const statement = statements(dto)[name];
          await expect(
            prisma.$queryRawUnsafe(
              `EXPLAIN ${statement.text}`,
              ...statement.values
            )
          ).resolves.toBeDefined();
        });
      }
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

    // The EXPLAIN cases above prove the server accepts these statements; these
    // prove the token expression MEANS what the page claims, over the exact
    // costItems shapes the ledger actually holds.
    describe('token sums over a literal costItems value', () => {
      const tokensOf = async (costItems: unknown) => {
        const statement = Prisma.sql`
          SELECT ${billingTokenSum('quantity')}::text          AS total,
                 ${billingTokenSum('prompt_tokens')}::text     AS prompt,
                 ${billingTokenSum('completion_tokens')}::text AS completion,
                 ${BILLING_TOKEN_SPLIT_PRESENT}                AS "hasSplit"
          FROM (SELECT CAST(${JSON.stringify(costItems)} AS text) AS "costItems") AS t
        `;
        const [row] = await prisma.$queryRawUnsafe<
          { total: string; prompt: string; completion: string; hasSplit: boolean }[]
        >(statement.text, ...statement.values);
        return {
          total: Number(row.total),
          prompt: Number(row.prompt),
          completion: Number(row.completion),
          hasSplit: row.hasSplit,
        };
      };

      it('sums the split when a row carries one', async () => {
        expect(
          await tokensOf([
            { type: 'text', amount: '0.1', model: 'gpt-4.1', billing_mode: 'per_token', quantity: 1500, prompt_tokens: 1200, completion_tokens: 300 },
            { type: 'text', amount: '0.2', model: 'gpt-4.1-mini', billing_mode: 'per_token', quantity: 500, prompt_tokens: 400, completion_tokens: 100 },
          ])
        ).toEqual({ total: 2000, prompt: 1600, completion: 400, hasSplit: true });
      });

      // The whole point of making the split optional: a row written before it was
      // persisted must report its TOTAL and contribute nothing to the split —
      // never a zero that would read as "this call had no input tokens".
      it('reports total only for a historical row with no split', async () => {
        expect(
          await tokensOf([
            { type: 'text', amount: '0.1', model: 'gpt-4.1', billing_mode: 'per_token', quantity: 1500 },
          ])
        ).toEqual({ total: 1500, prompt: 0, completion: 0, hasSplit: false });
      });

      // THE regression case. The fallback used to sum the split per FIELD, so this
      // reported prompt 700 / completion 200 against a total of 1400 — the exact
      // shape aisee-token-columns.spec.ts calls "precise-looking and wrong", while
      // deriveTokenColumns, the backfill and summariseTokens all return null for it.
      // Two per_token items with different models stay two items through
      // mergeCostItems, so an accrual window spanning the change produces this.
      it('reports total only when ONE of several items lacks the split', async () => {
        expect(
          await tokensOf([
            { type: 'text', amount: '0.1', model: 'gpt-4.1', billing_mode: 'per_token', quantity: 900, prompt_tokens: 700, completion_tokens: 200 },
            { type: 'text', amount: '0.05', model: 'gpt-4.1-mini', billing_mode: 'per_token', quantity: 500 },
          ])
        ).toEqual({ total: 1400, prompt: 0, completion: 0, hasSplit: false });
      });

      // Half a split is not a split — the pair is what makes it one.
      it('treats an item with only completion_tokens as unsplit', async () => {
        expect(
          await tokensOf([
            { type: 'text', amount: '0.1', model: 'gpt-4.1', billing_mode: 'per_token', quantity: 900, completion_tokens: 200 },
          ])
        ).toEqual({ total: 900, prompt: 0, completion: 0, hasSplit: false });
      });

      // quantity is an IMAGE COUNT there, so counting it as tokens would inflate
      // the figure by a number that is not even the same unit.
      it('ignores per_image items', async () => {
        expect(
          await tokensOf([
            { type: 'image', amount: '4', model: 'dall-e-3', billing_mode: 'per_image', quantity: 2 },
          ])
        ).toEqual({ total: 0, prompt: 0, completion: 0, hasSplit: false });
      });

      // post_overage / engage_reply / post_analytics write a synthetic per_token
      // item with quantity 0 — no tokens, and no split to find.
      it('reads a flat-rate charge as zero tokens', async () => {
        expect(
          await tokensOf([
            { type: 'text', amount: '25.000000', model: 'post_send', billing_mode: 'per_token', quantity: 0 },
          ])
        ).toEqual({ total: 0, prompt: 0, completion: 0, hasSplit: false });
      });

      it('sums a mixed row without letting the image count leak in', async () => {
        expect(
          await tokensOf([
            { type: 'text', amount: '0.1', model: 'gpt-4.1', billing_mode: 'per_token', quantity: 900, prompt_tokens: 700, completion_tokens: 200 },
            { type: 'image', amount: '4', model: 'dall-e-3', billing_mode: 'per_image', quantity: 3 },
          ])
        ).toEqual({ total: 900, prompt: 700, completion: 200, hasSplit: true });
      });

      // Pins the reason statsTokens() is a separate, try/caught statement: on
      // PostgreSQL 15 there is no predicate that makes this cast safe, so one
      // corrupt row DOES fail the query. Isolating it is what keeps the credit
      // figures — which need no cast — rendering anyway.
      it('RAISES on an unparseable costItems, which is why it is isolated', async () => {
        const statement = Prisma.sql`
          SELECT ${billingTokenSum('quantity')}::text AS total
          FROM (SELECT CAST('{not json' AS text) AS "costItems") AS t
        `;

        await expect(
          prisma.$queryRawUnsafe(statement.text, ...statement.values)
        ).rejects.toThrow();
      });

      // Valid JSON, wrong shape: jsonb_array_elements rejects a non-array, so
      // this raises too and is covered by the same isolation.
      it('RAISES on a JSON object rather than an array', async () => {
        const statement = Prisma.sql`
          SELECT ${billingTokenSum('quantity')}::text AS total
          FROM (SELECT CAST('{"quantity":999}' AS text) AS "costItems") AS t
        `;

        await expect(
          prisma.$queryRawUnsafe(statement.text, ...statement.values)
        ).rejects.toThrow();
      });
    });

    /**
     * The backfill derives the token columns in SQL; every write path derives them
     * in TypeScript via deriveTokenColumns(). If the two disagree, a backfilled row
     * and a freshly written one report different numbers for the same costItems —
     * a discrepancy nothing else in the suite could catch, because each side is
     * individually self-consistent.
     */
    describe('backfill SQL agrees with deriveTokenColumns()', () => {
      // Verbatim from backfill-billing-record-token-columns.sql.
      const backfilled = async (costItems: AiseeCostItem[]) => {
        const statement = Prisma.sql`
          SELECT t.total::int AS "totalTokens",
                 CASE WHEN t.items > 0 AND t.with_split = t.items
                      THEN t.prompt::int END AS "promptTokens",
                 CASE WHEN t.items > 0 AND t.with_split = t.items
                      THEN t.completion::int END AS "completionTokens",
                 CASE WHEN t.items > 0 AND t.with_split = t.items
                      THEN t.cached::int END AS "cachedPromptTokens"
          FROM (
            SELECT
              COUNT(*) AS items,
              COUNT(*) FILTER (
                WHERE jsonb_typeof(item->'prompt_tokens') = 'number'
                  AND jsonb_typeof(item->'completion_tokens') = 'number'
              ) AS with_split,
              COALESCE(SUM(CASE WHEN jsonb_typeof(item->'quantity') = 'number'
                                THEN (item->>'quantity')::numeric ELSE 0 END), 0) AS total,
              COALESCE(SUM(CASE WHEN jsonb_typeof(item->'prompt_tokens') = 'number'
                                THEN (item->>'prompt_tokens')::numeric ELSE 0 END), 0) AS prompt,
              COALESCE(SUM(CASE WHEN jsonb_typeof(item->'completion_tokens') = 'number'
                                THEN (item->>'completion_tokens')::numeric ELSE 0 END), 0) AS completion,
              COALESCE(SUM(CASE WHEN jsonb_typeof(item->'cached_prompt_tokens') = 'number'
                                THEN (item->>'cached_prompt_tokens')::numeric ELSE 0 END), 0) AS cached
            FROM jsonb_array_elements(CAST(${JSON.stringify(
              costItems
            )} AS jsonb)) AS item
            WHERE item->>'billing_mode' = 'per_token'
          ) t
        `;
        const [row] = await prisma.$queryRawUnsafe<Record<string, any>[]>(
          statement.text,
          ...statement.values
        );
        return row;
      };

      const item = (over: Partial<AiseeCostItem> = {}): AiseeCostItem => ({
        type: 'text',
        amount: '0.100000',
        model: 'gpt-4.1',
        billing_mode: 'per_token',
        quantity: 1000,
        ...over,
      });

      const CASES: [string, AiseeCostItem[]][] = [
        ['every item split', [
          item({ quantity: 1500, prompt_tokens: 1200, completion_tokens: 300 }),
          item({ quantity: 500, prompt_tokens: 400, completion_tokens: 100 }),
        ]],
        ['a cached prompt', [
          item({ quantity: 1500, prompt_tokens: 1200, completion_tokens: 300, cached_prompt_tokens: 900 }),
        ]],
        // The accrual window that spans the change — the case the null rule exists for.
        ['one item missing the split', [
          item({ quantity: 900, prompt_tokens: 700, completion_tokens: 200 }),
          item({ quantity: 500 }),
        ]],
        ['no split at all (historical row)', [item({ quantity: 1500 })]],
        ['per_image only', [
          item({ type: 'image', model: 'dall-e-3', billing_mode: 'per_image', quantity: 3 }),
        ]],
        ['a flat-rate charge', [
          item({ model: 'post_send', quantity: 0, amount: '25.000000' }),
        ]],
        ['mixed per_token and per_image', [
          item({ quantity: 900, prompt_tokens: 700, completion_tokens: 200 }),
          item({ type: 'image', model: 'dall-e-3', billing_mode: 'per_image', quantity: 3 }),
        ]],
        ['half a split (completion only)', [
          item({ quantity: 900, completion_tokens: 200 }),
        ]],
        ['an empty breakdown', []],
      ];

      it.each(CASES)('agrees on %s', async (_label, costItems) => {
        const expected = deriveTokenColumns(costItems);
        const actual = await backfilled(costItems);

        expect({
          totalTokens: actual.totalTokens,
          promptTokens: actual.promptTokens,
          completionTokens: actual.completionTokens,
          cachedPromptTokens: actual.cachedPromptTokens,
        }).toEqual(expected);
      });
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
    expect(Object.keys(statements(EVERY_FILTER))).toEqual([
      'records: totals',
      'records: id page',
      'stats',
      'stats: token columns',
      'stats: tokens',
    ]);
  });
});
