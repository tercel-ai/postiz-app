import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { AdminMediaQueryDto } from '@gitroom/nestjs-libraries/dtos/admin/admin-media-query.dto';
import { SuperAdmin } from '@gitroom/backend/services/auth/admin/super-admin.decorator';

@ApiTags('Admin')
@Controller('/admin/media')
@SuperAdmin()
export class AdminMediaController {
  constructor(private _mediaService: MediaService) {}

  @Get('/')
  async list(@Query() query: AdminMediaQueryDto) {
    return this._mediaService.paginate({
      page: query.page,
      pageSize: query.pageSize,
      keyword: query.keyword,
      organizationId: query.organizationId,
      type: query.type,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
    });
  }
}
