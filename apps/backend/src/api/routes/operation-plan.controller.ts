import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization } from '@prisma/client';
import { OperationPlanService } from '@gitroom/nestjs-libraries/database/prisma/operation-plan/operation-plan.service';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { ArrayNotEmpty, IsArray, IsISO8601, IsOptional, IsString } from 'class-validator';

export class CreateOperationPlanDto {
  @IsString()
  taskId!: string;

  @IsISO8601({ strict: true })
  startAt!: string;

  @IsISO8601({ strict: true })
  endAt!: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  platforms!: string[];

  // Optional curated Engage keyword set for the plan's reply policies. When
  // non-empty these are used verbatim; when omitted/empty the generator falls
  // back to the product snapshot's keywords.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  keywords?: string[];
}

@ApiTags('Operation Plans')
@Controller()
export class OperationPlanController {
  constructor(private _operationPlanService: OperationPlanService) {}

  // Everything a plan overview page needs in one call: the plan itself, every
  // Post generated under it, and a per-day/per-keyword engage reply-pacing
  // breakdown ("actual/target" strings, project-scoped-post-engage-
  // design.md §6). Org-scoped only (no @UseGuards) — the plan row itself
  // carries organizationId, and ProjectAuthGuard only activates when a
  // request explicitly carries projectId, which this route does not.
  @Get('/operation-plans/:id')
  getOverview(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._operationPlanService.getOverview(org.id, id);
  }

  // `?dryRun=true` returns the generated + validated plan WITHOUT billing,
  // persistence, or Post materialization — a preview to eyeball generation
  // quality before committing credits + DB rows. Any other value runs the real
  // flow. The LLM generation call still runs (real token cost), but no user
  // credit is deducted and nothing is written.
  @Post('/projects/:projectId/operation-plans')
  create(
    @GetOrgFromRequest() org: Organization,
    @Param('projectId') projectId: string,
    @Body() body: CreateOperationPlanDto,
    @Query('dryRun') dryRun?: string
  ) {
    return this._operationPlanService.create(org.id, projectId, body, {
      dryRun: dryRun === 'true' || dryRun === '1',
    });
  }
}
