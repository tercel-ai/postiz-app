import { isAccountBoundSendingEnabled } from '@gitroom/nestjs-libraries/extension/account-bound-sending.config';
import {
  Body,
  Controller,
  Get,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization, User } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { ExtensionNodeService } from '@gitroom/nestjs-libraries/extension/extension-node.service';
import {
  RegisterExtensionNodeDto,
  SaveExtensionNodeDto,
} from '@gitroom/nestjs-libraries/extension/extension-node.dto';

@ApiTags('Extension terminals')
@Controller('/extension/nodes')
export class ExtensionNodesController {
  constructor(private readonly nodes: ExtensionNodeService) {}

  private enabled() {
    if (!isAccountBoundSendingEnabled())
      throw new ServiceUnavailableException('EXTENSION_NODES_NOT_ENABLED');
  }

  @Post('/register')
  register(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: RegisterExtensionNodeDto
  ) {
    this.enabled();
    return this.nodes.register(org.id, user.id, body);
  }

  @Get('/')
  list(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User
  ) {
    this.enabled();
    return this.nodes.list(org.id, user.id);
  }

  @Post('/save')
  save(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: SaveExtensionNodeDto
  ) {
    this.enabled();
    return this.nodes.save(org.id, user.id, body);
  }
}
