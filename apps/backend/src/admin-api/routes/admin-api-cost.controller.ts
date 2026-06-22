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
}
