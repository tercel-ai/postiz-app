import { Controller, Get, HttpException, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ErrorsService } from '@gitroom/nestjs-libraries/database/prisma/errors/errors.service';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { AdminErrorsQueryDto } from '@gitroom/nestjs-libraries/dtos/admin/admin-errors-query.dto';
import { SuperAdmin } from '@gitroom/backend/services/auth/admin/super-admin.decorator';
import { resolveOrganizationId } from '@gitroom/backend/admin-api/admin.utils';

@ApiTags('Admin')
@Controller('/admin/errors')
@SuperAdmin()
export class AdminErrorsController {
  constructor(
    private _errorsService: ErrorsService,
    private _organizationService: OrganizationService,
  ) {}

  @Get('/')
  async list(@Query() query: AdminErrorsQueryDto) {
    const { organizationId, empty } = await resolveOrganizationId(
      this._organizationService,
      query.organizationId,
      query.userId,
    );
    if (empty) {
      return { items: [], total: 0, page: query.page, pageSize: query.pageSize, totalPages: 0 };
    }
    return this._errorsService.paginate({
      page: query.page,
      pageSize: query.pageSize,
      keyword: query.keyword,
      organizationId,
      platform: query.platform,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
    });
  }

  @Get('/:id')
  async getById(@Param('id') id: string) {
    const error = await this._errorsService.getById(id);
    if (!error) {
      throw new HttpException('Error not found', 404);
    }
    return error;
  }
}
