import { Controller, Get, Query } from '@nestjs/common';
import { Organization } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { ApiTags } from '@nestjs/swagger';
import { DashboardService } from '@gitroom/nestjs-libraries/database/prisma/dashboard/dashboard.service';
import { PostsTrendQueryDto, ImpressionsQueryDto } from '@gitroom/nestjs-libraries/dtos/dashboard/dashboard.dto';

@ApiTags('Dashboard')
@Controller('/dashboard')
export class DashboardController {
  constructor(private _dashboardService: DashboardService) {}

  @Get('/summary')
  async getSummary(@GetOrgFromRequest() org: Organization) {
    return this._dashboardService.getSummary(org);
  }

  @Get('/posts-trend')
  async getPostsTrend(
    @GetOrgFromRequest() org: Organization,
    @Query() query: PostsTrendQueryDto
  ) {
    return this._dashboardService.getPostsTrend(org, query.period);
  }

  @Get('/traffics')
  async getTraffics(@GetOrgFromRequest() org: Organization) {
    return this._dashboardService.getTraffics(org);
  }

  @Get('/impressions')
  async getImpressions(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ImpressionsQueryDto
  ) {
    return this._dashboardService.getImpressions(org, query.period);
  }
}
