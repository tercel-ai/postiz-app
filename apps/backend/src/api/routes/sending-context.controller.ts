import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Organization, User } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { SendingContextService } from '@gitroom/backend/services/sending-context.service';

@ApiTags('Sending')
@Controller('/projects/:projectId/sending-context')
export class SendingContextController {
  constructor(private readonly context: SendingContextService) {}

  @Get()
  @ApiOperation({ summary: 'Initialize Project defaults and Post/Reply account pickers, including reported node sessions' })
  get(@GetOrgFromRequest() org: Organization, @GetUserFromRequest() user: User,
    @Param('projectId') projectId: string) {
    return this.context.get(org.id, user.id, projectId);
  }
}
