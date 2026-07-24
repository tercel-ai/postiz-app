import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { EngageService } from '@gitroom/nestjs-libraries/engage/engage.service';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { AdminEngageQueryDto } from '@gitroom/nestjs-libraries/dtos/admin/admin-engage-query.dto';
import { SuperAdmin } from '@gitroom/backend/services/auth/admin/super-admin.decorator';
import { resolveOrganizationId } from '@gitroom/backend/admin-api/admin.utils';

@ApiTags('Admin')
@Controller('/admin/engage')
@SuperAdmin()
export class AdminEngageController {
  constructor(
    private _engageService: EngageService,
    private _organizationService: OrganizationService,
  ) {}

  // Paginated, cross-org list of Engage replies. Optional org/user scoping plus
  // platform/state filters — mirrors GET /admin/posts.
  @Get('/sent')
  async list(@Query() query: AdminEngageQueryDto) {
    const { organizationId, empty } = await resolveOrganizationId(
      this._organizationService,
      query.organizationId,
      query.userId,
    );
    if (empty) {
      return {
        results: [],
        total: 0,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: 0,
      };
    }
    return this._engageService.listSentRepliesForAdmin({
      page: query.page,
      pageSize: query.pageSize,
      organizationId,
      platform: query.platform,
      state: query.state,
      sortOrder: query.sortOrder,
    });
  }
}
