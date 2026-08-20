import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Organization } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { AutomationService } from '@gitroom/nestjs-libraries/automation/automation.service';
import {
  SaveAutomationEnabledDto,
  SaveAutomationPublishingDto,
  SaveAutomationRepliesDto,
} from '@gitroom/nestjs-libraries/automation/automation.dto';

/**
 * A project's Automation settings — scheduled publishing and managed replies.
 *
 * Every route names its project in the PATH, and that is load-bearing rather
 * than cosmetic: ProjectAuthGuard is a global guard that only activates on a
 * request carrying a `projectId`, so a route without one is authorized by org
 * membership alone. The endpoints this controller replaces
 * (`GET /operation-plans/:id`, `POST /posts/schedule { planId }`) carried none,
 * which left an org member able to read and activate a sibling project's plan —
 * and able to queue posts for a project that had been deactivated, despite the
 * guard's rule that a deactivated project stops producing new work.
 *
 * The guard's GET/mutation split lands correctly here for free: the overview
 * needs only project ACCESS (a deactivated project must stay readable so its
 * owner can inspect and re-enable it), while both writes require the project to
 * be ACTIVE.
 */
@ApiTags('Automation')
@Controller('/projects/:projectId/automation')
export class AutomationController {
  constructor(private _automationService: AutomationService) {}

  @ApiOperation({
    summary:
      "A project's whole Automation surface in one call: active plan + send-queue rollup, publishing platforms and effective time windows, managed-reply config and accounts, and the new-conversation count.",
  })
  @Get()
  getOverview(
    @GetOrgFromRequest() org: Organization,
    @Param('projectId') projectId: string
  ) {
    return this._automationService.getOverview(org, projectId);
  }

  @ApiOperation({
    summary:
      "The project's Automation master switch. Suspends both features without touching their configuration.",
  })
  @Post('/enabled')
  saveEnabled(
    @GetOrgFromRequest() org: Organization,
    @Param('projectId') projectId: string,
    @Body() body: SaveAutomationEnabledDto
  ) {
    return this._automationService.saveEnabled(org, projectId, body.enabled);
  }

  @ApiOperation({
    summary:
      'Save scheduled-publishing platforms and time windows; with `commit`, also queue the active plan for those platforms.',
  })
  @Post('/publishing')
  savePublishing(
    @GetOrgFromRequest() org: Organization,
    @Param('projectId') projectId: string,
    @Body() body: SaveAutomationPublishingDto
  ) {
    return this._automationService.savePublishing(org, projectId, body);
  }

  @ApiOperation({
    summary:
      'Save managed-reply settings: enable/mode, per-platform reply policy, and per-account reply authorization.',
  })
  @Post('/replies')
  saveReplies(
    @GetOrgFromRequest() org: Organization,
    @Param('projectId') projectId: string,
    @Body() body: SaveAutomationRepliesDto
  ) {
    return this._automationService.saveReplies(org, projectId, body);
  }
}
