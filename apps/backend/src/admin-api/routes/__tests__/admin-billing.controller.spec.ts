import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { AdminBillingController } from '../admin-billing.controller';
import { AdminBillingRecordsQueryDto } from '@gitroom/nestjs-libraries/dtos/admin/admin-billing-records-query.dto';
import {
  AiseeBusinessSubType,
  AiseeBusinessType,
} from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/aisee.client';
import { BILLING_SCENES } from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/billing-scene';

// The list endpoint's filter lives in SQL because `amount` is a decimal string
// column (Prisma can neither sum nor numerically order it). These tests read the
// statement the controller actually built — the compiled text plus its bound
// parameters — which is the only place a filter bug shows up before production.

type RawResult = Record<string, any>[];

const query = (over: Partial<AdminBillingRecordsQueryDto> = {}) =>
  ({
    sortBy: 'createdAt',
    sortOrder: 'desc',
    page: 1,
    pageSize: 50,
    ...over,
  } as AdminBillingRecordsQueryDto);

const record = (over: Record<string, any> = {}) => ({
  id: 'rec-1',
  organizationId: 'org-1',
  transactionId: 'txn-1',
  taskId: 'postiz_agent_org-1_1',
  amount: '0.250000',
  businessType: AiseeBusinessType.AI_COPYWRITING,
  subType: AiseeBusinessSubType.CHAT,
  description: 'Agent chat conversation',
  costItems: '[{"model":"gpt-4.1","amount":"0.25"}]',
  relatedId: 'thread-1',
  data: { surface: 'agent_chat' },
  status: 'success',
  remainingBalance: '10',
  debtAmount: null as string | null,
  error: null as string | null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  organization: { users: [{ userId: 'user-1' }] },
  ...over,
});

function makeController(options: {
  totals?: { count: number; amount: string };
  ids?: { id: string }[];
  statsRows?: RawResult;
  rows?: Record<string, any>[];
  orgsByUser?: { id: string }[];
} = {}) {
  const statements: Prisma.Sql[] = [];

  const $queryRaw = vi.fn((strings: any, ...values: any[]) => {
    const statement = Prisma.sql(strings, ...values);
    statements.push(statement);

    if (statement.sql.includes('GROUP BY')) {
      return Promise.resolve(options.statsRows ?? []);
    }
    if (statement.sql.includes('COUNT(*)')) {
      return Promise.resolve([
        options.totals ?? { count: options.ids?.length ?? 0, amount: '0' },
      ]);
    }
    return Promise.resolve(options.ids ?? []);
  });

  const findMany = vi.fn().mockResolvedValue(options.rows ?? []);

  const controller = new AdminBillingController(
    { model: { $queryRaw, billingRecord: { findMany } } } as any,
    {} as any,
    {} as any,
    {
      getOrgsByUserId: vi.fn().mockResolvedValue(options.orgsByUser ?? []),
    } as any
  );

  const find = (fragment: string) =>
    statements.find((statement) => statement.sql.includes(fragment));

  return { controller, statements, $queryRaw, findMany, find };
}

describe('AdminBillingController.listRecords', () => {
  it('compiles the business filter into ONE parameterised statement', async () => {
    const { controller, find } = makeController();

    await controller.listRecords(
      query({
        scene: ['engage_reply'],
        status: ['failed', 'unbilled'],
        minAmount: '0.5',
        model: 'gpt-4.1',
        source: 'engage',
      })
    );

    const page = find('SELECT "id"')!;
    expect(page.sql).toContain('"businessType" = ?');
    expect(page.sql).toContain('"status" IN (?,?)');
    expect(page.sql).toContain('"costItems" ILIKE ?');
    expect(page.sql).toContain('CAST(? AS numeric)');
    expect(page.values).toEqual(
      expect.arrayContaining([
        AiseeBusinessType.ENGAGE_REPLY,
        'failed',
        'unbilled',
        '%gpt-4.1%',
        '0.5',
        'engage',
      ])
    );
  });

  // A scene is businessType + subType + `data` marker. Filtering on the coarse
  // businessType alone would lump the editor copilot in with the agent chat.
  it('narrows a scene by its `data` marker, not just its businessType', async () => {
    const { controller, find } = makeController();

    await controller.listRecords(query({ scene: ['copilot_editor'] }));

    const page = find('SELECT "id"')!;
    // The marker KEY is a SQL literal (see dataText — it has to be, so /stats can
    // group by the same expression); only its VALUE is bound.
    expect(page.sql).toContain(`"data"->>CAST('surface' AS text)`);
    expect(page.values).toEqual(
      expect.arrayContaining([
        AiseeBusinessType.AI_COPYWRITING,
        AiseeBusinessSubType.CHAT,
        'copilot_chat',
      ])
    );
  });

  // Offering `other` and having it match nothing would be worse than not
  // offering it: the bucket exists to surface uncategorised spend.
  it('turns the unclassified bucket into the negation of every scene', async () => {
    const { controller, find } = makeController();

    await controller.listRecords(query({ scene: ['other'] }));

    const page = find('SELECT "id"')!;
    expect(page.sql).toContain('NOT (');
    for (const scene of BILLING_SCENES) {
      expect(page.values).toContain(scene.businessType);
    }
    // `=` against a NULL subType yields NULL, and NULL inside this negation
    // would drop exactly the legacy rows the bucket is for.
    expect(page.sql).toContain('IS NOT DISTINCT FROM');
  });

  it('matches nothing, not everything, for an unknown scene id', async () => {
    const { controller, find } = makeController();

    await controller.listRecords(query({ scene: ['no-such-scene'] }));

    expect(find('SELECT "id"')!.sql).toContain('FALSE');
  });

  it('orders by amount NUMERICALLY when asked to sort by amount', async () => {
    const { controller, find } = makeController();

    await controller.listRecords(query({ sortBy: 'amount', sortOrder: 'desc' }));

    // '9' sorts after '10' as text — the cast is the whole point.
    expect(find('SELECT "id"')!.sql).toMatch(
      /ORDER BY \(CASE WHEN "amount" ~ .+::numeric/
    );
  });

  it('keeps the order the sort produced when hydrating the page', async () => {
    const { controller, findMany } = makeController({
      ids: [{ id: 'c' }, { id: 'a' }, { id: 'b' }],
      // findMany returns rows in its own order, not the sorted one.
      rows: [record({ id: 'a' }), record({ id: 'b' }), record({ id: 'c' })],
      totals: { count: 3, amount: '0.75' },
    });

    const result = await controller.listRecords(query());

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['c', 'a', 'b'] } } })
    );
    expect(result.records.map((r: any) => r.id)).toEqual(['c', 'a', 'b']);
  });

  it('totals credits over the whole filtered set, not the page', async () => {
    const { controller } = makeController({
      ids: [{ id: 'rec-1' }],
      rows: [record()],
      totals: { count: 137, amount: '42.500000' },
    });

    const result = await controller.listRecords(query({ pageSize: 2 }));

    expect(result.totals).toEqual({ count: 137, amount: '42.500000' });
    expect(result.pagination).toEqual({
      page: 1,
      pageSize: 2,
      total: 137,
      totalPages: 69,
    });
  });

  it('labels every row with the business scene that produced it', async () => {
    const { controller } = makeController({
      ids: [{ id: 'rec-1' }, { id: 'rec-2' }],
      rows: [
        record({ id: 'rec-1', data: { surface: 'copilot_chat' } }),
        record({
          id: 'rec-2',
          businessType: AiseeBusinessType.POST_OVERAGE,
          subType: null,
          data: { source: 'engage' },
        }),
      ],
      totals: { count: 2, amount: '0.5' },
    });

    const result = await controller.listRecords(query());

    expect(result.records.map((r: any) => r.scene)).toEqual([
      'copilot_editor',
      'post_overage_engage',
    ]);
    expect(result.records[0].costItems).toEqual([
      { model: 'gpt-4.1', amount: '0.25' },
    ]);
    expect(result.records[0].userId).toBe('user-1');
  });

  it('bounds a date range as a cast timestamp, not a driver-encoded Date', async () => {
    const { controller, find } = makeController();

    await controller.listRecords(
      query({ dateFrom: '2026-09-01', dateTo: '2026-09-30T23:59:59.000Z' })
    );

    const page = find('SELECT "id"')!;
    // `timestamp`, not `timestamptz`: createdAt is TIMESTAMP(3) WITHOUT time
    // zone, so a timestamptz bound would be resolved through the session
    // TimeZone and be correct only on a UTC database.
    expect(page.sql).toContain('CAST(? AS timestamp)');
    expect(page.values).toEqual(
      expect.arrayContaining([
        '2026-09-01T00:00:00.000Z',
        '2026-09-30T23:59:59.000Z',
      ])
    );
  });

  it('ignores an unparseable date instead of filtering on garbage', async () => {
    const { controller, find } = makeController();

    await controller.listRecords(query({ dateFrom: 'last tuesday' }));

    expect(find('SELECT "id"')!.sql).not.toContain('AS timestamp');
  });

  it('treats % and _ in the search box as literals', async () => {
    const { controller, find } = makeController();

    await controller.listRecords(query({ search: '50%_off' }));

    expect(find('SELECT "id"')!.values).toContain('%50\\%\\_off%');
  });

  it('never sends a negative OFFSET, whatever the caller asked for', async () => {
    const { controller, find } = makeController();

    await controller.listRecords(query({ page: -3, pageSize: 5000 }));

    const page = find('SELECT "id"')!;
    // pageSize clamped to the 200 ceiling, page floored at 1 → OFFSET 0.
    expect(page.values.slice(-2)).toEqual([200, 0]);
  });

  it('filters the totals and the page with one identical WHERE', async () => {
    const { controller, find } = makeController();

    await controller.listRecords(
      query({ scene: ['engage_reply'], status: ['failed'], search: 'boom' })
    );

    // "totals over the whole filtered set" is the design's core claim, and it
    // only holds while both statements carry the same predicate.
    const whereOf = (sql: string) =>
      sql.slice(sql.indexOf('WHERE')).split('ORDER BY')[0].trim();
    const totals = find('COUNT(*)')!;
    const page = find('SELECT "id"')!;

    expect(whereOf(totals.sql)).toBe(whereOf(page.sql));
    expect(page.values.slice(0, totals.values.length)).toEqual(totals.values);
  });

  it('degrades an unparseable costItems row instead of failing the page', async () => {
    const { controller } = makeController({
      ids: [{ id: 'rec-1' }, { id: 'rec-2' }],
      rows: [
        record({ id: 'rec-1', costItems: '{not json' }),
        record({ id: 'rec-2' }),
      ],
      totals: { count: 2, amount: '0.5' },
    });

    // This view is what an operator opens BECAUSE the ledger looks wrong, and the
    // sort is deterministic, so a throwing row could not even be paged around.
    const result = await controller.listRecords(query());

    expect(result.records.map((r: any) => r.costItems)).toEqual([
      [],
      [{ model: 'gpt-4.1', amount: '0.25' }],
    ]);
  });

  it('short-circuits a userId that owns no organization', async () => {
    const { controller, $queryRaw } = makeController({ orgsByUser: [] });

    const result = await controller.listRecords(query({ userId: 'ghost' }));

    expect($queryRaw).not.toHaveBeenCalled();
    expect(result.records).toEqual([]);
    expect(result.totals).toEqual({ count: 0, amount: '0' });
  });

  it('scopes to every organization a userId owns', async () => {
    const { controller, find } = makeController({
      orgsByUser: [{ id: 'org-1' }, { id: 'org-2' }],
    });

    await controller.listRecords(query({ userId: 'user-1' }));

    const page = find('SELECT "id"')!;
    expect(page.sql).toContain('"organizationId" IN (?,?)');
    expect(page.values).toEqual(expect.arrayContaining(['org-1', 'org-2']));
  });
});

describe('AdminBillingController.stats', () => {
  const statsRow = (over: Record<string, any> = {}) => ({
    businessType: AiseeBusinessType.ENGAGE_REPLY,
    subType: null as string | null,
    data_source: null as string | null,
    data_surface: null as string | null,
    status: 'success',
    count: 2,
    totalAmount: '1.000000',
    minAmount: '0.400000',
    maxAmount: '0.600000',
    lastAt: new Date('2026-09-20T10:00:00.000Z'),
    ...over,
  });

  it('answers "how much does ONE charge of this business cost"', async () => {
    const { controller } = makeController({
      statsRows: [
        statsRow(),
        statsRow({
          status: 'failed',
          count: 1,
          totalAmount: '0.500000',
          minAmount: '0.500000',
          maxAmount: '0.500000',
          lastAt: new Date('2026-09-21T10:00:00.000Z'),
        }),
      ],
    });

    const result = await controller.stats(query());

    expect(result.scenes).toHaveLength(1);
    expect(result.scenes[0]).toMatchObject({
      scene: 'engage_reply',
      count: 3,
      totalAmount: '1.500000',
      avgAmount: '0.500000',
      minAmount: '0.400000',
      maxAmount: '0.600000',
      byStatus: { success: 2, failed: 1 },
    });
    expect(result.scenes[0].lastAt).toBe('2026-09-21T10:00:00.000Z');
    expect(result.total).toEqual({ count: 3, amount: '1.500000' });
  });

  // Same businessType, same subType — only the `data` marker differs. Grouping
  // on businessType alone would report one meaningless blended average.
  it('keeps the editor copilot and the agent chat apart', async () => {
    const { controller } = makeController({
      statsRows: [
        statsRow({
          businessType: AiseeBusinessType.AI_COPYWRITING,
          subType: AiseeBusinessSubType.CHAT,
          data_surface: 'copilot_chat',
          count: 10,
          totalAmount: '1.000000',
        }),
        statsRow({
          businessType: AiseeBusinessType.AI_COPYWRITING,
          subType: AiseeBusinessSubType.CHAT,
          data_surface: 'agent_chat',
          count: 1,
          totalAmount: '4.000000',
        }),
      ],
    });

    const result = await controller.stats(query());

    expect(
      result.scenes.map((scene) => [scene.scene, scene.avgAmount])
    ).toEqual([
      ['agent_chat', '4.000000'],
      ['copilot_editor', '0.100000'],
    ]);
  });

  // Regression: the grouping keys used to be BOUND, so the same expression got a
  // different `$n` in the SELECT list than in GROUP BY. Postgres matches a
  // grouping item to a select-list expression with equal() over the parse tree,
  // and two Param nodes with different paramids are never equal, so it fell back
  // to the bare `data` Var and rejected the statement outright — /stats 500'd on
  // every call. The previous assertion here used arrayContaining and was
  // satisfied precisely BY the duplicated parameters that caused it.
  it('renders each grouping expression identically in SELECT and in GROUP BY', async () => {
    const { controller, find } = makeController();

    await controller.stats(query());

    const grouped = find('GROUP BY')!;
    const [selectList, groupByList] = grouped.sql.split('GROUP BY');

    for (const key of ['source', 'surface']) {
      const expression = `"data"->>CAST('${key}' AS text)`;
      expect(selectList).toContain(`${expression} AS "data_${key}"`);
      expect(groupByList).toContain(expression);
      // A bound key is what broke it; the key must be a literal.
      expect(grouped.values).not.toContain(key);
    }
    expect(groupByList).toContain('"status"');
  });

  it('keeps two businessTypes apart inside the unclassified bucket', async () => {
    const { controller } = makeController({
      statsRows: [
        statsRow({
          businessType: AiseeBusinessType.AI_COPYWRITING,
          subType: null,
          count: 1,
          totalAmount: '1.000000',
        }),
        statsRow({
          businessType: AiseeBusinessType.IMAGE_GEN,
          subType: null,
          count: 1,
          totalAmount: '2.000000',
        }),
      ],
    });

    const result = await controller.stats(query());

    // Both resolve to `other` (no scene claims a NULL subType), but folding them
    // into one row would show a single arbitrary businessType and average two
    // unrelated businesses — destroying the only signal this bucket carries.
    expect(result.scenes.map((s) => [s.scene, s.businessType])).toEqual([
      ['other', AiseeBusinessType.IMAGE_GEN],
      ['other', AiseeBusinessType.AI_COPYWRITING],
    ]);
    expect(new Set(result.scenes.map((s) => s.id)).size).toBe(2);
  });

  it('applies the same filters as the list', async () => {
    const { controller, find } = makeController();

    await controller.stats(query({ scene: ['operation_plan'] }));

    expect(find('GROUP BY')!.values).toContain(
      AiseeBusinessType.OPERATION_PLAN
    );
  });
});

describe('AdminBillingController.meta', () => {
  it('publishes every scene plus the unclassified bucket', () => {
    const { controller } = makeController();

    const meta = controller.meta();

    expect(meta.scenes).toHaveLength(BILLING_SCENES.length + 1);
    expect(meta.scenes.at(-1)).toMatchObject({
      id: 'other',
      businessType: null,
    });
    for (const scene of meta.scenes) {
      expect(scene.label).toBeTruthy();
      expect(scene.description).toBeTruthy();
    }
  });

  it('publishes every status with whether it needs a human', () => {
    const { controller } = makeController();

    const meta = controller.meta();

    expect(meta.statuses.map((status) => status.id)).toEqual(
      expect.arrayContaining([
        'success',
        'pending',
        'failed',
        'unbilled',
        'accruing',
        'reserved',
        'released',
        'skipped',
        'internal',
      ])
    );
    expect(meta.sortFields).toEqual(['createdAt', 'amount']);
  });
});
