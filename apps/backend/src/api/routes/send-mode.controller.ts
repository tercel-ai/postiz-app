import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Organization, User } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { SendModeService } from '@gitroom/nestjs-libraries/extension/send-mode.service';
import {
  BeginBrowserWriteDto,
  BrowserWriteOutcomeDto,
  BrowserReplyRecoveryDto,
  CancelSendModeTransitionDto,
  ResolveAutonomousEffectDto,
  ResolveLegacyReplyRecoveryDto,
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
      'Request an organization sending mode switch and drain existing autonomous work',
  })
  save(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: SaveSendModeDto
  ) {
    return this.modes.save(org.id, user.id, body);
  }

  @Post('/transition/cancel')
  @ApiOperation({
    summary: 'Cancel a pending mode switch without cancelling existing sends',
  })
  cancelTransition(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: CancelSendModeTransitionDto
  ) {
    return this.modes.cancelTransition(org.id, user.id, body);
  }

  @Post('/browser-writes')
  beginBrowserWrite(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: BeginBrowserWriteDto
  ) {
    return this.modes.beginBrowserWrite(org.id, user.id, body);
  }

  @Post('/browser-writes/:id/outcome')
  settleBrowserWrite(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: BrowserWriteOutcomeDto
  ) {
    return this.modes.settleBrowserWrite(org.id, user.id, id, body);
  }

  @Get('/replies/:id/browser-recovery')
  @ApiOperation({ summary: 'Inspect original-user non-submission proof for a historical reply' })
  getBrowserReplyRecovery(@GetOrgFromRequest() org: Organization, @GetUserFromRequest() user: User, @Param('id') id: string) {
    return this.modes.getBrowserReplyRecovery(org.id, user.id, id);
  }

  @Post('/replies/:id/browser-recovery')
  @ApiOperation({ summary: 'Recover original-user reply ownership only from durable non-submission proof' })
  resolveBrowserReplyRecovery(@GetOrgFromRequest() org: Organization, @GetUserFromRequest() user: User,
    @Param('id') id: string, @Body() body: BrowserReplyRecoveryDto) {
    return this.modes.resolveBrowserReplyRecovery(org.id, user.id, id, body);
  }

  @Get('/replies/:id/legacy-recovery')
  @ApiOperation({ summary: 'Inspect a historical reply claim and all relevant receipt outcomes' })
  getLegacyReplyRecovery(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string
  ) {
    return this.modes.getLegacyReplyRecovery(org.id, user.id, id);
  }

  @Post('/replies/:id/legacy-recovery')
  @ApiOperation({ summary: 'Audit administrator proof and release only the reviewed historical reply ownership' })
  resolveLegacyReplyRecovery(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: ResolveLegacyReplyRecoveryDto
  ) {
    return this.modes.resolveLegacyReplyRecovery(org.id, user.id, id, body);
  }

  @Get('/autonomous-effects')
  @ApiOperation({ summary: 'List unresolved autonomous write receipts' })
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
