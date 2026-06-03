import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { Integration } from '@prisma/client';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import {
  AuthTokenDetails,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { TemporalService } from 'nestjs-temporal-core';

/**
 * Sentinel error thrown by refreshProcess when the underlying refresh failed
 * for a reason that is plausibly retry-able (network blip, platform 5xx,
 * 429 rate-limit). Callers (activity wrappers) MUST let this propagate
 * untouched so Temporal's activity retry policy kicks in. Swallowing it would
 * permanently lose the retry opportunity and — much worse — risk falsely
 * marking the integration as `refreshNeeded=true`, forcing the user to
 * manually reconnect a perfectly healthy account.
 */
export class TransientRefreshError extends Error {
  readonly transient = true as const;
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'TransientRefreshError';
  }
}

/**
 * Classify an error from a social provider's `refreshToken()` call.
 *
 * Returns true ⇒ retry-able (network / rate-limit / platform outage).
 * Returns false ⇒ treat as permanent (OAuth invalid_grant, revoked, etc.).
 *
 * Heuristics, in order:
 *   1. OAuth standard error codes in the response body (invalid_grant,
 *      invalid_token, unauthorized_client, invalid_client) → PERMANENT.
 *      These are the only errors that genuinely mean "user must reconnect".
 *   2. HTTP 5xx / 429 / 408 / 425 → TRANSIENT (server-side issue or rate limit).
 *   3. Node.js network error codes → TRANSIENT.
 *   4. AbortError / timeout signals → TRANSIENT.
 *   5. HTTP 4xx (except 408/425/429) → PERMANENT (client-side bad request).
 *   6. Anything else / unknown shape → PERMANENT (conservative — better to
 *      ask the user to reconnect once than to retry forever on a real bug).
 *
 * Exported for unit testing.
 */
export function isTransientRefreshError(err: unknown): boolean {
  if (err == null) return false;
  const e: any = err;

  // 1. OAuth standard error codes (axios `response.data.error` or our own
  //    SDK wrapper `data.error` / `error`).
  const oauthError =
    e?.response?.data?.error ??
    e?.data?.error ??
    e?.error ??
    e?.body?.error;
  if (typeof oauthError === 'string') {
    const permanent = new Set([
      'invalid_grant',
      'invalid_token',
      'invalid_client',
      'unauthorized_client',
      'unsupported_grant_type',
      'access_denied',
    ]);
    if (permanent.has(oauthError)) return false;
    // Anything that explicitly mentions rate limiting is transient.
    if (oauthError === 'rate_limit' || oauthError === 'temporarily_unavailable') return true;
  }

  // 2 & 5. HTTP status.
  const status: unknown =
    e?.response?.status ?? e?.status ?? e?.statusCode ?? e?.code;
  if (typeof status === 'number') {
    if (status >= 500 && status < 600) return true;          // 5xx
    if (status === 408 || status === 425 || status === 429) return true; // 408/425/429
    if (status >= 400 && status < 500) return false;         // other 4xx
  }

  // 3. Node.js network errors. `code` here is a STRING (different from
  //    HTTP status which is a number).
  const codeStr: unknown = e?.code;
  if (typeof codeStr === 'string') {
    const networkCodes = new Set([
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'EPIPE',
      'EPROTO',
      'UND_ERR_SOCKET',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
    ]);
    if (networkCodes.has(codeStr)) return true;
  }

  // 4. Abort / timeout names.
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return true;

  // 6. Default: permanent (conservative).
  return false;
}

@Injectable()
export class RefreshIntegrationService {
  constructor(
    private _integrationManager: IntegrationManager,
    @Inject(forwardRef(() => IntegrationService))
    private _integrationService: IntegrationService,
    private _temporalService: TemporalService
  ) {}
  async refresh(integration: Integration): Promise<false | AuthTokenDetails> {
    const socialProvider = this._integrationManager.getSocialIntegration(
      integration.providerIdentifier
    );

    const refresh = await this.refreshProcess(integration, socialProvider);

    if (!refresh) {
      return false as const;
    }

    await this._integrationService.createOrUpdateIntegration(
      undefined,
      !!socialProvider.oneTimeToken,
      integration.organizationId,
      integration.name,
      integration.picture!,
      'social',
      integration.internalId,
      integration.providerIdentifier,
      refresh.accessToken,
      refresh.refreshToken,
      refresh.expiresIn
    );

    // Re-arm the proactive refresh workflow so the next expiry is handled
    // automatically regardless of whether a workflow was already running.
    // workflowIdConflictPolicy = TERMINATE_EXISTING makes this idempotent.
    this.startRefreshWorkflow(
      integration.organizationId,
      integration.id,
      socialProvider
    ).catch(() => {
      // Non-fatal: reactive refresh already succeeded; workflow restart is best-effort.
    });

    return refresh;
  }

  public async setBetweenSteps(integration: Integration) {
    await this._integrationService.setBetweenRefreshSteps(integration.id);
    await this._integrationService.informAboutRefreshError(
      integration.organizationId,
      integration
    );
  }

  public async startRefreshWorkflow(
    orgId: string,
    id: string,
    integration: SocialProvider,
    conflictPolicy: 'TERMINATE_EXISTING' | 'USE_EXISTING' = 'TERMINATE_EXISTING'
  ) {
    if (!integration.refreshCron) {
      return false;
    }

    return this._temporalService.client
      .getRawClient()
      ?.workflow.start(`refreshTokenWorkflow`, {
        workflowId: `refresh_${id}`,
        args: [{integrationId: id, organizationId: orgId}],
        taskQueue: 'main',
        workflowIdConflictPolicy: conflictPolicy,
      });
  }

  private async refreshProcess(
    integration: Integration,
    socialProvider: SocialProvider
  ): Promise<AuthTokenDetails | false> {
    // Permanent tokens (e.g. OAuth 1.0a) never expire and have no refresh endpoint.
    // Calling the OAuth 2.0 refresh flow on them would always fail and incorrectly
    // flag the integration as needing re-auth.
    if (socialProvider.isTokenPermanent?.(integration.token)) {
      return false;
    }

    // CRITICAL: do NOT blanket-catch errors here. A transient failure (5xx,
    // 429, network blip) must propagate so Temporal can retry. Previously a
    // single network glitch would set `refreshNeeded=true` and force the user
    // to manually reconnect a perfectly healthy account.
    //
    // Three cases:
    //   - success           → return the new token details
    //   - permanent failure → return false (caller marks refreshNeeded & disconnects)
    //   - transient failure → throw TransientRefreshError (Temporal retries)
    let refresh: false | AuthTokenDetails;
    try {
      refresh = await socialProvider.refreshToken(integration.refreshToken);
    } catch (err) {
      if (isTransientRefreshError(err)) {
        // Re-throw as a clearly-labeled sentinel so activity wrappers can
        // distinguish "retry me" from "unknown failure, mark as needing reconnect".
        throw new TransientRefreshError(
          `Transient refresh failure for ${integration.providerIdentifier} (${integration.id}): ${(err as any)?.message ?? err}`,
          err
        );
      }
      // Permanent failure (invalid_grant, 4xx other than 429/408/425, etc.).
      // Fall through to the refreshNeeded path below.
      refresh = false;
    }

    if (!refresh || !refresh.accessToken) {
      // BENIGN CONCURRENT-REFRESH RACE GUARD.
      // On rotating-refresh-token providers (notably X/Twitter) the refresh
      // token is SINGLE-USE. When two refreshes run concurrently for the same
      // integration, the winner consumes + rotates it and saves a fresh token;
      // the loser then calls the refresh endpoint with the now-stale token and
      // gets `invalid_grant` — which `isTransientRefreshError` (correctly, in
      // isolation) classifies as permanent. Without this guard the loser would
      // flag a perfectly healthy account `refreshNeeded=true` and disconnect it,
      // even though posting keeps working off the winner's freshly-saved token.
      //
      // Before doing the destructive side-effects, re-read the integration: if a
      // concurrent refresh already advanced `tokenExpiration` (and the account is
      // not flagged), treat this as a benign race — skip flagging/disconnect and
      // let the winner's token stand. A genuine revoke (real invalid_grant) does
      // NOT advance the expiry, so it still falls through to the flag path.
      let benignRace = false;
      try {
        const fresh = await this._integrationService.getByIdForAdmin(integration.id);
        const prevExp = integration.tokenExpiration
          ? new Date(integration.tokenExpiration).getTime()
          : 0;
        const freshExp = fresh?.tokenExpiration
          ? new Date(fresh.tokenExpiration).getTime()
          : 0;
        benignRace =
          !!fresh && !fresh.refreshNeeded && freshExp > prevExp && freshExp > Date.now();
      } catch {
        // Re-read failed → fall back to the conservative permanent-failure path.
      }
      if (benignRace) {
        console.warn(
          `[refreshProcess] concurrent-refresh race for integration=${integration.id} provider=${integration.providerIdentifier}: another refresh already rotated the token (tokenExpiration advanced) — skipping refreshNeeded/disconnect.`
        );
        return false;
      }

      // The three side effects below MUST all run on a permanent refresh
      // failure, but each can fail independently (DB write timeout,
      // notification service down, etc.). Previously these were chained
      // with bare `await` — if any threw, the remaining ones were skipped
      // and the integration was left in a partially-disabled state
      // (refreshNeeded=true but channel not disconnected, or vice-versa).
      //
      // Each step now runs under its own try/catch so a failure in one
      // does NOT block the others. The first step (refreshNeeded) is the
      // most important — it blocks Layer 1's refresh workflow from
      // continuing — so its failure is logged at error level.
      try {
        await this._integrationService.refreshNeeded(
          integration.organizationId,
          integration.id
        );
      } catch (e) {
        console.error(
          `[refreshProcess] refreshNeeded failed for integration=${integration.id} provider=${integration.providerIdentifier}: ${(e as any)?.message ?? e}. Integration may continue to attempt refreshes.`
        );
      }

      try {
        await this._integrationService.informAboutRefreshError(
          integration.organizationId,
          integration
        );
      } catch (e) {
        console.warn(
          `[refreshProcess] informAboutRefreshError failed for integration=${integration.id}: ${(e as any)?.message ?? e}. User will not be notified.`
        );
      }

      try {
        await this._integrationService.disconnectChannel(
          integration.organizationId,
          integration
        );
      } catch (e) {
        console.error(
          `[refreshProcess] disconnectChannel failed for integration=${integration.id} provider=${integration.providerIdentifier}: ${(e as any)?.message ?? e}. Integration is refreshNeeded but channel not disconnected — operator intervention needed.`
        );
      }

      return false;
    }

    if (
      !socialProvider.reConnect ||
      integration.rootInternalId === integration.internalId
    ) {
      return refresh;
    }

    const reConnect = await socialProvider.reConnect(
      integration.rootInternalId,
      integration.internalId,
      refresh.accessToken
    );

    return {
      ...refresh,
      ...reConnect,
    };
  }
}
