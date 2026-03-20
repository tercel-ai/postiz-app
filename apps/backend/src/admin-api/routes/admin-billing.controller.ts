import { Controller, Get, Post, Patch, Param, Query, Body } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SuperAdmin } from '@gitroom/backend/services/auth/admin/super-admin.decorator';
import {
  PrismaRepository,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { AiseeCreditService } from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/aisee-credit.service';
import { AiseeClient } from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/aisee.client';
import { AdminBillingRecordsQueryDto } from '@gitroom/nestjs-libraries/dtos/admin/admin-billing-records-query.dto';

@ApiTags('Admin')
@Controller('/admin/billing')
@SuperAdmin()
export class AdminBillingController {
  constructor(
    private readonly _billingRecord: PrismaRepository<'billingRecord'>,
    private readonly _creditService: AiseeCreditService,
    private readonly _aiseeClient: AiseeClient
  ) {}

  /**
   * GET /admin/billing/records
   *
   * List billing records with optional filters.
   * Query params:
   *   - status: pending | success | failed | skipped (default: all)
   *   - organizationId: filter by org
   *   - businessType: ai_copywriting | image_gen | video_gen
   *   - page: page number (default: 1)
   *   - pageSize: items per page (default: 50, max: 200)
   */
  @Get('/records')
  async listRecords(@Query() query: AdminBillingRecordsQueryDto) {
    const { status, organizationId, businessType, page, pageSize } = query;
    const take = pageSize;
    const skip = (page - 1) * take;

    const where: Record<string, any> = {};
    if (status) where.status = status;
    if (organizationId) where.organizationId = organizationId;
    if (businessType) where.businessType = businessType;

    const [records, total] = await Promise.all([
      this._billingRecord.model.billingRecord.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      this._billingRecord.model.billingRecord.count({ where }),
    ]);

    return {
      records: records.map((r) => ({
        ...r,
        costItems: JSON.parse(r.costItems),
      })),
      pagination: {
        page: Math.floor(skip / take) + 1,
        pageSize: take,
        total,
        totalPages: Math.ceil(total / take),
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
      costItems: JSON.parse(record.costItems),
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

    const deduction = await this._aiseeClient.deductCredits({
      userId: aiseeUserId,
      amount: record.amount,
      taskId: record.taskId,
      description: `[RETRY] ${record.description}`,
      relatedId: record.relatedId || undefined,
      data: {
        business_type: record.businessType,
        sub_type: record.subType,
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

      const deduction = await this._aiseeClient.deductCredits({
        userId: aiseeUserId,
        amount: record.amount,
        taskId: record.taskId,
        description: `[RETRY] ${record.description}`,
        relatedId: record.relatedId || undefined,
        data: {
          business_type: record.businessType,
          sub_type: record.subType,
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
