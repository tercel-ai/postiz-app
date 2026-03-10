import { Controller, Get, HttpException, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { AdminOrganizationsQueryDto } from '@gitroom/nestjs-libraries/dtos/admin/admin-organizations-query.dto';
import { SuperAdmin } from '@gitroom/backend/services/auth/admin/super-admin.decorator';

@ApiTags('Admin')
@Controller('/admin/organizations')
@SuperAdmin()
export class AdminOrganizationsController {
  constructor(private _organizationService: OrganizationService) {}

  @Get('/')
  async list(@Query() query: AdminOrganizationsQueryDto) {
    return this._organizationService.paginate({
      page: query.page,
      pageSize: query.pageSize,
      keyword: query.keyword,
    });
  }

  @Get('/:id')
  async getById(@Param('id') id: string) {
    const org = await this._organizationService.getOrgById(id);
    if (!org) {
      throw new HttpException('Organization not found', 404);
    }
    return org;
  }
}
