import { BadRequestException, Injectable } from '@nestjs/common';
import { Organization } from '@prisma/client';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { OperationPlanService } from '@gitroom/nestjs-libraries/database/prisma/operation-plan/operation-plan.service';
import { EngageService } from '@gitroom/nestjs-libraries/engage/engage.service';
import { EngageRepository } from '@gitroom/nestjs-libraries/engage/engage.repository';
import {
  ProjectPublishingService,
  type ResolvedProjectPublishing,
} from '@gitroom/nestjs-libraries/automation/project-publishing.service';
import { PublishPlatform } from '@gitroom/helpers/extension/post-publish';
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
    const [config, publishing, lastPublishedAt] = await Promise.all([
      this._engageRepository.getConfigCore(org.id, projectId),
      this._projectPublishing.resolve(org.id, projectId),
      this._postsService.getLastPublishedAt(org.id, projectId),
    ]);

    // Resolved once so the hoisted default and the per-window overrides below
    // can never disagree about what "the common zone" is.
    const commonTimezone = resolveCommonTimezone(publishing.windows);

    const settings = readEngageConfigMetadata(config);
    const storedPolicies = settings.replyPolicies as Record<
      string,
      Record<string, unknown>
    >;

    return {
      projectId,
      // The master switch. Everything below it is only reachable when this is on
      // — the client should render the two feature panels as inert, not as off,
      // when it is not.
      enabled: publishing.automationEnabled,
      // When this project last actually published something (ISO), or null if it
      // never has. A real timestamp rather than a "checked N minutes ago" —
      // there is no polling clock to report, and the page previously showed a
      // hardcoded "Just now" beside a hardcoded "next action" countdown, neither
      // of which was measuring anything.
      lastPublishedAt: lastPublishedAt ? lastPublishedAt.toISOString() : null,
      publishing: {
        // The feature switch ALONE — deliberately not ANDed with the master, so
        // a client can show "publishing is on, Automation is off overall"
        // instead of losing the user's setting the moment the master goes off.
        // `active` is just `overview.enabled && this`, which the client can do.
        enabled: publishing.publishingEnabled,
        // The zone every window below is expressed in, unless that window says
        // otherwise. Hoisted because the project writes ONE zone for all its
        // platforms (the browser's), so repeating it per platform was the same
        // string seven times. Absent when the windows genuinely disagree — an
        // admin can pin a different zone per platform — in which case each
        // window carries its own and there is no meaningful default to state.
        ...(commonTimezone !== undefined ? { timezone: commonTimezone } : {}),
        // ONE entry per platform, carrying both halves of that platform's state.
        // They used to be a `platforms` array beside a `windows` map, which the
        // client had to cross-reference — and the array was a lossy projection
        // of the same information.
        platforms: buildPublishingPlatforms(publishing, commonTimezone),
      },
      replies: {
        // Engage's OWN switch, which also gates scanning and is changeable from
        // the Engage page. Kept because it independently gates replying: with it
        // off, nothing is driven no matter what the mode says — so a client that
        // only knew the mode could not explain why replies are idle.
        enabled: config?.enabled ?? false,
        // Carries the feature switch AND the review/auto distinction, so a
        // separate `repliesEnabled` boolean would just be `!== 'off'` restated.
        autoReplyMode: settings.autoReplyMode,
        // ONE entry per platform, same shape rationale as publishing above.
        //
        // Connected reply ACCOUNTS are deliberately absent, because Automation
        // does not pick an account at all: it sends through the extension's own
        // browser session, so the identity is whoever the user is already
        // signed in as. Choosing a specific account is a per-post edit, on a
        // different surface.
        //
        // Two smaller confirmations of the same conclusion:
        // `IntegrationProject.engageEnabled` is never read by any gate (the
        // reply driver does not filter on it, and pickXReplyIntegration matches
        // by handle and ignores it), and this page had no per-account control to
        // set it with — so listing accounts here only invited a managed-reply
        // save to write an Engage-owned flag on every account at once.
        platforms: stripPublishingKeys(storedPolicies),
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
   * Save the managed-reply half: the config flags and the per-platform reply
   * policy.
   *
   * Per-ACCOUNT authorization is not part of this. Automation sends through the
   * extension's own browser session and never picks an account, so there is
   * nothing to authorize here; choosing a specific account is a per-post edit on
   * a different surface. Writing `IntegrationProject.engageEnabled` from here
   * meant a managed-reply save silently reached into an Engage setting that no
   * gate even reads.
   */
  async saveReplies(
    org: Organization,
    projectId: string,
    dto: SaveAutomationRepliesDto
  ) {
    if (
      dto.enabled === undefined &&
      dto.autoReplyMode === undefined &&
      dto.policies === undefined
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

    return { saved: true as const };
  }

}

/**
 * One entry per platform, merging the switch decision with the effective window.
 *
 * A platform appears when the project has decided about it OR an effective
 * window resolves for it (which includes admin-configured windows the project
 * never touched — those must stay visible, or the UI would show its default
 * hours for a platform the admin has actually restricted).
 *
 * `enabled` is ABSENT when the project has never decided for that platform,
 * which is what replaces the old project-level `configured` flag: a client that
 * finds no `enabled` anywhere knows the panel has never been configured.
 */
/**
 * The one timezone every effective window shares, or `undefined` when they
 * differ (or when none carries a zone at all). Only a unanimous zone can be
 * stated as a default — anything else would make some window read as being in a
 * zone it is not enforced in, which is precisely the class of bug that made the
 * publishing dialog show the wrong hours.
 */
function resolveCommonTimezone(
  windows: ResolvedProjectPublishing['windows']
): string | undefined {
  const entries = Object.values(windows).filter(Boolean);
  if (!entries.length) return undefined;
  // A window with NO zone is not "unset", it is UTC — so it does not agree with
  // a sibling that names one, and hoisting that sibling's zone would state the
  // wrong zone for it. Only a set that is unanimous AND fully explicit can be
  // stated as a default.
  const zones = new Set(entries.map((window) => window!.timezone ?? ''));
  if (zones.size !== 1) return undefined;
  const [only] = [...zones];
  return only || undefined;
}

function buildPublishingPlatforms(
  publishing: ResolvedProjectPublishing,
  commonTimezone: string | undefined
) {
  const platforms = new Set<string>([
    ...Object.keys(publishing.platformDecisions),
    ...Object.keys(publishing.windows),
  ]);
  const out: Record<
    string,
    { enabled?: boolean; window?: { start: string; end: string; timezone?: string } }
  > = {};
  for (const platform of platforms) {
    const decision = publishing.platformDecisions[platform];
    const window = publishing.windows[platform as PublishPlatform];
    out[platform] = {
      ...(decision !== undefined ? { enabled: decision } : {}),
      ...(window
        ? {
            window: {
              start: window.windowStart,
              end: window.windowEnd,
              // Stated only when it differs from the hoisted default, so the
              // common case carries the zone once instead of once per platform.
              ...(window.timezone && window.timezone !== commonTimezone
                ? { timezone: window.timezone }
                : {}),
            },
          }
        : {}),
    };
  }
  return out;
}

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
