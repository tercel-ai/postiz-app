import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Organization, User } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { SendModeService } from '@gitroom/nestjs-libraries/extension/send-mode.service';
import {
  ResolveAutonomousEffectDto,
  SaveSendModeDto,
} from '@gitroom/nestjs-libraries/extension/send-mode.dto';

@ApiTags('Sending')
@Controller('/sending/mode')
export class SendModeController {
  constructor(private readonly modes: SendModeService) {}

  @Get()
  @ApiOperation({
    summary: 'Read organization sending mode and safe switching blockers',
  })
  get(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User
  ) {
    return this.modes.get(org.id, user.id);
  }

  @Post()
  @ApiOperation({
    summary:
      'Safely switch organization sending mode without migrating existing content',
  })
  save(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: SaveSendModeDto
  ) {
    return this.modes.save(org.id, user.id, body);
  }

  @Get('/autonomous-effects')
  listAutonomousEffects(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User
  ) {
    return this.modes.listAutonomousEffects(org.id, user.id);
  }

  @Post('/autonomous-effects/:id/resolve')
  resolveAutonomousEffect(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: ResolveAutonomousEffectDto
  ) {
    return this.modes.resolveAutonomousEffect(org.id, user.id, id, body);
  }
}
