import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { Organization } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetTimezone } from '@gitroom/nestjs-libraries/user/timezone.from.request';
import { ApiTags } from '@nestjs/swagger';
import { DashboardService } from '@gitroom/nestjs-libraries/database/prisma/dashboard/dashboard.service';
import {
  PostsTrendQueryDto,
  ImpressionsQueryDto,
  PostEngagementQueryDto,
  DashboardSummaryQueryDto,
} from '@gitroom/nestjs-libraries/dtos/dashboard/dashboard.dto';

@ApiTags('Dashboard')
@Controller('/dashboard')
export class DashboardController {
  constructor(private _dashboardService: DashboardService) {}

  @Get('/summary')
  async getSummary(
    @GetOrgFromRequest() org: Organization,
    @Query() query: DashboardSummaryQueryDto
  ) {
    const startDate = query.startDate ? new Date(query.startDate) : undefined;
    const endDate = query.endDate ? new Date(query.endDate) : undefined;

    if (startDate && endDate && startDate > endDate) {
      throw new BadRequestException('startDate must be before endDate');
    }

    return this._dashboardService.getSummary(org, startDate, endDate, query.integrationId, query.channel);
  }

  @Get('/posts-trend')
  async getPostsTrend(
    @GetOrgFromRequest() org: Organization,
    @Query() query: PostsTrendQueryDto,
    @GetTimezone() tz?: string
  ) {
    return this._dashboardService.getPostsTrend(org, query.period, tz);
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

  @Get('/post-engagement')
  async getPostEngagement(
    @GetOrgFromRequest() org: Organization,
    @Query() query: PostEngagementQueryDto
  ) {
    return this._dashboardService.getPostEngagement(org, query.days);
  }
}
