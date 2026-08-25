import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Organization } from '@prisma/client';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { OperationPlanService } from '@gitroom/nestjs-libraries/database/prisma/operation-plan/operation-plan.service';
import { EngageService } from '@gitroom/nestjs-libraries/engage/engage.service';
import { EngageRepository } from '@gitroom/nestjs-libraries/engage/engage.repository';
import { EngageAutoReplyService } from '@gitroom/nestjs-libraries/engage/engage-auto-reply.service';
import {
  isPublishingActive,
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
  private readonly logger = new Logger(AutomationService.name);

  constructor(
    private readonly _postsService: PostsService,
    private readonly _operationPlanService: OperationPlanService,
    private readonly _engageService: EngageService,
    private readonly _engageRepository: EngageRepository,
    private readonly _projectPublishing: ProjectPublishingService,
    private readonly _engageAutoReply: EngageAutoReplyService
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
    const [config, publishing, lastPublishedAt, pacing] = await Promise.all([
      this._engageRepository.getConfigCore(org.id, projectId),
      this._projectPublishing.resolve(org.id, projectId),
      this._postsService.getLastPublishedAt(org.id, projectId),
      this._engageAutoReply.getPacing(),
    ]);

    // Resolved once so the hoisted default and the per-window overrides below
    // can never disagree about what "the common zone" is.
    const commonTimezone = resolveCommonTimezone(publishing.windows);

    const settings = readEngageConfigMetadata(config);
    const storedPolicies = settings.replyPolicies as Record<
      string,
      Record<string, unknown>
    >;

    // The same three gates `EngageRepository.getAutoReplyConfigs` applies before
    // the driver ever looks at a platform — master switch, scan switch, global
    // reply switch. A platform whose own `autoReplyEnabled` is also true is the
    // ONLY case the driver will ever act on, so it is the only case worth a
    // `nextCheckAt`; everything else reports `null` rather than a time that will
    // never arrive.
    const repliesActive =
      publishing.automationEnabled &&
      (config?.enabled ?? false) &&
      settings.autoReplyEnabled;
    const platformKeys = Object.keys(storedPolicies);
    // Keyed lowercase to match how the driver normalizes a policy's platform
    // before it ever queries EngageSentReply (engage-auto-reply.service.ts) —
    // a policy key written with different casing must still resolve.
    const lastSentAtByPlatform =
      repliesActive && platformKeys.length
        ? await this._engageRepository.getLastSentReplyAtByPlatform(
            org.id,
            projectId,
            platformKeys.map((platform) => platform.toLowerCase())
          )
        : {};
    const now = new Date();

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
        // The one reply switch this page has.
        autoReplyEnabled: settings.autoReplyEnabled,
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
        //
        // Each entry also carries `nextCheckAt`: the next time AIsee will check
        // THIS platform for reply opportunities, or null while that platform is
        // not being driven at all (see withNextCheckAt below for the formula).
        platforms: withNextCheckAt(
          stripPublishingKeys(storedPolicies),
          repliesActive,
          lastSentAtByPlatform,
          pacing.minGapMinutes,
          now
        ),
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
    // Read BEFORE the write so the OFF -> ON transition is visible below. A
    // switch-on is the one save that must commit whether or not the client
    // asked for it — see the `shouldCommit` note further down.
    const before = await this._projectPublishing.resolve(org.id, projectId);
    const wasActive = isPublishingActive(before);
    const requested = new Set(dto.platforms.map((p) => p.toLowerCase()));
    const existing = readEngageConfigMetadata(
      await this._engageRepository.getConfigCore(org.id, projectId)
    ).replyPolicies as Record<string, Record<string, unknown>>;
    const policies: Record<string, Record<string, unknown>> = { ...existing };

    // Platform-level deltas, measured against the RESOLVED decisions rather than
    // the raw policy blob — resolvePlatformDecisions is what defines "on" for
    // this project, and reading the blob directly would answer a slightly
    // different question than every other gate does.
    //
    // Read BEFORE the write for the same reason `wasActive` is: afterwards
    // there is nothing left to compare against.
    const decisionsBefore = new Map(
      Object.entries(before.platformDecisions ?? {}).map(([platform, on]) => [
        platform.toLowerCase(),
        on,
      ])
    );
    // Turned off here → its queued plan posts go back to DRAFT.
    const dropped = [...decisionsBefore]
      .filter(([platform, on]) => on === true && !requested.has(platform))
      .map(([platform]) => platform);
    // Turned back on here → commit again, so the drafts this switch parked come
    // back. EXPLICITLY-off only: a platform being configured for the first time
    // has no parked drafts to restore, and treating that as a commit
    // instruction would queue a batch off a settings save.
    const reEnabled = [...requested].filter(
      (platform) => decisionsBefore.get(platform) === false
    );

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

    // Uncommit BEFORE realigning, so anything that just went back to DRAFT is
    // realigned as a draft — no claim/lockout gates, no workflow to restart.
    //
    // Switching the feature off reverts everything; a settings-only save that
    // merely drops a platform reverts just that platform's posts.
    const uncommitted =
      dto.enabled === false
        ? await this._uncommitPlanPosts(org.id, projectId)
        : dropped.length
        ? await this._uncommitPlanPosts(org.id, projectId, dropped)
        : null;

    const rescheduled = await this._realign(org.id, projectId);

    // Turning scheduled publishing ON commits, even when the client sent no
    // `commit` flag. The switch used to be pure configuration, which read as a
    // reasonable separation but produced a dead end in practice: a project
    // whose plan materialized while publishing was off kept its posts in DRAFT,
    // the switch-on did not move them, and nothing else ever would — the user
    // saw "Scheduled publishing: on", an empty queue, and no control that
    // explained the gap. Switching the feature on IS the instruction to publish
    // what is scheduled, so it now means that.
    //
    // Only the OFF -> ON edge, never a save that leaves an already-on switch on:
    // editing a WINDOW still needs an explicit `commit`, so it cannot silently
    // queue a batch.
    const switchedOn = dto.enabled === true && !wasActive;
    // Ticking a platform back on is its own commit instruction, for the same
    // reason switching the feature on is. Without this, the round trip
    // "untick reddit -> its posts go back to DRAFT -> tick reddit again" would
    // leave them stranded as drafts that nothing ever queues — the exact dead
    // end the feature-switch commit was added to close.
    // Never on the way OFF: `enabled: false` cannot be a commit instruction, no
    // matter which platforms the same save happens to name.
    const platformReEnabled = dto.enabled !== false && reEnabled.length > 0;
    const shouldCommit = dto.commit || switchedOn || platformReEnabled;
    if (!shouldCommit) {
      return { saved: true, scheduled: null, rescheduled, uncommitted };
    }

    const scheduled = await this._commitPlanPosts(
      org.id,
      projectId,
      dto.publishMethod,
      dto.platforms
    );
    return { saved: true, scheduled, rescheduled, uncommitted };
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

    // Switching the master OFF puts automation's queued posts back to DRAFT —
    // the suspension the switch has always claimed to be. Unconditional on
    // `wasActive`: the revert is idempotent, and a project whose feature switch
    // was already off can still be holding posts committed before that.
    //
    // Hand-scheduled posts and engage replies are untouched (see
    // uncommitPlanPosts): the master switch suspends AUTOMATION, not the
    // calendar someone filled in by hand.
    const uncommitted = enabled
      ? null
      : await this._uncommitPlanPosts(org.id, projectId);

    // `enabled` is only the master switch — the feature switch below it decides
    // whether publishing is actually on, which is what alignPlanDraftPublishDates
    // re-checks for itself. Calling it on every ON is therefore safe; this guard
    // just avoids the read when nothing can have changed.
    const turnedOn = enabled && !wasActive;
    const rescheduled = turnedOn ? await this._realign(org.id, projectId) : null;
    // Turning the master switch back on commits, for the same reason the
    // feature switch does (see savePublishing): a project that generated its
    // plan while Automation was suspended has drafts nothing else will ever
    // queue, and "Automation: on" with a permanently empty queue is not a
    // suspension the user can reason about.
    //
    // `_commitPlanPosts` re-checks `isPublishingActive` itself, so a master-on
    // with the publishing FEATURE still off correctly queues nothing.
    // Platforms are left undefined so the project's own saved selection
    // decides — this switch carries no platform list of its own.
    const scheduled = turnedOn
      ? await this._commitPlanPosts(org.id, projectId)
      : null;

    return { saved: true as const, enabled, rescheduled, scheduled, uncommitted };
  }

  /**
   * Commit this project's still-DRAFT plan posts (DRAFT -> QUEUE).
   *
   * Resolves the plan id SERVER-side: the client never names a plan, so there
   * is no plan id for it to get wrong — or to borrow from another project.
   *
   * A null plan id is NOT a short-circuit. `getActivePlanId` only counts a plan
   * whose `startsAt <= now <= endsAt`, so a plan that simply ran past its end
   * date stops being "active" while its DRAFT posts are still perfectly valid,
   * un-deleted rows on the calendar. Returning early there is what stranded
   * them: the supersede sweep only soft-deletes drafts when a NEWER plan
   * materializes, so nothing queued them and nothing cleaned them up. Passing
   * null through widens the batch to every live plan post of the project, which
   * is what the user means by "publish what is scheduled".
   *
   * Still safe for a project that has never generated a plan: the query is
   * scoped to `operationPlanId: { not: null }`, so an empty project commits an
   * empty batch instead of erroring, and a hand-authored draft is never swept
   * in.
   */
  private async _commitPlanPosts(
    orgId: string,
    projectId: string,
    publishMethod?: 'extension' | 'api',
    platforms?: string[]
  ) {
    const { id: planId } = await this._operationPlanService.getActivePlanId(
      orgId,
      projectId
    );
    return this._postsService.schedulePlanPosts(
      orgId,
      planId,
      projectId,
      publishMethod,
      platforms
    );
  }

  /**
   * Put automation's queued plan posts back to DRAFT for this project (or just
   * for the platforms named), best-effort.
   *
   * Best-effort for the same reason _realign is: the settings save has already
   * succeeded and is what the user asked for, so failing to tidy the queue must
   * not turn their save into an error. The next switch-off — or the next save —
   * retries it, since the revert is idempotent.
   */
  private async _uncommitPlanPosts(
    orgId: string,
    projectId: string,
    platforms?: string[]
  ) {
    try {
      const result = await this._postsService.uncommitPlanPosts(
        orgId,
        projectId,
        platforms
      );
      if (result.uncommitted) {
        this.logger.log(
          `Automation off for orgId=${orgId} projectId=${projectId}` +
            `${platforms?.length ? ` platforms=${platforms.join(',')}` : ''} — ` +
            `${result.uncommitted} queued plan post(s) across ${result.groups} group(s) put back to DRAFT`
        );
      }
      return result;
    } catch (e) {
      this.logger.warn(
        `Could not put queued plan posts back to DRAFT for orgId=${orgId} projectId=${projectId}: ${e}`
      );
      return null;
    }
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

    let replyPolicies: Record<string, Record<string, unknown>> | undefined;
    if (dto.policies) {
      const existing = readEngageConfigMetadata(
        await this._engageRepository.getConfigCore(org.id, projectId)
      ).replyPolicies as Record<string, Record<string, unknown>>;
      // `policies` is the COMPLETE reply-policy set, not a delta: a platform
      // absent from it has its reply policy cleared, and an empty map clears
      // every platform. Same shape rule as `savePublishing`'s `platforms`, for
      // the same reason — under a merge, "remove this platform" and "reset this
      // panel" are inexpressible. A client could only ever overwrite keys whose
      // names it knows, so a retired key would outlive every save.
      //
      // Only the REPLY half is replaced. This column is shared with the
      // publishing endpoint, so dropping whole entries here would delete windows
      // and enablement this endpoint does not own — the exact cross-module
      // clobbering `stripPublishingKeysFromPolicy` exists to prevent.
      replyPolicies = replaceReplyPolicies(existing, dto.policies);
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
      ...(dto.autoReplyEnabled === true && { enabled: true }),
      ...(dto.autoReplyEnabled !== undefined && {
        autoReplyEnabled: dto.autoReplyEnabled,
      }),
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

/**
 * Replace the REPLY half of every platform's policy with `incoming`, preserving
 * the PUBLISHING half of whatever is stored.
 *
 * Whole-set semantics: a platform `incoming` does not name keeps only its
 * publishing keys, so its reply policy is gone. An entry left with nothing at
 * all is dropped rather than stored as an empty object — "never configured" is
 * already what an absent entry means to `getOverview`, and an empty shell would
 * be a second spelling of it.
 *
 * Publishing keys inside `incoming` are dropped: those belong to the publishing
 * endpoint, and honouring them here would let a reply save silently move a
 * publish window.
 */
function replaceReplyPolicies(
  existing: Record<string, Record<string, unknown>>,
  incoming: Record<string, Record<string, unknown>>
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};

  // Stored keys are already lower-cased by `readEngageConfigMetadata`; the
  // incoming ones are normalized below so a differently-cased platform name
  // updates the entry it means instead of creating a second one beside it.
  for (const [platform, policy] of Object.entries(existing ?? {})) {
    if (!policy || typeof policy !== 'object') continue;
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(policy)) {
      if ((PUBLISHING_POLICY_KEYS as readonly string[]).includes(key)) kept[key] = value;
    }
    if (Object.keys(kept).length) out[platform] = kept;
  }

  for (const [platform, policy] of Object.entries(incoming)) {
    const key = platform.toLowerCase();
    const merged = {
      ...(out[key] ?? {}),
      ...stripPublishingKeysFromPolicy(policy),
    };
    if (Object.keys(merged).length) out[key] = merged;
    else delete out[key];
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
 * Adds, to every platform policy, the next time AIsee will check that platform
 * for reply opportunities — the same anchor and interval the driver itself
 * gates on (`EngageAutoReplyService.getDueReplies`), so this can never show a
 * time the driver disagrees with:
 *
 *   nextCheckAt = (last reply sent on this platform, or now if never) + minutes
 *
 * `minutes` is the platform's own `checkIntervalMinutes` if it set one, else the
 * org-wide pacing default — again, the exact fallback the driver applies.
 */
function withNextCheckAt(
  policies: Record<string, Record<string, unknown>>,
  repliesActive: boolean,
  lastSentAtByPlatform: Record<string, Date>,
  defaultMinGapMinutes: number,
  now: Date
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [platform, policy] of Object.entries(policies)) {
    const active = repliesActive && policy.autoReplyEnabled === true;
    let nextCheckAt: string | null = null;
    if (active) {
      const lastSentAt = lastSentAtByPlatform[platform.toLowerCase()];
      const minGapMinutes =
        typeof policy.checkIntervalMinutes === 'number'
          ? policy.checkIntervalMinutes
          : defaultMinGapMinutes;
      nextCheckAt = lastSentAt
        ? new Date(lastSentAt.getTime() + minGapMinutes * 60_000).toISOString()
        : now.toISOString();
    }
    out[platform] = { ...policy, nextCheckAt };
  }
  return out;
}

