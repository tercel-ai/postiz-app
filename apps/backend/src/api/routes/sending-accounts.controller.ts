import { isAccountBoundSendingEnabled } from '@gitroom/nestjs-libraries/extension/account-bound-sending.config';
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization, User } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { SendBindingService } from '@gitroom/nestjs-libraries/extension/send-binding.service';
import { SaveSendingAccountsDto } from '@gitroom/nestjs-libraries/extension/send-binding.dto';

@ApiTags('Sending accounts')
@Controller()
export class SendingAccountsController {
  constructor(private readonly bindings: SendBindingService) {}

  private enabled() {
    if (!isAccountBoundSendingEnabled())
      throw new ServiceUnavailableException('ACCOUNT_BINDINGS_NOT_ENABLED');
  }

  @Get('/sending-accounts')
  organization(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User
  ) {
    this.enabled();
    return this.bindings.getDefaults(org.id, user.id);
  }

  @Post('/sending-accounts/save')
  saveOrganization(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: SaveSendingAccountsDto
  ) {
    this.enabled();
    return this.bindings.saveDefaults(org.id, user.id, body);
  }

  @Get('/projects/:projectId/sending-accounts')
  project(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('projectId') projectId: string
  ) {
    this.enabled();
    return this.bindings.getDefaults(org.id, user.id, projectId);
  }

  @Post('/projects/:projectId/sending-accounts/save')
  saveProject(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('projectId') projectId: string,
    @Body() body: SaveSendingAccountsDto
  ) {
    this.enabled();
    return this.bindings.saveDefaults(org.id, user.id, body, projectId);
  }
}
