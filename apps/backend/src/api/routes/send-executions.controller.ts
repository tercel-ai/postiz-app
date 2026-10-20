import { ApiOperation } from '@nestjs/swagger';
import { SendModeService } from '@gitroom/nestjs-libraries/extension/send-mode.service';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { SendCoordinatorService } from '@gitroom/nestjs-libraries/extension/send-coordinator.service';
import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { Organization, User } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import {
  SendExecutionService,
  NodeAuthentication,
} from '@gitroom/nestjs-libraries/extension/send-execution.service';
import {
  ClaimSendDto,
  QueueStoredReplyDto,
  SendOutcomeDto,
  EnqueueSendDto,
  StopSendDto,
  ReconcileSendDto,
} from '@gitroom/nestjs-libraries/extension/send-execution.dto';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';

@Controller('/sending/intents')
export class SendIntentsController {
  constructor(private readonly posts: PostsService, private readonly coordinator: SendCoordinatorService) {}
  @Post('/reply')
  @ApiOperation({ summary: 'Enqueue the current saved reply using sentReplyId and optional integrationId; duplicates return the original task' })
  reply(@GetOrgFromRequest() org: Organization, @GetUserFromRequest() user: User, @Body() body: QueueStoredReplyDto) { return this.coordinator.enqueueSavedReply(org.id, user.id, body.sentReplyId, body); }
  @Post()
  enqueue(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: EnqueueSendDto
  ) {
    return this.posts.queueStoredSend(org.id, body.rootPostId, user.id, body.publishMethod);
  }
}

@Controller('/extension/send-attempts')
export class SendExecutionsController {
  constructor(private readonly sends: SendExecutionService) {}
  private auth(
    org: Organization,
    user: User,
    headers: Record<string, string>
  ): NodeAuthentication {
    return {
      org: org.id,
      user: user.id,
      nodeId: headers['x-extension-node-id'],
      token: headers['x-extension-node-token'],
    };
  }
  @Post('/claim')
  claim(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Headers() headers: Record<string, string>,
    @Body() body: ClaimSendDto
  ) {
    return this.sends.claim(this.auth(org, user, headers), body);
  }
  @Post('/:id/renew')
  renew(@GetOrgFromRequest() org: Organization, @GetUserFromRequest() user: User, @Headers() headers: Record<string, string>, @Param('id') id: string) {
    return this.sends.renew(this.auth(org, user, headers), id, headers['x-send-lease-token']);
  }
  @Post('/:id/segments/:index/preflight')
  preflight(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
    @Param('index', ParseIntPipe) index: number
  ) {
    return this.sends.preflight(
      this.auth(org, user, headers),
      id,
      index,
      headers['x-send-lease-token']
    );
  }
  @Post('/:id/segments/:index/start')
  start(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
    @Param('index', ParseIntPipe) index: number
  ) {
    return this.sends.start(
      this.auth(org, user, headers),
      id,
      index,
      headers['x-send-lease-token']
    );
  }
  @Post('/:id/segments/:index/outcome')
  outcome(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
    @Param('index', ParseIntPipe) index: number,
    @Body() body: SendOutcomeDto
  ) {
    return this.sends.outcome(
      this.auth(org, user, headers),
      id,
      index,
      headers['x-send-lease-token'],
      body
    );
  }
  @Post('/:id/segments/:index/stop-confirmation')
  stop(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
    @Param('index', ParseIntPipe) index: number,
    @Body() body: StopSendDto
  ) {
    return this.sends.stop(
      this.auth(org, user, headers),
      id,
      index,
      headers['x-send-lease-token'],
      body
    );
  }
  @Get('/:id')
  status(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Headers() headers: Record<string, string>,
    @Param('id') id: string
  ) {
    return this.sends.status(
      this.auth(org, user, headers),
      id,
      headers['x-send-lease-token']
    );
  }
}

@Controller('/sending/executions')
export class SendReconciliationController {
  constructor(private readonly sends: SendCoordinatorService) {}
  @Get('/:id')
  get(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string
  ) {
    return this.sends.reconciliationView(org.id, user.id, id);
  }
  @Post('/:id/segments/:index/reconcile')
  reconcile(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Param('index', ParseIntPipe) index: number,
    @Body() body: ReconcileSendDto
  ) {
    const { expectedResolutionRevision, ...outcome } = body;
    return this.sends.reconcile(
      org.id,
      user.id,
      id,
      index,
      expectedResolutionRevision,
      outcome
    );
  }
}

@Controller('/extension/send-protocol')
export class SendProtocolController {
  constructor(private readonly modes: SendModeService) {}
  @Get()
  async get(@GetOrgFromRequest() org: Organization, @GetUserFromRequest() user: User) {
    const state = await this.modes.get(org.id, user.id);
    const controlled = state.mode === 'CONTROLLED';
    return { protocol: controlled ? 'ACCOUNT_BOUND_V1' : 'LEGACY',
      sendingMode: state.mode, modeRevision: state.revision,
      autonomousAllowed: state.autonomousAllowed,
      coordinationRequired: state.mode !== 'AUTONOMOUS', nodesEnabled: controlled,
      userId: user.id, organizationId: org.id, serverNow: new Date().toISOString() };
  }
}
