import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  Logger,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SuperAdmin } from '@gitroom/backend/services/auth/admin/super-admin.decorator';
import {
  PrismaRepository,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { AiseeCreditService } from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/aisee-credit.service';
import {
  AiseeBusinessSubType,
  AiseeBusinessType,
  AiseeClient,
} from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/aisee.client';
import {
  BILLING_SCENES,
  BILLING_SCENE_OTHER,
  BILLING_STATUSES,
  findBillingScene,
  resolveBillingSceneId,
} from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/billing-scene';
import {
  AdminBillingRecordsQueryDto,
  BILLING_SORT_FIELDS,
} from '@gitroom/nestjs-libraries/dtos/admin/admin-billing-records-query.dto';
import {
  BILLING_AMOUNT,
  BILLING_DATA_FILTER_KEYS,
  buildBillingOrderBy,
  buildBillingWhere,
  buildSceneGrouping,
  normalizeBillingQuery,
} from '@gitroom/backend/admin-api/billing-records.query';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { resolveOrganizationId } from '@gitroom/backend/admin-api/admin.utils';

/** Per-scene credit consumption (see GET /stats). Amounts are decimal strings. */
interface BillingSceneStats {
  /**
   * Row identity. Equals `scene` for a defined scene; for the unclassified
   * bucket it is `other:<businessType>`, because that bucket legitimately holds
   * several businessTypes and blending them would destroy the one diagnostic
   * signal it exists to give.
   */
  id: string;
  scene: string;
  label: string;
  businessType: string | null;
  count: number;
  totalAmount: string;
  /** Credits burned by ONE charge of this scene, on average. */
  avgAmount: string;
  minAmount: string;
  maxAmount: string;
  lastAt: string | null;
  byStatus: Record<string, number>;
}

/** One selectable business scene in the admin filter (see GET /meta). */
interface BillingSceneOption {
  id: string;
  label: string;
  description: string;
  businessType: string | null;
  subType: string | null;
}

@ApiTags('Admin')
@Controller('/admin/billing')
@SuperAdmin()
export class AdminBillingController {
  constructor(
    // $queryRaw: `amount` is a decimal string column, so credit totals and
    // numeric ordering cannot go through the Prisma query builder.
    private readonly _billingRecord: PrismaRepository<
      'billingRecord' | '$queryRaw'
    >,
    private readonly _creditService: AiseeCreditService,
    private readonly _aiseeClient: AiseeClient,
    private readonly _organizationService: OrganizationService
  ) {}

  private readonly logger = new Logger(AdminBillingController.name);

  /**
   * `costItems` is a JSON string column, and this is the view an operator opens
   * BECAUSE the ledger looks wrong — so one unparseable row must degrade to an
   * empty breakdown rather than 500 the whole page (the sort is deterministic,
   * so they could not even page around it). Same contract as
   * AiseeCreditService.parseCostItems, and the same one BILLING_AMOUNT applies
   * to the sibling `amount` column.
   */
  private parseCostItems(raw: string, recordId: string): unknown[] {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      this.logger.warn(
        `Unparseable costItems on BillingRecord ${recordId} — treating as empty`
      );
      return [];
    }
  }

  /**
   * GET /admin/billing/records
   *
   * The credit-consumption ledger, filtered on the axes operations asks about.
   *
   * The one that matters most is `scene`: BillingRecord.businessType is too
   * coarse to answer "what did this feature cost us" (ai_copywriting alone spans
   * the editor copilot, the agent chat, calendar post generation and Engage
   * reference posts), so a scene is the businessType + subType + `data` marker
   * combination that identifies the product action. GET /admin/billing/meta
   * lists them, along with every status and its operational meaning.
   *
   * Filters (all optional, all ANDed; scene / businessType / subType / status
   * take a comma-separated set):
   *   scene, businessType, subType, status
   *   organizationId | userId
   *   source, surface, platform, projectId   — `data` JSON markers
   *   model                                  — substring of the costItems breakdown
   *   relatedId, taskId (partial), transactionId
   *   search                                 — description / taskId / relatedId /
   *                                            transactionId / id
   *   dateFrom, dateTo, minAmount, maxAmount
   *   sortBy=createdAt|amount, sortOrder=asc|desc   (amount sorts numerically)
   *   page, pageSize (max 200)
   *
   * `totals` is the credit sum over the WHOLE filtered set, not the page — that
   * is the number ops is after when it narrows to one business.
   */
  @Get('/records')
  async listRecords(@Query() query: AdminBillingRecordsQueryDto) {
    const { organizationId, empty } = await resolveOrganizationId(
      this._organizationService,
      query.organizationId,
      query.userId,
    );

    const normalized = normalizeBillingQuery(query, organizationId);
    const { page, pageSize } = normalized;

    if (empty) {
      return {
        records: [],
        totals: { count: 0, amount: '0' },
        pagination: { page, pageSize, total: 0, totalPages: 0 },
      };
    }

    const where = buildBillingWhere(normalized);
    const skip = (page - 1) * pageSize;

    // Totals separately from the page: a window function would lose them the
    // moment OFFSET runs past the last row, which is exactly when the caller
    // still needs the count to know how far it overshot.
    // Both read the same WHERE and neither consumes the other, so they go out
    // together — only the hydrate below depends on a result.
    const [[totals], ids] = await Promise.all([
      this._billingRecord.model.$queryRaw<{ count: number; amount: string }[]>`
        SELECT COUNT(*)::int AS "count",
               COALESCE(SUM(${BILLING_AMOUNT}), 0)::text AS "amount"
        FROM "BillingRecord"
        WHERE ${where}
      `,
      this._billingRecord.model.$queryRaw<{ id: string }[]>`
        SELECT "id"
        FROM "BillingRecord"
        WHERE ${where}
        ORDER BY ${buildBillingOrderBy(normalized)}
        LIMIT ${pageSize} OFFSET ${skip}
      `,
    ]);

    const rows = ids.length
      ? await this._billingRecord.model.billingRecord.findMany({
          where: { id: { in: ids.map((row) => row.id) } },
          select: {
            id: true,
            organizationId: true,
            transactionId: true,
            taskId: true,
            amount: true,
            businessType: true,
            subType: true,
            description: true,
            costItems: true,
            relatedId: true,
            data: true,
            status: true,
            remainingBalance: true,
            debtAmount: true,
            error: true,
            createdAt: true,
            updatedAt: true,
            organization: {
              select: {
                users: {
                  where: { role: { in: ['SUPERADMIN', 'ADMIN'] }, disabled: false },
                  orderBy: { role: 'asc' },
                  take: 1,
                  select: { userId: true },
                },
              },
            },
          },
        })
      : [];

    // findMany does not preserve the id order the sort produced.
    const byId = new Map(rows.map((row) => [row.id, row]));

    return {
      records: ids
        .map(({ id }) => byId.get(id))
        .filter((row): row is (typeof rows)[number] => !!row)
        .map(({ organization, ...record }) => ({
          ...record,
          costItems: this.parseCostItems(record.costItems, record.id),
          scene: resolveBillingSceneId(record),
          userId: organization?.users[0]?.userId ?? null,
        })),
      totals: {
        count: totals?.count ?? 0,
        amount: totals?.amount ?? '0',
      },
      pagination: {
        page,
        pageSize,
        total: totals?.count ?? 0,
        totalPages: Math.ceil((totals?.count ?? 0) / pageSize),
      },
    };
  }

  /**
   * GET /admin/billing/records/:id
   *
   * Get a single billing record by ID.
   */
  @Get('/records/:id')
  async getRecord(@Param('id') id: string) {
    const record = await this._billingRecord.model.billingRecord.findUnique({
      where: { id },
    });

    if (!record) {
      return { error: 'Record not found' };
    }

    return {
      ...record,
      costItems: this.parseCostItems(record.costItems, record.id),
      scene: resolveBillingSceneId(record),
    };
  }

  /**
   * GET /admin/billing/summary
   *
   * Aggregated billing summary: counts and totals by status and businessType.
   */
  @Get('/summary')
  async summary() {
    const byStatus = await this._billingRecord.model.billingRecord.groupBy({
      by: ['status'],
      _count: true,
    });

    const byBusinessType = await this._billingRecord.model.billingRecord.groupBy({
      by: ['businessType', 'status'],
      _count: true,
    });

    const failedCount = byStatus.find((s) => s.status === 'failed')?._count || 0;
    const pendingCount = byStatus.find((s) => s.status === 'pending')?._count || 0;

    return {
      checkedAt: new Date().toISOString(),
      byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count])),
      byBusinessType: byBusinessType.map((b) => ({
        businessType: b.businessType,
        status: b.status,
        count: b._count,
      })),
      healthy: failedCount === 0 && pendingCount === 0,
      actionRequired: failedCount + pendingCount,
    };
  }

  /**
   * GET /admin/billing/stats
   *
   * "What does each business cost us, per charge" — the per-scene credit
   * breakdown behind the ledger. Takes the SAME filters as /records, so the
   * numbers always describe the rows the operator is currently looking at.
   *
   * Grouped in SQL by (businessType, subType, scene `data` markers, status) and
   * folded into scenes here, so the grouping keys follow the scene registry
   * instead of a second hand-maintained list. Scenes with no matching row are
   * omitted — /meta is the place that lists every scene that can exist.
   */
  @Get('/stats')
  async stats(@Query() query: AdminBillingRecordsQueryDto) {
    const { organizationId, empty } = await resolveOrganizationId(
      this._organizationService,
      query.organizationId,
      query.userId,
    );
    if (empty) {
      return {
        checkedAt: new Date().toISOString(),
        scenes: [] as BillingSceneStats[],
        total: { count: 0, amount: '0' },
      };
    }

    const normalized = normalizeBillingQuery(query, organizationId);
    const where = buildBillingWhere(normalized);
    const { keys, select, groupBy } = buildSceneGrouping();

    const rows = await this._billingRecord.model.$queryRaw<
      Record<string, any>[]
    >`
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
    `;

    const buckets = new Map<
      string,
      {
        id: string;
        scene: string;
        label: string;
        businessType: string | null;
        count: number;
        totalAmount: number;
        minAmount: number;
        maxAmount: number;
        lastAt: Date | null;
        byStatus: Record<string, number>;
      }
    >();

    for (const row of rows) {
      const data = Object.fromEntries(
        keys.map((key) => [key, row[`data_${key}`]])
      );
      const sceneId = resolveBillingSceneId({
        businessType: row.businessType,
        subType: row.subType,
        data,
      });
      const def = findBillingScene(sceneId);

      // The unclassified bucket is keyed per businessType: it exists to announce
      // "this billing call site has no scene definition", and folding two
      // businessTypes into one row would show a single arbitrary label (whichever
      // SQL group arrived first) plus an average across unrelated businesses —
      // exactly the blending scenes were introduced to eliminate.
      const bucketKey =
        sceneId === BILLING_SCENE_OTHER ? `other:${row.businessType}` : sceneId;

      const bucket = buckets.get(bucketKey) ?? {
        id: bucketKey,
        scene: sceneId,
        label: def?.label ?? 'Unclassified',
        businessType: def?.businessType ?? row.businessType ?? null,
        count: 0,
        totalAmount: 0,
        minAmount: Number.POSITIVE_INFINITY,
        maxAmount: 0,
        lastAt: null as Date | null,
        byStatus: {} as Record<string, number>,
      };

      const count = Number(row.count) || 0;
      bucket.count += count;
      bucket.totalAmount += Number(row.totalAmount) || 0;
      bucket.minAmount = Math.min(bucket.minAmount, Number(row.minAmount) || 0);
      bucket.maxAmount = Math.max(bucket.maxAmount, Number(row.maxAmount) || 0);
      bucket.byStatus[row.status] = (bucket.byStatus[row.status] ?? 0) + count;
      const lastAt = row.lastAt ? new Date(row.lastAt) : null;
      if (lastAt && (!bucket.lastAt || lastAt > bucket.lastAt)) {
        bucket.lastAt = lastAt;
      }

      buckets.set(bucketKey, bucket);
    }

    const scenes: BillingSceneStats[] = [...buckets.values()]
      .map((bucket) => ({
        id: bucket.id,
        scene: bucket.scene,
        label: bucket.label,
        businessType: bucket.businessType,
        count: bucket.count,
        totalAmount: bucket.totalAmount.toFixed(6),
        // Per-charge cost is the whole point of this view: how much one send,
        // one reply draft, one plan generation actually burns.
        avgAmount: (bucket.count
          ? bucket.totalAmount / bucket.count
          : 0
        ).toFixed(6),
        minAmount: (Number.isFinite(bucket.minAmount)
          ? bucket.minAmount
          : 0
        ).toFixed(6),
        maxAmount: bucket.maxAmount.toFixed(6),
        lastAt: bucket.lastAt ? bucket.lastAt.toISOString() : null,
        byStatus: bucket.byStatus,
      }))
      .sort((a, b) => Number(b.totalAmount) - Number(a.totalAmount));

    return {
      checkedAt: new Date().toISOString(),
      scenes,
      total: {
        count: scenes.reduce((sum, scene) => sum + scene.count, 0),
        amount: scenes
          .reduce((sum, scene) => sum + Number(scene.totalAmount), 0)
          .toFixed(6),
      },
    };
  }

  /**
   * GET /admin/billing/meta
   *
   * The filter vocabulary: every business scene (with what it means and where it
   * is triggered from), every status (with whether it needs a human), and the
   * raw businessType / subType / sort values. Served from the registries so the
   * aisee-manage filter cannot drift from what the backend actually writes.
   */
  @Get('/meta')
  meta() {
    const scenes: BillingSceneOption[] = [
      ...BILLING_SCENES.map((scene) => ({
          id: scene.id,
          label: scene.label,
          description: scene.description,
        businessType: scene.businessType as string | null,
        subType: scene.subType ?? null,
      })),
      {
        id: BILLING_SCENE_OTHER,
        label: 'Unclassified',
        description:
          'Rows no scene claims — a billing call site with no scene definition, or a legacy row written before subType existed. Should stay empty.',
        businessType: null,
        subType: null,
      },
    ];

    return {
      scenes,
      statuses: BILLING_STATUSES,
      businessTypes: Object.values(AiseeBusinessType),
      subTypes: Object.values(AiseeBusinessSubType),
      dataFilterKeys: BILLING_DATA_FILTER_KEYS,
      sortFields: BILLING_SORT_FIELDS,
    };
  }

  /**
   * PATCH /admin/billing/associate/:taskId
   *
   * Back-fill a BillingRecord with a business entity created after billing.
   * Used when Post / Media is created after the AI generation.
   */
  @Patch('/associate/:taskId')
  async associateEntity(
    @Param('taskId') taskId: string,
    @Body() body: { relatedId?: string; data?: Record<string, unknown> }
  ) {
    const updated = await this._creditService.associateEntity(taskId, body);
    return { success: updated, taskId };
  }

  /**
   * POST /admin/billing/retry/:id
   *
   * Retry a single failed billing record.
   * Re-sends the deduction to Aisee and updates the local record.
   */
  @Post('/retry/:id')
  async retryRecord(@Param('id') id: string) {
    const record = await this._billingRecord.model.billingRecord.findUnique({
      where: { id },
    });

    if (!record) {
      return { success: false, error: 'Record not found' };
    }

    if (record.status === 'success') {
      return { success: false, error: 'Record already succeeded — cannot retry' };
    }

    if (record.status === 'skipped') {
      return { success: false, error: 'Record was skipped (Aisee not configured)' };
    }

    if (record.status === 'internal') {
      return { success: false, error: 'Record was billed via subscription (BILL_TYPE=internal)' };
    }

    // Resolve orgId → Aisee userId (BillingRecord stores orgId, not user ID)
    const aiseeUserId = await this._creditService.resolveOwnerUserId(record.organizationId);

    // Infer subType if missing from record (for old data)
    const subType = AiseeCreditService.inferSubType(
      record.businessType as any,
      record.subType as any
    );

    const deduction = await this._aiseeClient.deductCredits({
      userId: aiseeUserId,
      amount: record.amount,
      taskId: record.taskId,
      description: `[RETRY] ${record.description}`,
      relatedId: record.relatedId || undefined,
      data: {
        business_type: record.businessType,
        sub_type: subType,
        cost_items: JSON.parse(record.costItems),
        postiz_billing_id: record.id,
        ...((record.data as Record<string, unknown>) || {}),
      },
    });

    if (deduction.success) {
      await this._billingRecord.model.billingRecord.update({
        where: { id: record.id },
        data: {
          status: 'success',
          subType: subType, // Back-fill missing subType
          transactionId: deduction.transactionId,
          remainingBalance: deduction.remainingBalance,
          debtAmount: deduction.debtAmount,
          error: null,
        },
      });

      // Fire-and-forget confirm
      this._aiseeClient
        .confirmDeduction({ taskId: record.taskId, status: 'success' })
        .catch(() => {});

      return {
        success: true,
        recordId: record.id,
        transactionId: deduction.transactionId,
        remainingBalance: deduction.remainingBalance,
      };
    }

    // Update error message
    await this._billingRecord.model.billingRecord.update({
      where: { id: record.id },
      data: { error: deduction.error },
    });

    return {
      success: false,
      recordId: record.id,
      error: deduction.error,
    };
  }

  /**
   * POST /admin/billing/retry-all-failed
   *
   * Retry all failed billing records. Returns a summary of results.
   * Processes sequentially to avoid overwhelming Aisee.
   */
  @Post('/retry-all-failed')
  async retryAllFailed() {
    const failedRecords = await this._billingRecord.model.billingRecord.findMany({
      where: { status: 'failed' },
      orderBy: { createdAt: 'asc' },
    });

    if (failedRecords.length === 0) {
      return { total: 0, succeeded: 0, failed: 0, results: [] };
    }

    const results: Array<{ id: string; taskId: string; success: boolean; error?: string }> = [];

    for (const record of failedRecords) {
      const aiseeUserId = await this._creditService.resolveOwnerUserId(record.organizationId);

      // Infer subType if missing from record (for old data)
      const subType = AiseeCreditService.inferSubType(
        record.businessType as any,
        record.subType as any
      );

      const deduction = await this._aiseeClient.deductCredits({
        userId: aiseeUserId,
        amount: record.amount,
        taskId: record.taskId,
        description: `[RETRY] ${record.description}`,
        relatedId: record.relatedId || undefined,
        data: {
          business_type: record.businessType,
          sub_type: subType,
          cost_items: JSON.parse(record.costItems),
          postiz_billing_id: record.id,
          ...((record.data as Record<string, unknown>) || {}),
        },
      });

      if (deduction.success) {
        await this._billingRecord.model.billingRecord.update({
          where: { id: record.id },
          data: {
            status: 'success',
            subType: subType, // Back-fill missing subType
            transactionId: deduction.transactionId,
            remainingBalance: deduction.remainingBalance,
            debtAmount: deduction.debtAmount,
            error: null,
          },
        });

        this._aiseeClient
          .confirmDeduction({ taskId: record.taskId, status: 'success' })
          .catch(() => {});

        results.push({ id: record.id, taskId: record.taskId, success: true });
      } else {
        await this._billingRecord.model.billingRecord.update({
          where: { id: record.id },
          data: { error: deduction.error },
        });

        results.push({
          id: record.id,
          taskId: record.taskId,
          success: false,
          error: deduction.error,
        });
      }
    }

    return {
      total: results.length,
      succeeded: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      results,
    };
  }
}
