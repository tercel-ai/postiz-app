import { SendModeService } from '@gitroom/nestjs-libraries/extension/send-mode.service';
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
import { SendPolicyService } from '@gitroom/nestjs-libraries/extension/send-policy.service';
import { SaveSendPreferencesDto } from '@gitroom/nestjs-libraries/extension/send-policy.dto';

@ApiTags('Sending preferences')
@Controller('/user/send-preferences')
export class SendPreferencesController {
  constructor(private readonly policies: SendPolicyService, private readonly modes: SendModeService) {}

  private async enabled() {
    if (!(await this.modes.getSystem()).effectiveEnabled)
      throw new ServiceUnavailableException('ACCOUNT_BINDINGS_NOT_ENABLED');
  }

  @Get()
  async get(@GetUserFromRequest() user: User) {
    await this.enabled();
    return this.policies.getPreferences(user.id);
  }

  @Post()
  async save(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: SaveSendPreferencesDto
  ) {
    await this.enabled();
    return this.policies.savePreferences(org.id, user.id, body);
  }
}
