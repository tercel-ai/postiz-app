import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { Organization, User } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { GetTimezone } from '@gitroom/nestjs-libraries/user/timezone.from.request';
import { parseDateToUTC } from '@gitroom/helpers/utils/date.utils';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { DashboardService } from '@gitroom/nestjs-libraries/database/prisma/dashboard/dashboard.service';
import {
  PostsTrendQueryDto,
  ImpressionsQueryDto,
  TrafficsQueryDto,
  PostEngagementQueryDto,
  DashboardSummaryQueryDto,
} from '@gitroom/nestjs-libraries/dtos/dashboard/dashboard.dto';

@ApiTags('Dashboard')
@Controller('/dashboard')
export class DashboardController {
  constructor(private _dashboardService: DashboardService) {}

  @Get('/summary')
  @ApiOkResponse({
    description: 'Returns dashboard summary',
    schema: { type: 'object' },
  })
  async getSummary(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Query() query: DashboardSummaryQueryDto,
    @GetTimezone() tz?: string
  ) {
    const startDate = query.startDate ? parseDateToUTC(query.startDate, tz) : undefined;
    const endDate = query.endDate ? parseDateToUTC(query.endDate, tz) : undefined;

    if (startDate && endDate && startDate > endDate) {
      throw new BadRequestException('startDate must be before endDate');
    }

    return this._dashboardService.getSummary(org, user?.id, startDate, endDate, query.integrationId, query.channel, tz);
  }

  @Get('/posts-trend')
  @ApiOkResponse({
    description: 'Returns posts trend',
    schema: { type: 'object' },
  })
  async getPostsTrend(
    @GetOrgFromRequest() org: Organization,
    @Query() query: PostsTrendQueryDto,
    @GetTimezone() tz?: string
  ) {
    return this._dashboardService.getPostsTrend(org, query.period, tz);
  }

  @Get('/traffics')
  @ApiOkResponse({
    description: 'Returns traffic analytics',
    schema: { type: 'object' },
  })
  async getTraffics(
    @GetOrgFromRequest() org: Organization,
    @Query() query: TrafficsQueryDto,
    @GetTimezone() tz?: string
  ) {
    const startDate = query.startDate ? parseDateToUTC(query.startDate, tz) : undefined;
    const endDate = query.endDate ? parseDateToUTC(query.endDate, tz) : undefined;
    if (startDate && endDate && startDate > endDate) {
      throw new BadRequestException('startDate must be before endDate');
    }
    return this._dashboardService.getTraffics(org, query.integrationId, query.channel, startDate, endDate);
  }

  @Get('/impressions')
  @ApiOkResponse({
    description: 'Returns impressions analytics',
    schema: { type: 'object' },
  })
  async getImpressions(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ImpressionsQueryDto,
    @GetTimezone() tz?: string
  ) {
    const startDate = query.startDate ? parseDateToUTC(query.startDate, tz) : undefined;
    const endDate = query.endDate ? parseDateToUTC(query.endDate, tz) : undefined;
    if (startDate && endDate && startDate > endDate) {
      throw new BadRequestException('startDate must be before endDate');
    }
    return this._dashboardService.getImpressions(org, query.period, query.integrationId, query.channel, startDate, endDate);
  }

  @Get('/post-engagement')
  @ApiOkResponse({
    description: 'Returns post engagement analytics',
    schema: { type: 'object' },
  })
  async getPostEngagement(
    @GetOrgFromRequest() org: Organization,
    @Query() query: PostEngagementQueryDto
  ) {
    return this._dashboardService.getPostEngagement(org, query.days);
  }
}
