import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { SuperAdmin } from '@gitroom/backend/services/auth/admin/super-admin.decorator';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { SendModeService } from '@gitroom/nestjs-libraries/extension/send-mode.service';
import { ResolveLegacyPostRecoveryDto } from '@gitroom/nestjs-libraries/extension/send-mode.dto';

@ApiTags('Admin')
@Controller('/admin/organizations/:organizationId/sending-mode')
@SuperAdmin()
export class AdminSendRecoveryController {
  constructor(private readonly modes: SendModeService) {}

  @Get()
  @ApiOperation({ summary: 'Inspect sending blockers for a target organization as a platform administrator' })
  get(@Param('organizationId', ParseUUIDPipe) organizationId: string, @GetUserFromRequest() user: User) {
    return this.modes.getAdminRecoveryState(organizationId, user.id);
  }

  @Get('/legacy-posts/:id/recovery')
  getLegacyPostRecovery(@Param('organizationId', ParseUUIDPipe) organizationId: string,
    @GetUserFromRequest() user: User, @Param('id') id: string) {
    return this.modes.getLegacyPostRecovery(organizationId, user.id, id);
  }

  @Post('/legacy-posts/:id/recovery')
  resolveLegacyPostRecovery(@Param('organizationId', ParseUUIDPipe) organizationId: string,
    @GetUserFromRequest() user: User, @Param('id') id: string, @Body() body: ResolveLegacyPostRecoveryDto) {
    return this.modes.resolveLegacyPostRecovery(organizationId, user.id, id, body);
  }
}
