import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Organization } from '@prisma/client';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { OperationPlanService } from '@gitroom/nestjs-libraries/database/prisma/operation-plan/operation-plan.service';
import { EngageService } from '@gitroom/nestjs-libraries/engage/engage.service';
import { EngageRepository } from '@gitroom/nestjs-libraries/engage/engage.repository';
import {
  isPublishingActive,
  ProjectPublishingService,
  type ResolvedProjectPublishing,
} from '@gitroom/nestjs-libraries/automation/project-publishing.service';
import { PublishPlatform } from '@gitroom/helpers/extension/post-publish';
import {
  AutoReplyMode,
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
/**
 * The mode a project resumes on when replying is switched back on and it has no
 * stored preference to resume — `review` rather than `auto`, because the mode
 * decides whether a reply reaches a real audience without a human seeing it, and
 * a default must never be the irreversible one. Same reason
 * `readEngageConfigMetadata` resolves an absent mode to `off`.
 */
const DEFAULT_AUTO_REPLY_MODE = 'review' as const;

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
  private readonly logger = new Logger(AutomationService.name);

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
        // Engage's post-SCAN switch — whether opportunities are discovered at
        // all. Reported for DIAGNOSIS only: it belongs to the Engage page, and
        // the Automation page must not render it as a control. Two toggles for
        // what a user experiences as one decision is what made "replying is on
        // but nothing happens" possible, and `saveReplies` now turns scanning on
        // with replying so this page never has to ask about it.
        //
        // Still transmitted because the one state this page cannot cause — the
        // Engage page switching scanning off under an active reply config — is
        // otherwise unexplainable here: replies would read as on and be idle.
        scanEnabled: config?.enabled ?? false,
        // The switch this page owns, and — read-only — the mode it is running
        // in. See `splitAutoReplyMode`.
        ...splitAutoReplyMode(settings.autoReplyMode),
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

    // Realign BEFORE committing, not after: this is the pass that knows about
    // the minimum gap between posts, and schedulePlanPosts' own per-post pass
    // leaves anything already inside its window alone — so aligning first is
    // what carries the spacing through into QUEUE. Unconditional because a
    // window edit is exactly when a realignment is due, and the alignment only
    // touches posts that are OUTSIDE their window, so a save that changed
    // nothing relevant moves nothing.
    //
    // No planId: a superseded plan's drafts are soft-deleted, so "this
    // project's DRAFT plan posts" is already the active plan's.
    const rescheduled = await this._realign(org.id, projectId);

    if (!dto.commit) {
      return { saved: true, scheduled: null, rescheduled };
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
      return { saved: true, scheduled: null, rescheduled };
    }

    const scheduled = await this._postsService.schedulePlanPosts(
      org.id,
      planId,
      projectId,
      dto.publishMethod,
      dto.platforms
    );
    return { saved: true, scheduled, rescheduled };
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
    // Read before writing so the OFF→ON transition is visible. Only that
    // direction realigns: turning Automation off is a suspension, and a
    // suspended project's schedule must survive untouched so turning it back on
    // restores what was there.
    const wasActive = isPublishingActive(
      await this._projectPublishing.resolve(org.id, projectId)
    );

    await this._engageRepository.saveConfig(
      org.id,
      { metadata: { automationEnabled: enabled } },
      projectId
    );

    // `enabled` is only the master switch — the feature switch below it decides
    // whether publishing is actually on, which is what alignPlanDraftPublishDates
    // re-checks for itself. Calling it on every ON is therefore safe; this guard
    // just avoids the read when nothing can have changed.
    const rescheduled =
      enabled && !wasActive ? await this._realign(org.id, projectId) : null;

    return { saved: true as const, enabled, rescheduled };
  }

  /**
   * Re-align this project's plan posts with its publish time windows — the
   * DRAFTs first, then the already-QUEUED ones.
   *
   * DRAFTs first because the QUEUE pass measures the minimum gap against them:
   * placing a queued post next to a draft that is itself about to move would
   * space it against a slot nobody ends up using.
   *
   * Only the QUEUE half is reported back. A draft that moves has no consequence
   * the user needs to hear about — it is still a draft, and the calendar shows
   * the new time. A QUEUE post is a scheduled send being moved, and one that
   * could NOT be moved (publishing right now, or already claimed) is a genuine
   * exception to what the user just asked for, so it is named.
   *
   * Best-effort by design: the settings save has already succeeded and is what
   * the user asked for, so a failure to tidy the schedule must not turn it into
   * an error. Both passes are idempotent (they only move posts that are outside
   * their window), so the next save — or the commit — picks up whatever this
   * missed.
   */
  private async _realign(orgId: string, projectId: string) {
    try {
      await this._postsService.alignPlanDraftPublishDates(orgId, projectId);
      const queued = await this._postsService.rescheduleQueuedPlanPosts(
        orgId,
        projectId
      );
      return { moved: queued.rescheduled, skipped: queued.skipped };
    } catch (err) {
      this.logger.warn(
        `Publish-window alignment failed for orgId=${orgId} projectId=${projectId} ` +
          `(settings were saved; posts keep their current times): ${(err as Error)?.message || err}`
      );
      return null;
    }
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
    if (dto.autoReplyEnabled === undefined && dto.policies === undefined) {
      throw new BadRequestException('Nothing to update');
    }

    // One read serves both halves that need it: merging policies needs what is
    // stored, and so does "switch replying on without naming a mode" — that
    // resumes the mode the project last used. Skipped entirely when neither
    // asks, so a bare switch flip is still a single write.
    const needsCurrent =
      dto.policies !== undefined || dto.autoReplyEnabled === true;
    const current = needsCurrent
      ? readEngageConfigMetadata(
          await this._engageRepository.getConfigCore(org.id, projectId)
        )
      : null;

    const autoReplyMode = resolveStoredAutoReplyMode(
      dto,
      current?.autoReplyMode ?? 'off'
    );

    let replyPolicies: Record<string, Record<string, unknown>> | undefined;
    if (dto.policies) {
      const existing = current!.replyPolicies as Record<
        string,
        Record<string, unknown>
      >;
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
      replyPolicies = merged;
    }

    await this._engageService.saveConfig(org, {
      projectId,
      // Switching replying ON turns SCANNING on with it. A project replies to
      // opportunities Engage discovered, so replying with scanning off is not a
      // configuration, it is a dead end: nothing is found, nothing is drafted,
      // and the Automation page shows a switch that is on and idle with no
      // control on it that explains why. Pairing them here rather than asking
      // the client to send both also means it cannot forget.
      //
      // Deliberately ONE-WAY. Switching replying off leaves scanning alone:
      // discovery is the Engage page's own feature, and stopping it would empty
      // that page as a side effect of a decision made on this one. It also
      // matches the rule the switch chain already states — turning Automation
      // off stops replying, not finding, so conversations keep accumulating and
      // are there the moment it comes back.
      ...(autoReplyMode !== undefined &&
        autoReplyMode !== 'off' && { enabled: true }),
      ...(autoReplyMode !== undefined && { autoReplyMode }),
      ...(replyPolicies !== undefined && { replyPolicies }),
    } as any);

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

/**
 * The stored tri-state, projected onto what the client actually needs: the
 * boolean it renders as a switch, plus the mode it can only READ.
 *
 * `off` is not a mode on the wire — it is `autoReplyEnabled: false`. Carrying it
 * in both places made `enabled: false, autoReplyMode: "off"` read as one fact
 * stated twice, which is exactly what it was. Storage keeps the single
 * tri-state, so the two can never disagree at rest.
 *
 * The mode survives as an output-only field because `auto` is reachable through
 * Engage's config endpoint, and a project running unattended must be legible
 * here rather than showing an ordinary-looking switch. While the switch is off
 * it reports the mode replying would RESUME on, not a stored value that is not
 * in effect.
 */
function splitAutoReplyMode(mode: AutoReplyMode): {
  autoReplyEnabled: boolean;
  autoReplyMode: Exclude<AutoReplyMode, 'off'>;
} {
  return {
    autoReplyEnabled: mode !== 'off',
    autoReplyMode: mode === 'off' ? DEFAULT_AUTO_REPLY_MODE : mode,
  };
}

/**
 * Fold this page's one boolean onto the stored tri-state, or `undefined` when the
 * body says nothing about replying (a policies-only save must not restate it).
 *
 * The boolean is the whole contract here — Automation offers no review/auto
 * choice — so the ON direction has to answer "which mode" on the client's
 * behalf, and it answers it by RESUMING rather than defaulting. That matters in
 * one direction specifically: a project set to `auto` through Engage's own
 * config endpoint must not be silently demoted to `review` by someone toggling
 * this page off and on. Only a project with nothing to resume falls to the
 * default, and that default is `review` for the same reason every switch
 * defaults off — sending unreviewed is the irreversible side.
 */
function resolveStoredAutoReplyMode(
  dto: SaveAutomationRepliesDto,
  currentMode: AutoReplyMode
): AutoReplyMode | undefined {
  if (dto.autoReplyEnabled === false) return 'off';
  if (dto.autoReplyEnabled === true) {
    return currentMode === 'off' ? DEFAULT_AUTO_REPLY_MODE : currentMode;
  }
  return undefined;
}
