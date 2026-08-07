import { Injectable, Logger } from '@nestjs/common';
import { AiseeClient } from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/aisee.client';
import { AiseeCreditService } from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/aisee-credit.service';
import {
  ProjectInactiveException,
  ProjectNotFoundException,
  ProjectValidationUnavailableException,
} from './project.exception';

// projectId is an opaque aisee-core products.id (always a server-generated
// UUID). Reject anything else before it ever reaches aisee-core: aisee-core's
// own product lookup also accepts a website URL/domain as an alternate key,
// which would let a client pass a name/URL instead of the opaque id
// (project-scoped-post-engage-design.md §4: "never trust a project name,
// URL... as a project identifier").
const PROJECT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// `active` mirrors aisee-core's Product.is_active and rides along on the same
// lookup as `valid` — checking the activation switch never costs an extra call.
type CachedVerdict = { valid: boolean; active: boolean; expiresAt: number };

// Short positive/negative caches per §4. Negative is shorter than positive so
// a project created moments ago (or a stale ownership row) self-heals fast.
const POSITIVE_TTL_MS = 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 1000;

/**
 * Resolves and authorizes a client-supplied projectId against the
 * authenticated request's organization, per project-scoped-post-engage-
 * design.md §4. organizationId must always come from the authenticated
 * request (request.org), never from client input.
 */
@Injectable()
export class ProjectValidationService {
  private readonly logger = new Logger(ProjectValidationService.name);
  private readonly _cache = new Map<string, CachedVerdict>();

  constructor(
    private readonly _aiseeClient: AiseeClient,
    private readonly _aiseeCreditService: AiseeCreditService
  ) {}

  /**
   * Throws if projectId does not resolve to an aisee-core product owned by
   * organizationId's Aisee user. Resolves (no return value) on success.
   *
   * No route in this codebase currently documents itself as an allowed
   * "degraded read" (§4: "allow only explicitly documented degraded reads"),
   * so an aisee-core outage fails closed for every caller, read or mutation,
   * until such a route opts in explicitly.
   */
  async assertProjectAccess(
    organizationId: string,
    projectId: string
  ): Promise<void> {
    const verdict = await this._resolveVerdict(organizationId, projectId);
    if (!verdict.valid) {
      throw new ProjectNotFoundException();
    }
  }

  /**
   * Ownership check plus aisee-core's activation switch. Use on every route
   * that acts on a project (posting, plan generation, engage, scanning,
   * channel binding); reads keep using {@link assertProjectAccess} so a
   * deactivated project stays inspectable and can be switched back on.
   *
   * Throws ProjectNotFoundException (404) when the project is not this org's,
   * ProjectInactiveException (403) when it is but is switched off.
   */
  async assertProjectActive(
    organizationId: string,
    projectId: string
  ): Promise<void> {
    const verdict = await this._resolveVerdict(organizationId, projectId);
    if (!verdict.valid) {
      throw new ProjectNotFoundException();
    }
    if (!verdict.active) {
      this.logger.warn(
        `Project action denied: org=${organizationId} projectId=${projectId} is deactivated`
      );
      throw new ProjectInactiveException();
    }
  }

  /**
   * Non-throwing variant for background work (engage scan fan-out, publish
   * claim) that has no request to fail — it filters instead. An aisee-core
   * outage returns false, matching the fail-closed stance of the HTTP paths:
   * background work is retried later anyway, so skipping a cycle is cheaper
   * than acting on a project we cannot vouch for.
   */
  async isProjectActive(
    organizationId: string,
    projectId: string
  ): Promise<boolean> {
    try {
      const verdict = await this._resolveVerdict(organizationId, projectId);
      return verdict.valid && verdict.active;
    } catch {
      return false;
    }
  }

  /**
   * One cached aisee-core lookup yielding both the ownership and activation
   * verdicts. Throws ProjectValidationUnavailableException when aisee-core
   * cannot be reached (never cached, so the next call retries fresh).
   */
  private async _resolveVerdict(
    organizationId: string,
    projectId: string
  ): Promise<CachedVerdict> {
    if (!PROJECT_ID_PATTERN.test(projectId)) {
      this.logger.warn(
        `Project auth rejected: org=${organizationId} projectId is not a valid opaque id`
      );
      throw new ProjectNotFoundException();
    }

    const cacheKey = `${organizationId}:${projectId}`;
    const cached = this._cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached;
    }

    const ownerUserId = await this._aiseeCreditService.resolveOwnerUserId(
      organizationId
    );
    const lookup = await this._aiseeClient.getProduct(projectId);

    if (lookup.ok === false && lookup.reason === 'unavailable') {
      // Transient — cache neither verdict, so the next call retries fresh.
      this.logger.warn(
        `Project auth unavailable: org=${organizationId} projectId=${projectId} aisee-core unreachable`
      );
      throw new ProjectValidationUnavailableException();
    }

    const valid = lookup.ok && lookup.product.userId === ownerUserId;
    const active = valid && lookup.ok && lookup.product.isActive;
    // An "inactive" verdict takes the shorter negative TTL: activation is a
    // switch the user flips by hand and expects to take effect promptly, unlike
    // ownership. The opposite direction still lags — a project deactivated
    // moments ago keeps passing for up to POSITIVE_TTL_MS on hosts that already
    // cached it. That window is acceptable here (scheduled posts and scan ticks
    // are minutes apart) but it is a lag, not an instant kill switch.
    const verdict: CachedVerdict = {
      valid,
      active,
      expiresAt:
        Date.now() + (valid && active ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
    };
    this._cache.set(cacheKey, verdict);

    if (!valid) {
      this.logger.warn(
        lookup.ok
          ? `Project auth denied: org=${organizationId} projectId=${projectId} owned by a different user`
          : `Project auth denied: org=${organizationId} projectId=${projectId} not found`
      );
    }

    return verdict;
  }
}
