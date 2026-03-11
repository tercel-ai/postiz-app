import { Controller, Get, Post, Query, BadRequestException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DashboardService } from '@gitroom/nestjs-libraries/database/prisma/dashboard/dashboard.service';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { DataTicksService } from '@gitroom/nestjs-libraries/database/prisma/data-ticks/data-ticks.service';
import { SuperAdmin } from '@gitroom/backend/services/auth/admin/super-admin.decorator';

@ApiTags('Admin')
@Controller('/admin/dashboard')
@SuperAdmin()
export class AdminDashboardController {
  constructor(
    private _dashboardService: DashboardService,
    private _organizationService: OrganizationService,
    private _dataTicksService: DataTicksService
  ) {}

  @Get('/')
  async overview() {
    const [stats, orgCount] = await Promise.all([
      this._dashboardService.getGlobalStats(),
      this._organizationService.getCount(),
    ]);

    return {
      total_organizations: orgCount,
      ...stats,
    };
  }

  /**
   * Backfill DataTicks for a specific date or date range.
   * Usage: POST /admin/dashboard/data-ticks/backfill?startDate=2026-03-01&endDate=2026-03-10
   */
  @Post('/data-ticks/backfill')
  async backfillDataTicks(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate?: string
  ) {
    if (!startDate) {
      throw new BadRequestException('startDate is required (YYYY-MM-DD)');
    }

    const start = new Date(startDate);
    const end = endDate ? new Date(endDate) : start;

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new BadRequestException('Invalid date format. Use YYYY-MM-DD.');
    }
    if (start > end) {
      throw new BadRequestException('startDate must be before or equal to endDate');
    }

    const results = [];
    const current = new Date(start);
    while (current <= end) {
      const result = await this._dataTicksService.syncDailyTicks(new Date(current));
      results.push(result);
      current.setDate(current.getDate() + 1);
    }

    return { backfilled: results.length, results };
  }
}
