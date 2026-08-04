import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AgenciesService } from '@gitroom/nestjs-libraries/database/prisma/agencies/agencies.service';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { TrackService } from '@gitroom/nestjs-libraries/track/track.service';
import { RealIP } from 'nestjs-real-ip';
import { UserAgent } from '@gitroom/nestjs-libraries/user/user.agent';
import { TrackEnum } from '@gitroom/nestjs-libraries/user/track.enum';
import { Request, Response } from 'express';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { getCookieUrlFromDomain } from '@gitroom/helpers/subdomain/subdomain.management';
import { AgentGraphInsertService } from '@gitroom/nestjs-libraries/agent/agent.graph.insert.service';
import { Nowpayments } from '@gitroom/nestjs-libraries/crypto/nowpayments';
import { SettingsService } from '@gitroom/nestjs-libraries/database/prisma/settings/settings.service';
import { EngageEntitlementService } from '@gitroom/nestjs-libraries/engage/engage-entitlement.service';
import { EngageScanConfigService } from '@gitroom/nestjs-libraries/engage/engage-scan-config.service';
import { PostOverageService } from '@gitroom/nestjs-libraries/database/prisma/posts/post-overage.service';
import { PostPlanLimitsService } from '@gitroom/nestjs-libraries/database/prisma/posts/post-plan-limits.service';
import { Readable, pipeline } from 'stream';
import { promisify } from 'util';

const pump = promisify(pipeline);

@ApiTags('Public')
@Controller('/public')
export class PublicController {
  constructor(
    private _agenciesService: AgenciesService,
    private _trackService: TrackService,
    private _agentGraphInsertService: AgentGraphInsertService,
    private _postsService: PostsService,
    private _nowpayments: Nowpayments,
    private _settingsService: SettingsService,
    private _engageEntitlement: EngageEntitlementService,
    private _engageScanConfig: EngageScanConfigService,
    private _postOverage: PostOverageService,
    private _postPlanLimits: PostPlanLimitsService
  ) {}

  /**
   * Public plan catalog for pricing/marketing pages, one entry per tier:
   * - engage: keywords / tracked accounts / monitored channels caps (org-wide
   *   and per-project), scan interval, monthly reply cap, metrics window.
   *   `null` = unlimited.
   * - posts: free posts per billing period + channel cap from the
   *   `post_plan_limits` Settings map. `null` = not configured in Postiz
   *   (the aisee-core package value applies).
   * Plus reply credit pricing, the per-post overage cost, and the platforms
   * engage scanning currently covers. No org, usage, or billing state — safe
   * without authentication.
   */
  @Get('/plans')
  async getPlans() {
    const [catalog, scanPlatforms, postLimits, postOverageCost] =
      await Promise.all([
        this._engageEntitlement.getPublicPlanCatalog(),
        this._engageScanConfig.getSupportedScanPlatforms(),
        this._postPlanLimits.getAll(),
        this._postOverage.getOverageCost(),
      ]);
    return {
      plans: catalog.plans.map(({ code, limits }) => ({
        code,
        engage: limits,
        posts: postLimits[code],
      })),
      replyCredits: catalog.replyCredits,
      postOverageCost,
      scanPlatforms,
    };
  }

  @Get('/extension/latest')
  async getExtensionLatest() {
    const [chrome, firefox] = await Promise.all([
      this._settingsService.get<Record<string, string>>('extension.chrome'),
      this._settingsService.get<Record<string, string>>('extension.firefox'),
    ]);
    return { chrome: chrome ?? null, firefox: firefox ?? null };
  }

  @Post('/agent')
  async createAgent(@Body() body: { text: string; apiKey: string }) {
    if (
      !body.apiKey ||
      !process.env.AGENT_API_KEY ||
      body.apiKey !== process.env.AGENT_API_KEY
    ) {
      return;
    }
    return this._agentGraphInsertService.newPost(body.text);
  }

  @Get('/agencies-list')
  async getAgencyByUser() {
    return this._agenciesService.getAllAgencies();
  }

  @Get('/agencies-list-slug')
  async getAgencySlug() {
    return this._agenciesService.getAllAgenciesSlug();
  }

  @Get('/agencies-information/:agency')
  async getAgencyInformation(@Param('agency') agency: string) {
    return this._agenciesService.getAgencyInformation(agency);
  }

  @Get('/agencies-list-count')
  async getAgenciesCount() {
    return this._agenciesService.getCount();
  }

  @Get(`/posts/:id`)
  async getPreview(@Param('id') id: string) {
    const posts = await this._postsService.getPostsRecursively(id, true);
    if (!posts.length) {
      return [];
    }

    return posts.map(({ childrenPost, ...p }) => ({
      ...p,
      ...(p.integration
        ? {
            integration: {
              id: p.integration.id,
              name: p.integration.name,
              picture: p.integration.picture,
              providerIdentifier: p.integration.providerIdentifier,
              profile: p.integration.profile,
            },
          }
        : {}),
    }));
  }

  @Get(`/posts/:id/comments`)
  async getComments(@Param('id') postId: string) {
    return { comments: await this._postsService.getComments(postId) };
  }

  @Post('/t')
  async trackEvent(
    @Res() res: Response,
    @Req() req: Request,
    @RealIP() ip: string,
    @UserAgent() userAgent: string,
    @Body()
    body: { fbclid?: string; tt: TrackEnum; additional: Record<string, any> }
  ) {
    const uniqueId = req?.cookies?.track || makeId(10);
    const fbclid = req?.cookies?.fbclid || body.fbclid;
    await this._trackService.track(
      uniqueId,
      ip,
      userAgent,
      body.tt,
      body.additional,
      fbclid
    );
    if (!req.cookies.track) {
      res.cookie('track', uniqueId, {
        domain: getCookieUrlFromDomain(process.env.FRONTEND_URL!),
        ...(!process.env.NOT_SECURED
          ? {
              secure: true,
              httpOnly: true,
            }
          : {}),
        sameSite: 'none',
        expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
      });
    }

    if (body.fbclid && !req.cookies.fbclid) {
      res.cookie('fbclid', body.fbclid, {
        domain: getCookieUrlFromDomain(process.env.FRONTEND_URL!),
        ...(!process.env.NOT_SECURED
          ? {
              secure: true,
              httpOnly: true,
            }
          : {}),
        sameSite: 'none',
        expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
      });
    }

    res.status(200).json({
      track: uniqueId,
    });
  }

  @Post('/crypto/:path')
  async cryptoPost(@Body() body: any, @Param('path') path: string) {
    console.log('cryptoPost', body, path);
    return this._nowpayments.processPayment(path, body);
  }

  @Get('/stream')
  async streamFile(
    @Query('url') url: string,
    @Res() res: Response,
    @Req() req: Request
  ) {
    if (!url.endsWith('mp4')) {
      return res.status(400).send('Invalid video URL');
    }

    const ac = new AbortController();
    const onClose = () => ac.abort();
    req.on('aborted', onClose);
    res.on('close', onClose);

    const r = await fetch(url, { signal: ac.signal });

    if (!r.ok && r.status !== 206) {
      res.status(r.status);
      throw new Error(`Upstream error: ${r.statusText}`);
    }

    const type = r.headers.get('content-type') ?? 'application/octet-stream';
    res.setHeader('Content-Type', type);

    const contentRange = r.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);

    const len = r.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);

    const acceptRanges = r.headers.get('accept-ranges') ?? 'bytes';
    res.setHeader('Accept-Ranges', acceptRanges);

    if (r.status === 206) res.status(206); // Partial Content for range responses

    try {
      await pump(Readable.fromWeb(r.body as any), res);
    } catch (err) {
    }
  }
}
