import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import {
  ExtensionPublishConfigService,
  isValidWindow,
  PublishTimeWindow,
} from '@gitroom/nestjs-libraries/database/prisma/posts/extension-publish-config.service';
import { PublishPlatform } from '@gitroom/helpers/extension/post-publish';
import { readEngageConfigMetadata } from '@gitroom/nestjs-libraries/engage/engage-config-metadata';

/**
 * The publishing half of a project's Automation settings, as it is stored
 * TODAY: three keys sharing `EngageConfig.replyPolicies` with the reply policy
 * of the same platform.
 *
 * That sharing is a known wart — publishing settings have nothing to do with
 * Engage replies, and a client that saves one has to read-modify-write the
 * other's keys along with it. Moving them to their own column is a separate,
 * schema-touching change; this type exists so that until then the fields are at
 * least DECLARED and READ, instead of being written by the frontend into an
 * untyped Json blob that no backend code ever looked at.
 */
export interface ProjectPublishingPolicy {
  /** Whether this project publishes to this platform at all. */
  publishingEnabled?: boolean;
  /** Local-time 'HH:MM' bounds for this project on this platform. */
  publishingWindowStart?: string;
  publishingWindowEnd?: string;
  /** IANA timezone the bounds are expressed in; absent = inherit/UTC. */
  publishingTimezone?: string;
}

export interface ResolvedProjectPublishing {
  /** The project's Automation master switch. */
  automationEnabled: boolean;
  /**
   * The scheduled-publishing feature switch, resolved: the explicit column when
   * the project set one, otherwise the legacy derived rule (does any platform
   * have publishing turned on?).
   */
  publishingEnabled: boolean;
  /**
   * Whether `publishingEnabled` above came from an explicit choice rather than
   * the derived fallback. Only the API surface needs this — it is what lets a
   * client tell "never configured" from "deliberately off".
   */
  publishingConfigured: boolean;
  /**
   * Platforms the project publishes to, or `null` for "the project has never
   * expressed a preference" — which stays UNCONSTRAINED so an existing project
   * with no saved publishing settings keeps behaving exactly as before.
   *
   * An empty array is NOT the same as null: it means every platform was
   * explicitly turned off, and nothing should be queued.
   */
  enabledPlatforms: string[] | null;
  /** Effective per-platform window: project override on top of the admin tiers. */
  windows: Partial<Record<PublishPlatform, PublishTimeWindow>>;
}

/**
 * Does scheduled publishing run for this project at all?
 *
 * The AND chain the product asks for, minus the per-platform level (which is
 * applied later, per post): master switch, then the feature switch. Expressed
 * as one function so the enqueue path and the API surface can never disagree
 * about what "on" means.
 */
export function isPublishingActive(
  resolved: Pick<ResolvedProjectPublishing, 'automationEnabled' | 'publishingEnabled'>
): boolean {
  return resolved.automationEnabled && resolved.publishingEnabled;
}

/**
 * Reads the per-platform publishing policies out of an `EngageConfig.replyPolicies`
 * blob. Unknown/foreign keys (the reply-side fields) are ignored rather than
 * rejected — the two policy sets legitimately share one object today.
 */
export function readPublishingPolicies(
  replyPolicies: unknown
): Record<string, ProjectPublishingPolicy> {
  if (!replyPolicies || typeof replyPolicies !== 'object' || Array.isArray(replyPolicies)) {
    return {};
  }
  const out: Record<string, ProjectPublishingPolicy> = {};
  for (const [platform, raw] of Object.entries(replyPolicies as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const policy = raw as Record<string, unknown>;
    const entry: ProjectPublishingPolicy = {};
    if (typeof policy.publishingEnabled === 'boolean') {
      entry.publishingEnabled = policy.publishingEnabled;
    }
    if (typeof policy.publishingWindowStart === 'string') {
      entry.publishingWindowStart = policy.publishingWindowStart;
    }
    if (typeof policy.publishingWindowEnd === 'string') {
      entry.publishingWindowEnd = policy.publishingWindowEnd;
    }
    if (typeof policy.publishingTimezone === 'string' && policy.publishingTimezone) {
      entry.publishingTimezone = policy.publishingTimezone;
    }
    if (Object.keys(entry).length) out[platform.toLowerCase()] = entry;
  }
  return out;
}

/**
 * The platforms a project publishes to, or `null` when it has never said.
 *
 * "Never said" is decided by the presence of a `publishingEnabled` BOOLEAN on
 * at least one platform — not by the enabled set being empty. Collapsing the
 * two would make "I turned everything off" indistinguishable from "I have not
 * configured this yet", and the safe reading of those two is opposite
 * (queue nothing vs. queue everything).
 */
export function resolveEnabledPlatforms(
  policies: Record<string, ProjectPublishingPolicy>
): string[] | null {
  const decided = Object.entries(policies).filter(
    ([, policy]) => typeof policy.publishingEnabled === 'boolean'
  );
  if (!decided.length) return null;
  return decided
    .filter(([, policy]) => policy.publishingEnabled)
    .map(([platform]) => platform);
}

/**
 * Effective publish window per platform: the project's own window wins over the
 * admin-level one (platform override → global default), and a platform the
 * project said nothing about keeps whatever the admin tiers resolved to.
 *
 * A project window with no timezone of its own inherits the timezone of the
 * admin window it is replacing — an admin who pinned "America/New_York" for a
 * platform meant those bounds to be New York time, and a project narrowing the
 * hours inside that window did not mean to silently reinterpret them as UTC.
 *
 * A malformed project window is DROPPED (the admin tier stands) rather than
 * clearing the window: a bad edit must never widen publishing beyond what an
 * admin allowed.
 */
export function mergePublishWindows(
  adminWindows: Partial<Record<PublishPlatform, PublishTimeWindow>>,
  policies: Record<string, ProjectPublishingPolicy>
): Partial<Record<PublishPlatform, PublishTimeWindow>> {
  const out: Partial<Record<PublishPlatform, PublishTimeWindow>> = { ...adminWindows };
  for (const [platform, policy] of Object.entries(policies)) {
    if (!policy.publishingWindowStart || !policy.publishingWindowEnd) continue;
    const inherited = out[platform as PublishPlatform]?.timezone;
    const candidate: PublishTimeWindow = {
      windowStart: policy.publishingWindowStart,
      windowEnd: policy.publishingWindowEnd,
      ...(policy.publishingTimezone
        ? { timezone: policy.publishingTimezone }
        : inherited
        ? { timezone: inherited }
        : {}),
    };
    if (isValidWindow(candidate)) out[platform as PublishPlatform] = candidate;
  }
  return out;
}

/**
 * Resolves a project's publishing settings, and — just as importantly — is the
 * one place that asserts an operation plan actually BELONGS to the project a
 * request claims to be acting on.
 *
 * That assertion exists because ProjectAuthGuard is keyed on a request carrying
 * a `projectId`: it authorizes the id, but nothing downstream previously checked
 * that the `planId` in the same body was the authorized project's plan. Without
 * this, an org member could pass any plan id from a sibling project (or a
 * deactivated one) and drive its posts to QUEUE.
 */
@Injectable()
export class ProjectPublishingService {
  constructor(
    private readonly _operationPlan: PrismaRepository<'operationPlan'>,
    private readonly _engageConfig: PrismaRepository<'engageConfig'>,
    private readonly _extensionPublishConfig: ExtensionPublishConfigService
  ) {}

  /**
   * Assert `planId` is an operation plan of `projectId` within `organizationId`.
   *
   * Deliberately 404s (not 403) for a plan of ANOTHER project: whether some
   * other project owns that id is not something this caller is entitled to
   * learn. A plan with no project at all is a 403 — it exists and is the
   * caller's org's, it simply predates project scoping and cannot be driven
   * through a project-scoped route.
   */
  async assertPlanBelongsToProject(
    organizationId: string,
    projectId: string,
    planId: string
  ): Promise<void> {
    const plan = await this._operationPlan.model.operationPlan.findFirst({
      where: { id: planId, organizationId },
      select: { projectId: true },
    });
    if (!plan || (plan.projectId && plan.projectId !== projectId)) {
      throw new NotFoundException('Operation plan not found');
    }
    if (!plan.projectId) {
      throw new ForbiddenException(
        'This operation plan is not scoped to a project and cannot be scheduled through a project route'
      );
    }
  }

  /** The project's effective publishing settings (switches + platforms + windows). */
  async resolve(
    organizationId: string,
    projectId: string
  ): Promise<ResolvedProjectPublishing> {
    const [config, adminWindows] = await Promise.all([
      this._engageConfig.model.engageConfig.findFirst({
        where: { organizationId, projectId },
        select: { metadata: true },
      }),
      this._extensionPublishConfig.getPublishTimeWindows(),
    ]);
    const settings = readEngageConfigMetadata(config);
    const policies = readPublishingPolicies(settings.replyPolicies);
    const enabledPlatforms = resolveEnabledPlatforms(policies);
    // null = the project predates the explicit switch, so fall back to the rule
    // that used to define it: publishing was "on" if any platform was on.
    const explicit = settings.publishingEnabled;
    return {
      automationEnabled: settings.automationEnabled,
      publishingEnabled: explicit ?? (enabledPlatforms?.length ?? 0) > 0,
      publishingConfigured: explicit !== null,
      enabledPlatforms,
      windows: mergePublishWindows(adminWindows, policies),
    };
  }
}
