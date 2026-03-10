import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DashboardService } from '@gitroom/nestjs-libraries/database/prisma/dashboard/dashboard.service';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { SuperAdmin } from '@gitroom/backend/services/auth/admin/super-admin.decorator';

@ApiTags('Admin')
@Controller('/admin/dashboard')
@SuperAdmin()
export class AdminDashboardController {
  constructor(
    private _dashboardService: DashboardService,
    private _organizationService: OrganizationService
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
}
