import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { AdminMediaQueryDto } from '@gitroom/nestjs-libraries/dtos/admin/admin-media-query.dto';
import { SuperAdmin } from '@gitroom/backend/services/auth/admin/super-admin.decorator';
import { resolveOrganizationId } from '@gitroom/backend/admin-api/admin.utils';

@ApiTags('Admin')
@Controller('/admin/media')
@SuperAdmin()
export class AdminMediaController {
  constructor(
    private _mediaService: MediaService,
    private _organizationService: OrganizationService,
  ) {}

  @Get('/')
  async list(@Query() query: AdminMediaQueryDto) {
    const { organizationId, empty } = await resolveOrganizationId(
      this._organizationService,
      query.organizationId,
      query.userId,
    );
    if (empty) {
      return { items: [], total: 0, page: query.page, pageSize: query.pageSize, totalPages: 0 };
    }
    return this._mediaService.paginate({
      page: query.page,
      pageSize: query.pageSize,
      keyword: query.keyword,
      organizationId,
      type: query.type,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
    });
  }
}
