import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { EngageService } from '@gitroom/nestjs-libraries/engage/engage.service';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { AdminEngageQueryDto } from '@gitroom/nestjs-libraries/dtos/admin/admin-engage-query.dto';
import {
  AdminOpportunityDeleteBodyDto,
  AdminOpportunityQueryDto,
  AdminOpportunityUrlBodyDto,
} from '@gitroom/nestjs-libraries/dtos/admin/admin-engage-opportunity.dto';
import { SuperAdmin } from '@gitroom/backend/services/auth/admin/super-admin.decorator';
import { resolveOrganizationId } from '@gitroom/backend/admin-api/admin.utils';

@ApiTags('Admin')
@Controller('/admin/engage')
@SuperAdmin()
export class AdminEngageController {
  constructor(
    private _engageService: EngageService,
    private _organizationService: OrganizationService,
  ) {}

  // Paginated, cross-org list of Engage replies. Optional org/user scoping plus
  // platform/state filters — mirrors GET /admin/posts.
  @Get('/sent')
  async list(@Query() query: AdminEngageQueryDto) {
    const { organizationId, empty } = await resolveOrganizationId(
      this._organizationService,
      query.organizationId,
      query.userId,
    );
    if (empty) {
      return {
        results: [],
        total: 0,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: 0,
      };
    }
    return this._engageService.listSentRepliesForAdmin({
      page: query.page,
      pageSize: query.pageSize,
      organizationId,
      platform: query.platform,
      externalPostUrl: query.externalPostUrl,
      state: query.state,
      sortOrder: query.sortOrder,
    });
  }

  // ── Broken-address triage ──────────────────────────────────────────────────
  // Opportunities whose stored address is a post LIST rather than a post, which
  // is why every reply against them failed. Repairing an address REQUIRES the
  // browser extension — LinkedIn post pages are members-only, so no server-side
  // job can re-resolve them. These endpoints supply the rows and take the
  // extension's verified results. See docs/admin-engage-opportunities.md.

  @Get('/opportunities')
  async listOpportunities(@Query() query: AdminOpportunityQueryDto) {
    return this._engageService.listOpportunitiesForAdmin({
      platform: query.platform,
      page: query.page,
      pageSize: query.pageSize,
      onlyBrokenUrls: query.onlyBrokenUrls,
    });
  }

  @Patch('/opportunities/url')
  async repairOpportunityUrls(@Body() body: AdminOpportunityUrlBodyDto) {
    // Re-validated here even though the extension only sends addresses it
    // resolved against LinkedIn itself: a client is never where a data
    // invariant is enforced, and writing a list page back would recreate the
    // exact bug this whole flow exists to undo.
    const bad = body.items.filter((i) => !isSinglePostAddress(i.externalPostUrl));
    if (bad.length) {
      throw new BadRequestException(
        `Not single-post addresses: ${bad.map((b) => b.externalPostUrl).join(', ')}`,
      );
    }
    return this._engageService.repairOpportunityUrlsForAdmin(body.items);
  }

  @Delete('/opportunities')
  async deleteOpportunities(@Body() body: AdminOpportunityDeleteBodyDto) {
    // No "has no replies" filter is trusted from the caller — the service
    // re-checks every id at delete time. See deleteOpportunitiesForAdmin.
    return this._engageService.deleteOpportunitiesForAdmin(body.ids);
  }
}

/**
 * Does this address point at ONE post?
 *
 * Rejects the entity-page sections that the broken rows hold
 * (…/company/<slug>/posts/ and the school/showcase equivalents) — a post LIST,
 * which has no comment box. Everything else that is a plain http(s) URL is
 * allowed through: platforms other than LinkedIn are repaired by this endpoint
 * too, and their address shapes are not LinkedIn's to judge.
 */
function isSinglePostAddress(raw: string): boolean {
  const url = String(raw ?? '').trim();
  if (!/^https?:\/\//i.test(url)) return false;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  return !/^\/(?:company|school|showcase)\//i.test(path);
}
