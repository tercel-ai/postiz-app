import { SendModeService } from '@gitroom/nestjs-libraries/extension/send-mode.service';
import {
  Body,
  Controller,
  Get,
  Headers,
  UnauthorizedException,
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
  constructor(private readonly nodes: ExtensionNodeService, private readonly modes: SendModeService) {}

  private async enabled(org: string, user: string, registration = false) {
    const state = await this.modes.get(org, user);
    if (registration ? state.mode !== 'CONTROLLED'
      : !state.systemEnabled && state.configuredMode !== 'CONTROLLED')
      throw new ServiceUnavailableException('EXTENSION_NODES_NOT_ENABLED');
  }

  @Post('/register')
  async register(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: RegisterExtensionNodeDto
  ) {
    await this.enabled(org.id, user.id, true);
    return this.nodes.register(org.id, user.id, body);
  }

  @Get('/current')
  async current(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Headers('x-extension-node-id') nodeId?: string,
    @Headers('x-extension-node-token') nodeToken?: string,
    @Headers('x-extension-protocol-version') protocol?: string
  ) {
    if (protocol !== 'ACCOUNT_BOUND_V1')
      throw new UnauthorizedException('NODE_AUTHENTICATION_REQUIRED');
    await this.enabled(org.id, user.id);
    const node = await this.nodes.authenticate(org.id, user.id, nodeId, nodeToken);
    return {
      nodeId: node.nodeId,
      organizationId: node.organizationId,
      registeredByUserId: node.registeredByUserId,
      status: node.status,
    };
  }

  @Get('/')
  async list(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User
  ) {
    await this.enabled(org.id, user.id);
    return this.nodes.list(org.id, user.id);
  }

  @Post('/save')
  async save(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: SaveExtensionNodeDto
  ) {
    await this.enabled(org.id, user.id);
    return this.nodes.save(org.id, user.id, body);
  }
}
