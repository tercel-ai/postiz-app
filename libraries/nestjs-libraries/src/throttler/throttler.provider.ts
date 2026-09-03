import { ThrottlerGuard, ThrottlerModuleOptions, ThrottlerStorage } from '@nestjs/throttler';
import { ExecutionContext, Inject, Injectable, Optional } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  RISK_GATES,
  RiskControlTickService,
} from '@gitroom/nestjs-libraries/risk-control/risk-control-tick.service';

// Metadata key used by @nestjs/throttler's @Throttle() decorator. Not re-exported
// from the package's public index, so we reference the literal value defined in
// node_modules/@nestjs/throttler/dist/throttler.constants.d.ts.
const THROTTLER_LIMIT = 'THROTTLER:LIMIT';

@Injectable()
export class ThrottlerBehindProxyGuard extends ThrottlerGuard {
  constructor(
    @Inject('THROTTLER:MODULE_OPTIONS') options: ThrottlerModuleOptions,
    @Inject(ThrottlerStorage) storageService: ThrottlerStorage,
    reflector: Reflector,
    // Optional: a 429 must still be a 429 on a deployment that has not wired
    // telemetry (and in the unit tests, which construct this guard directly).
    @Optional() private readonly _riskTicks?: RiskControlTickService
  ) {
    super(options, storageService, reflector);
  }

  /**
   * Count the refusal, then refuse exactly as before.
   *
   * Throttle counts live in Redis under a short TTL, so a 429 leaves no trace
   * the next day — which means a limit tuned too tight is invisible until
   * someone complains. Recorded per route bucket so the report says WHICH limit
   * is biting, not just that something is.
   *
   * Awaited rather than fire-and-forget: `record` already swallows its own
   * failures, and letting the write race the response would drop ticks under
   * exactly the burst that makes them worth having.
   */
  protected override async throwThrottlingException(
    context: ExecutionContext,
    throttlerLimitDetail: any
  ): Promise<void> {
    const req = context.switchToHttp().getRequest();
    await this._riskTicks?.record({
      gate: RISK_GATES.routeThrottle,
      organizationId: req?.org?.id ?? '',
      // The route, not the tracker key: the key carries a user id, and this
      // table is aggregate telemetry rather than a per-user audit trail.
      detail: `${req?.method ?? ''} ${req?.route?.path ?? req?.url ?? ''}`.trim(),
    });
    return super.throwThrottlingException(context, throttlerLimitDetail);
  }
  public override async canActivate(
    context: ExecutionContext
  ): Promise<boolean> {
    const { url } = context.switchToHttp().getRequest();
    // Always-throttled public-v1 paths (default org-level rate limiting).
    if (url.includes('/public/v1/posts') || url.includes('/public/v1/upload')) {
      return super.canActivate(context);
    }
    // Honor per-route @Throttle() metadata on every other route too —
    // without this, decorators like @Throttle({ default: { limit, ttl } })
    // are silent no-ops outside the public-v1 allowlist.
    const handler = context.getHandler();
    const classRef = context.getClass();
    const throttleLimit = this.reflector.getAllAndOverride<unknown>(
      THROTTLER_LIMIT,
      [handler, classRef]
    );
    if (throttleLimit !== undefined) {
      return super.canActivate(context);
    }
    return true;
  }

  protected override async getTracker(
    req: Record<string, any>
  ): Promise<string> {
    // Per-route throttles need a stable tracker that does NOT collapse all
    // engage requests into a single bucket. Prefer userId when present (matches
    // F-04's "20 generations/user/hour" wording); fall back to org-scoped key.
    const userId = req.user?.id;
    const orgId = req.org?.id ?? 'anon';
    const bucket = req.url?.indexOf?.('/posts') > -1 ? 'posts' : 'other';
    return userId
      ? `${orgId}_${userId}_${bucket}`
      : `${orgId}_${bucket}`;
  }
}
