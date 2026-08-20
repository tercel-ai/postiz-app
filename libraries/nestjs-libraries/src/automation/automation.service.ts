import { BadRequestException, Injectable } from '@nestjs/common';
import { Organization } from '@prisma/client';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { OperationPlanService } from '@gitroom/nestjs-libraries/database/prisma/operation-plan/operation-plan.service';
import { EngageService } from '@gitroom/nestjs-libraries/engage/engage.service';
import { EngageRepository } from '@gitroom/nestjs-libraries/engage/engage.repository';
import {
  isPublishingActive,
  ProjectPublishingService,
} from '@gitroom/nestjs-libraries/automation/project-publishing.service';
import {
  EngagePlatformPolicy,
  readEngageConfigMetadata,
} from '@gitroom/nestjs-libraries/engage/engage-config-metadata';
import {
  SaveAutomationPublishingDto,
  SaveAutomationRepliesDto,
} from '@gitroom/nestjs-libraries/automation/automation.dto';
import { EXTENSION_PUBLISHABLE_PLATFORMS } from '@gitroom/helpers/extension/post-publish';

/**
 * The four keys the publishing half owns inside the shared
 * `EngageConfig.replyPolicies` blob. Named once so both writers can be exact
 * about which keys they may touch — the reply half must preserve these, and
 * the publishing half must preserve everything that is NOT one of these.
 */
const PUBLISHING_POLICY_KEYS = [
  'publishingEnabled',
  'publishingWindowStart',
  'publishingWindowEnd',
  'publishingTimezone',
] as const;

/**
 * One project's Automation surface.
 *
 * Exists to give the Automation page a single project-scoped entry point in
 * place of the five org-scoped calls it used to fan out (two of which —
 * `GET /operation-plans/:id` and `POST /posts/schedule` — carried no projectId
 * at all and so were never authorized against the project they were acting on).
 * Every route that reaches this service names its project in the URL, which is
 * what lets ProjectAuthGuard authorize the request before the handler runs.
 */
@Injectable()
export class AutomationService {
  constructor(
    private readonly _postsService: PostsService,
    private readonly _operationPlanService: OperationPlanService,
    private readonly _engageService: EngageService,
    private readonly _engageRepository: EngageRepository,
    private readonly _projectPublishing: ProjectPublishingService
  ) {}

  /**
   * Everything the Automation page renders, in one call.
   *
   * Deliberately NOT built out of the endpoints it replaces: the plan side
   * reads a rollup instead of every post of the plan (the page shows four
   * numbers), and the engage side reads the bare config row instead of the
   * fully decorated `GET /engage/config` (which resolves entitlements and a
   * scan cursor per keyword, channel and tracked account — none of it shown
   * here).
   */
  async getOverview(org: Organization, projectId: string) {
    const [{ id: planId }, config, publishing, accounts] = await Promise.all([
      this._operationPlanService.getActivePlanId(org.id, projectId),
      this._engageRepository.getConfigCore(org.id, projectId),
      this._projectPublishing.resolve(org.id, projectId),
      this._engageService.listReplyAccounts(org, projectId),
    ]);

    const queue = planId
      ? this._summarizeQueue(
          await this._postsService.getPlanPublishingQueue(org.id, planId)
        )
      : EMPTY_QUEUE;

    const settings = readEngageConfigMetadata(config);
    const storedPolicies = settings.replyPolicies as Record<
      string,
      Record<string, unknown>
    >;

    const repliesEnabled = settings.autoReplyMode !== 'off';

    return {
      projectId,
      // The master switch. Everything below it is only reachable when this is on
      // — the client should render the two feature panels as inert, not as off,
      // when it is not.
      enabled: publishing.automationEnabled,
      plan: planId ? { id: planId, queue } : null,
      publishing: {
        // `enabledPlatforms: null` = never configured. Reported as `configured:
        // false` with an empty list rather than as "everything is on", because
        // the two differ only in intent and the client needs to tell them apart
        // to render an unconfigured panel differently from an all-off one.
        configured: publishing.enabledPlatforms !== null,
        // The feature switch ALONE — deliberately not ANDed with the master.
        // A client has to be able to show "publishing is on, but Automation is
        // off overall", and collapsing the two would lose the user's setting the
        // moment the master goes off.
        enabled: publishing.publishingEnabled,
        // Whether `enabled` is an explicit choice or the legacy derived rule.
        enabledConfigured: publishing.publishingConfigured,
        // The AND chain, precomputed: master AND feature. What the client should
        // use to answer "is publishing actually going to run".
        active: isPublishingActive(publishing),
        platforms: publishing.enabledPlatforms ?? [],
        // EFFECTIVE windows — the project's own override already layered onto
        // the admin-level setting. The page previously echoed back only what it
        // had stored, which is why an admin-imposed window was invisible there.
        windows: Object.fromEntries(
          Object.entries(publishing.windows).map(([platform, window]) => [
            platform,
            {
              start: window!.windowStart,
              end: window!.windowEnd,
              ...(window!.timezone ? { timezone: window!.timezone } : {}),
            },
          ])
        ),
      },
      replies: {
        // The Engage feature's own switch — it also gates SCANNING, which the
        // Automation switches deliberately leave alone (see saveReplies).
        enabled: config?.enabled ?? false,
        autoReplyMode: settings.autoReplyMode,
        // The managed-replies feature switch. Not a separate column: the mode IS
        // the switch, so there is only one answer to "does this project reply
        // unattended".
        repliesEnabled,
        // The AND chain, precomputed: master AND feature.
        active: publishing.automationEnabled && repliesEnabled,
        // Reply-side keys only: the publishing keys sharing this column are
        // reported under `publishing` above, and returning them twice would
        // invite a client to write them back through the wrong endpoint.
        policies: stripPublishingKeys(storedPolicies),
        accounts: accounts.map((account: any) => ({
          id: account.id,
          name: account.name,
          picture: account.picture,
          providerIdentifier: account.providerIdentifier,
          engageEnabled: account.engageEnabled,
        })),
      },
    };
  }

  /**
   * Save which platforms this project publishes to and when, optionally
   * committing the active plan in the same call.
   *
   * Writes through the repository rather than `EngageService.saveConfig` on
   * purpose: that method starts the global Engage workflows and kicks an
   * immediate scan whenever it is handed `enabled`. Publishing settings have
   * no business doing either, and routing them through the same door is how a
   * publishing toggle would end up starting a scan.
   */
  async savePublishing(
    org: Organization,
    projectId: string,
    dto: SaveAutomationPublishingDto
  ) {
    const requested = new Set(dto.platforms.map((p) => p.toLowerCase()));
    const existing = readEngageConfigMetadata(
      await this._engageRepository.getConfigCore(org.id, projectId)
    ).replyPolicies as Record<string, Record<string, unknown>>;
    const policies: Record<string, Record<string, unknown>> = { ...existing };

    // The universe every platform gets an explicit true/false for. Union of the
    // publishable set, whatever the project already had an opinion on, and what
    // this request names — so the stored enabled set ends up EXACTLY equal to
    // `platforms`, with no platform left in an undecided middle state.
    const universe = new Set<string>([
      ...EXTENSION_PUBLISHABLE_PLATFORMS,
      ...Object.keys(existing).map((p) => p.toLowerCase()),
      ...requested,
    ]);

    for (const platform of universe) {
      const window = dto.windows?.[platform];
      policies[platform] = {
        ...(policies[platform] ?? {}),
        publishingEnabled: requested.has(platform),
        ...(window
          ? {
              publishingWindowStart: window.start,
              publishingWindowEnd: window.end,
              ...(window.timezone ? { publishingTimezone: window.timezone } : {}),
            }
          : {}),
      };
    }

    await this._engageRepository.saveConfig(
      org.id,
      {
        metadata: {
          replyPolicies: policies as Record<string, EngagePlatformPolicy>,
          ...(dto.enabled !== undefined && { publishingEnabled: dto.enabled }),
        },
      },
      projectId
    );

    if (!dto.commit) {
      return { saved: true, scheduled: null };
    }

    // The plan id is resolved SERVER-side from the project. The client never
    // names a plan, so there is no plan id for it to get wrong — or to borrow
    // from another project.
    const { id: planId } = await this._operationPlanService.getActivePlanId(
      org.id,
      projectId
    );
    if (!planId) {
      // Not an error: choosing publishing platforms is configuration, and a
      // project is allowed to configure it before it has ever generated a plan.
      return { saved: true, scheduled: null };
    }

    const scheduled = await this._postsService.schedulePlanPosts(
      org.id,
      planId,
      projectId,
      dto.publishMethod,
      dto.platforms
    );
    return { saved: true, scheduled };
  }

  /**
   * The project's Automation master switch.
   *
   * Writes ONLY that column: the two feature switches and every platform
   * selection under them keep their values, so flipping the master off and back
   * on restores exactly the configuration that was there before. That is the
   * whole point of a master switch — it suspends, it does not reset.
   *
   * Routed through the repository rather than EngageService.saveConfig for the
   * same reason savePublishing is: that method starts the global Engage
   * workflows and kicks a scan whenever it is handed `enabled`, and a master
   * switch has no business doing either.
   */
  async saveEnabled(org: Organization, projectId: string, enabled: boolean) {
    await this._engageRepository.saveConfig(
      org.id,
      { metadata: { automationEnabled: enabled } },
      projectId
    );
    return { saved: true as const, enabled };
  }

  /**
   * Save the managed-reply half: config flags, per-platform reply policy, and
   * per-account reply authorization — in one call instead of one request per
   * account plus a separate config write.
   */
  async saveReplies(
    org: Organization,
    projectId: string,
    dto: SaveAutomationRepliesDto
  ) {
    if (
      dto.enabled === undefined &&
      dto.autoReplyMode === undefined &&
      dto.policies === undefined &&
      !dto.accounts?.length
    ) {
      throw new BadRequestException('Nothing to update');
    }

    if (dto.policies) {
      const existing = readEngageConfigMetadata(
        await this._engageRepository.getConfigCore(org.id, projectId)
      ).replyPolicies as Record<string, Record<string, unknown>>;
      // Merge per platform, and drop any publishing key the caller tried to
      // send: publishing settings are owned by the other endpoint, and letting
      // them in here would reintroduce exactly the cross-module clobbering this
      // split exists to end.
      const merged: Record<string, Record<string, unknown>> = { ...existing };
      for (const [platform, policy] of Object.entries(dto.policies)) {
        const key = platform.toLowerCase();
        merged[key] = {
          ...(merged[key] ?? {}),
          ...stripPublishingKeysFromPolicy(policy),
        };
      }
      await this._engageService.saveConfig(org, {
        projectId,
        ...(dto.enabled !== undefined && { enabled: dto.enabled }),
        ...(dto.autoReplyMode !== undefined && {
          autoReplyMode: dto.autoReplyMode,
        }),
        replyPolicies: merged,
      } as any);
    } else if (dto.enabled !== undefined || dto.autoReplyMode !== undefined) {
      await this._engageService.saveConfig(org, {
        projectId,
        ...(dto.enabled !== undefined && { enabled: dto.enabled }),
        ...(dto.autoReplyMode !== undefined && {
          autoReplyMode: dto.autoReplyMode,
        }),
      } as any);
    }

    // Sequential, not Promise.all: these are upserts on the same
    // (integration, project) table and a batch is small. Reporting one
    // aggregate outcome beats N independent promises whose partial failure the
    // caller could not act on.
    const accounts: { integrationId: string; engageEnabled: boolean }[] = [];
    for (const account of dto.accounts ?? []) {
      await this._engageService.upsertReplyAccountSettings(
        org,
        account.integrationId,
        { projectId, engageEnabled: account.engageEnabled }
      );
      accounts.push(account);
    }

    return { saved: true, accounts: accounts.length };
  }

  /**
   * Four numbers the Automation page shows about the send queue. "Ready" means
   * the post has a body and a resolved platform; anything else needs a human
   * before it can go out.
   */
  private _summarizeQueue(
    posts: {
      id: string;
      providerIdentifier: string | null;
      content: string | null;
    }[]
  ) {
    const platforms = new Set<string>();
    let readyPosts = 0;
    for (const post of posts) {
      const platform = post.providerIdentifier?.toLowerCase();
      if (platform) platforms.add(platform);
      // Strip tags before testing for emptiness: a materialized post whose body
      // is `<p></p>` is empty to a reader and must not count as ready.
      const body = (post.content ?? '').replace(/<[^>]*>/g, '').trim();
      if (body && platform) readyPosts++;
    }
    return {
      totalPosts: posts.length,
      readyPosts,
      attentionPosts: posts.length - readyPosts,
      platforms: [...platforms],
    };
  }
}

const EMPTY_QUEUE = {
  totalPosts: 0,
  readyPosts: 0,
  attentionPosts: 0,
  platforms: [] as string[],
};

function stripPublishingKeysFromPolicy(
  policy: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(policy ?? {})) {
    if ((PUBLISHING_POLICY_KEYS as readonly string[]).includes(key)) continue;
    out[key] = value;
  }
  return out;
}

function stripPublishingKeys(
  policies: Record<string, Record<string, unknown>>
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [platform, policy] of Object.entries(policies ?? {})) {
    if (!policy || typeof policy !== 'object') continue;
    out[platform] = stripPublishingKeysFromPolicy(policy);
  }
  return out;
}
