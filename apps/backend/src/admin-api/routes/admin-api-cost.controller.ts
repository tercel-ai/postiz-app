import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { SuperAdmin } from '@gitroom/backend/services/auth/admin/super-admin.decorator';
import {
  ApiUsageService,
  API_PRICE_USD,
} from '@gitroom/nestjs-libraries/database/prisma/api-usage/api-usage.service';

/**
 * Internal API-cost report (NOT user-facing). Surfaces the ApiUsageTick
 * counters priced via API_PRICE_USD so admins can see what the platform spends
 * on paid third-party APIs (currently X). Read-only, super-admin only.
 */
@ApiTags('Admin')
@Controller('/admin/api-cost')
@SuperAdmin()
export class AdminApiCostController {
  constructor(private readonly _apiUsage: ApiUsageService) {}

  /**
   * GET /admin/api-cost?from=YYYY-MM-DD&to=YYYY-MM-DD
   *
   * Returns the cost breakdown by platform+category and a per-day cost trend
   * over [from, to). `to` is exclusive (a whole-day bucket). Defaults to the
   * last 30 days when omitted. Also echoes the active price map so the UI can
   * show unit prices without hardcoding them.
   */
  @ApiOperation({ summary: 'Internal API cost report (super-admin)' })
  @Get('/')
  async report(@Query('from') from?: string, @Query('to') to?: string) {
    const now = new Date();
    // Default window: last 30 days, `to` exclusive of tomorrow so today counts.
    const toDate = to ? new Date(to) : new Date(now.getTime() + 86_400_000);
    const fromDate = from
      ? new Date(from)
      : new Date(now.getTime() - 30 * 86_400_000);

    const [summary, daily] = await Promise.all([
      this._apiUsage.report(fromDate, toDate),
      this._apiUsage.reportDaily(fromDate, toDate),
    ]);

    return {
      range: {
        from: fromDate.toISOString().slice(0, 10),
        to: toDate.toISOString().slice(0, 10),
      },
      summary, // { items: [{ platform, category, quantity, costUsd }], totalUsd }
      daily, // [{ date, quantity, costUsd }]
      prices: API_PRICE_USD,
    };
  }

  /**
   * GET /admin/api-cost/business?from&to&organizationId
   *
   * Same window semantics as `/`, but broken down by BUSINESS PURPOSE
   * (post_publish / engage_reply / post_metrics / engage_metrics / engage_scan /
   * user_lookup / ...) and org. Each row keeps the underlying X billing
   * `category` so cost reuses the same price map. Pass `organizationId` to scope
   * to one org (engage_scan rows are attributed to org '' = shared/system).
   */
  @ApiOperation({ summary: 'Internal API cost by business purpose (super-admin)' })
  @Get('/business')
  async business(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('organizationId') organizationId?: string
  ) {
    const now = new Date();
    const toDate = to ? new Date(to) : new Date(now.getTime() + 86_400_000);
    const fromDate = from
      ? new Date(from)
      : new Date(now.getTime() - 30 * 86_400_000);

    const summary = await this._apiUsage.reportBiz(
      fromDate,
      toDate,
      organizationId
    );

    return {
      range: {
        from: fromDate.toISOString().slice(0, 10),
        to: toDate.toISOString().slice(0, 10),
      },
      summary, // { items: [{ organizationId, platform, bizCategory, category, quantity, costUsd }], totalUsd }
      prices: API_PRICE_USD,
    };
  }

  /**
   * GET /admin/api-cost/engage-scores?from&to&organizationId
   *
   * Engage opportunity score distribution over [from, to), grouped by
   * org/platform/phase/bucket. `phase` separates 'scanned' (every
   * keyword-matched post) from 'persisted' (the >= MIN_SCORE opportunities).
   * Buckets are non-overlapping: 0-50 / 50-60 / 60-70 / 70-85 / 85-100.
   */
  @ApiOperation({ summary: 'Engage score distribution (super-admin)' })
  @Get('/engage-scores')
  async engageScores(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('organizationId') organizationId?: string
  ) {
    const now = new Date();
    const toDate = to ? new Date(to) : new Date(now.getTime() + 86_400_000);
    const fromDate = from
      ? new Date(from)
      : new Date(now.getTime() - 30 * 86_400_000);

    const items = await this._apiUsage.reportScores(
      fromDate,
      toDate,
      organizationId
    );

    return {
      range: {
        from: fromDate.toISOString().slice(0, 10),
        to: toDate.toISOString().slice(0, 10),
      },
      items, // [{ organizationId, platform, phase, bucket, quantity }]
    };
  }
}
