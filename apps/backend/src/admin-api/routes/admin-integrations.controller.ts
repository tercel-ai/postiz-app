import { Controller, Get, HttpException, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { AdminIntegrationsQueryDto } from '@gitroom/nestjs-libraries/dtos/admin/admin-integrations-query.dto';
import { SuperAdmin } from '@gitroom/backend/services/auth/admin/super-admin.decorator';

@ApiTags('Admin')
@Controller('/admin/integrations')
@SuperAdmin()
export class AdminIntegrationsController {
  constructor(private _integrationService: IntegrationService) {}

  @Get('/')
  async list(@Query() query: AdminIntegrationsQueryDto) {
    return this._integrationService.paginate({
      page: query.page,
      pageSize: query.pageSize,
      keyword: query.keyword,
      organizationId: query.organizationId,
      providerIdentifier: query.providerIdentifier,
      disabled: query.disabled,
      refreshNeeded: query.refreshNeeded,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
    });
  }

  @Get('/:id')
  async getById(@Param('id') id: string) {
    const integration = await this._integrationService.getByIdForAdmin(id);
    if (!integration) {
      throw new HttpException('Integration not found', 404);
    }
    return integration;
  }
}
