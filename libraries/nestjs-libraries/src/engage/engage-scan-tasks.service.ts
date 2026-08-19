import { Injectable, Logger } from '@nestjs/common';
import { EngageRepository } from '@gitroom/nestjs-libraries/engage/engage.repository';
import {
  EngageScanLeaseService,
  normalizeKeyword,
  normalizeUsername,
  ScanCursorSnapshot,
} from '@gitroom/nestjs-libraries/engage/engage-scan-lease.service';
import { EngageScanIngestService } from '@gitroom/nestjs-libraries/engage/engage-scan-ingest.service';
import {
  normalizePlatform,
  scanKeyFor,
  scanTypeFor,
} from '@gitroom/nestjs-libraries/engage/engage-scan-target';
import {
  EngageScanConfigService,
  EngageScanPacing,
  SCANNABLE_PLATFORMS,
  ScanPlatform,
} from '@gitroom/nestjs-libraries/engage/engage-scan-config.service';
import { EngageEntitlementService } from '@gitroom/nestjs-libraries/engage/engage-entitlement.service';
import {
  clearEngageScanWork,
  hasEngageScanWork,
  readEngageScanWork,
} from '@gitroom/nestjs-libraries/engage/engage-scan-hint';
import { RawPost } from '@gitroom/nestjs-libraries/engage/engage-scorer';
import {
  EngageScanTask,
  ScanTaskPlatform,
  ScanTaskType,
} from '@gitroom/nestjs-libraries/engage/scan/scan-task.types';

// X SearchTimeline query budget. Keep under 512 (X hard cap); leave headroom
// for the `from:username ` prefix (~20 chars) and ` -filter:retweets` suffix.
const X_TRACKED_KW_QUERY_MAX = 460;
// Reddit search `q` cap mirrors REDDIT_QUERY_MAX_LEN in reddit-scan-adapter.ts.
const REDDIT_CHANNEL_QUERY_MAX = 480;

/**
 * Build `from:username (kw1 OR kw2 ...) -filter:retweets` for a tracked X
 * account combined with org keywords. Keywords are included in order until the
 * combined query would exceed X_TRACKED_KW_QUERY_MAX characters. Returns
 * undefined when the keyword list is empty or nothing fits in the budget.
 */
export function buildTrackedKeywordQuery(
  username: string,
  keywords: string[]
): string | undefined {
  if (!keywords.length) return undefined;
  const prefix = `from:${username} `;
  const kwBudget = X_TRACKED_KW_QUERY_MAX - prefix.length - 2; // 2 for '(' ')'
  if (kwBudget <= 0) return undefined;

  const parts: string[] = [];
  let usedLen = 0;
  for (const kw of keywords) {
    // Quote multi-word keywords; single tokens stay bare.
    const token = kw.includes(' ') ? `"${kw}"` : kw;
    const add = parts.length === 0 ? token : ` OR ${token}`;
    if (usedLen + add.length > kwBudget) break;
    parts.push(token);
    usedLen += add.length;
  }
  if (!parts.length) return undefined;
  return `${prefix}(${parts.join(' OR ')})`;
}

/**
 * Build `kw1 OR kw2 OR ...` for a Reddit subreddit channel scan. Used as the
 * `q` parameter in `/r/{sub}/search?q=...&restrict_sr=on&sort=new` so the
 * extension only fetches keyword-relevant posts instead of the full /new feed.
 * Returns undefined when no keywords fit in the budget.
 */
export function buildRedditChannelKeywordQuery(
  keywords: string[]
): string | undefined {
  if (!keywords.length) return undefined;
  const parts: string[] = [];
  let usedLen = 0;
  for (const kw of keywords) {
    const token = kw.includes(' ') ? `"${kw}"` : kw;
    const add = parts.length === 0 ? token : ` OR ${token}`;
    if (usedLen + add.length > REDDIT_CHANNEL_QUERY_MAX) break;
    parts.push(token);
    usedLen += add.length;
  }
  return parts.length ? parts.join(' OR ') : undefined;
}

// Env-only fallback allowlist, used when the admin operation-plan allowlist is
// absent AND the scan-config resolver is unavailable (e.g. unit tests that build
// this service with a partial config mock). The live gate is resolved per call by
// _resolveScanPlatforms → EngageScanConfigService.getSupportedScanPlatforms
// (`settings.operation_plan.allowed_platforms || ENGAGE_SUPPORTED_PLATFORMS`).
// Keyword units fan out to each platform (a keyword has no platform of its own);
// channel/tracked carry their own platform.
// The DEFAULT stays 'x,reddit' — new platforms are OPT-IN (an operator adds them
// to ENGAGE_SUPPORTED_PLATFORMS or the operation-plan allowlist), so existing
// deployments keep enumerating only x/reddit until explicitly widened.
// Re-exported alias of the ONE capability list (engage-scan-config.service.ts).
// This file used to declare its own copy plus a second one for scan targets;
// three identical lists meant adding a platform to some of them silently
// dropped its units in the rest.
//
// Scan TARGETS are gated by this same list. Which SCOPE a target has is not a
// list at all: `scanTypeFor(platform)` decides (reddit → channel
// /r/<sub>/new.json, everything else → a per-author feed).
const SCANNABLE_SCAN_TASK_PLATFORMS: readonly ScanTaskPlatform[] =
  SCANNABLE_PLATFORMS as readonly ScanTaskPlatform[];
const ENV_SCAN_PLATFORMS: ScanTaskPlatform[] = (
  process.env.ENGAGE_SUPPORTED_PLATFORMS ?? 'x,reddit'
)
  .split(',')
  .map((p) => p.trim().toLowerCase())
  .filter((p): p is ScanTaskPlatform =>
    (SCANNABLE_SCAN_TASK_PLATFORMS as readonly string[]).includes(p)
  );

// Default batch size handed back per call — small so a browser never over-leases
// units it won't get to (a stuck lease only frees on the stale-reclaim TTL).
const DEFAULT_WANT = 2;
const MAX_WANT = 5;

export interface CompletedUnitInput {
  taskId: string;
  posts: RawPost[];
  nextCursor?: { lastSeenExternalId?: string | null; lastSeenAt?: Date | null };
  exhausted?: boolean;
}

export interface ScanUnitSelector {
  platform: ScanTaskPlatform;
  scanType: ScanTaskType;
  scanKey: string;
}

/**
 * Drives the extension scan loop: a single entry point that (optionally)
 * INGESTS a completed unit's posts and then CLAIMS the next batch of due units
 * for this org. The returned tasks are computed at call time, so any unit
 * another browser (or the workflow) just scanned is already excluded — the
 * cross-org dedup the whole design hinges on.
 */
@Injectable()
export class EngageScanTasksService {
  private readonly logger = new Logger(EngageScanTasksService.name);

  constructor(
    private readonly _engageRepo: EngageRepository,
    private readonly _lease: EngageScanLeaseService,
    private readonly _ingest: EngageScanIngestService,
    private readonly _config: EngageScanConfigService,
    private readonly _entitlement: EngageEntitlementService
  ) {}

  /**
   * Back-attribute existing global opportunities to this org without any
   * platform fetch — the cross-org "initial" path. Call when an org newly
   * subscribes (engage setup / keyword|channel|tracked added) so its feed
   * immediately reflects opportunities other orgs already populated, rather than
   * waiting for the next incremental scan to surface nothing. Returns the number
   * of per-org states written. No-op when the org has no enabled config.
   */
  async backfillFromExisting(
    orgId: string,
    opts: { windowDays?: number; limit?: number; projectId?: string | null } = {}
  ): Promise<number> {
    const ctx = await this._engageRepo.getEnabledOrgContext(orgId, opts.projectId ?? null);
    if (!ctx) return 0;

    const windowDays = opts.windowDays ?? (await this._entitlement.getMetricsWindowDays(orgId));
    const since = new Date(Date.now() - windowDays * 86_400_000);
    const platforms = (await this._resolveScanPlatforms()) as string[];
    const opportunities = await this._engageRepo.getRecentGlobalOpportunities(
      platforms,
      since,
      opts.limit ?? 1000
    );
    return this._ingest.attributeExisting(ctx as any, opportunities as any);
  }

  /**
   * Release a held lease by token WITHOUT advancing the cursor,
   * so the unit can be immediately re-claimed by selecting it in the extension.
   * Safe to call on a stale or failed scan — if the token is invalid or already
   * released, returns false (no-op).
   */
  async releaseTask(taskId: string): Promise<boolean> {
    return this._lease.releaseByToken(taskId);
  }

  /**
   * Ingest posts collected outside a claimed scan task. Fan-out and scoring are
   * identical to the normal path.
   */
  async ingestCollectedPosts(
    orgId: string,
    collected: RawPost[]
  ): Promise<{ accepted: number; keywordMatched: number; scoreFiltered: number; staleFiltered: number; reason?: string }> {
    if (!collected.length) return { accepted: 0, keywordMatched: 0, scoreFiltered: 0, staleFiltered: 0, reason: 'no posts' };
    // Drop posts already past their platform's TTL up front: the test is
    // org-independent (platform + publish time), so doing it once here beats
    // repeating it inside every subscribing org's ingest, and it gives the
    // caller a counter — without one, "collected 100, stored 0" is undiagnosable.
    const { kept: posts, dropped: staleFiltered } =
      await this._ingest.filterExpiredByPublishTime(collected);
    if (!posts.length) {
      return { accepted: 0, keywordMatched: 0, scoreFiltered: 0, staleFiltered, reason: 'all posts older than their platform opportunity TTL' };
    }
    // Score + persist against EVERY enabled config (legacy null-project + each
    // project-scoped one), so a post matching a project-only keyword is kept and
    // its project-scoped opportunity state is written — not silently dropped
    // because only the null-project config was consulted.
    const ctxs = await this._engageRepo.getEnabledConfigsForOrg(orgId);
    if (!ctxs.length) return { accepted: 0, keywordMatched: 0, scoreFiltered: 0, staleFiltered, reason: 'no engage config found for org' };
    const withKeywords = ctxs.filter((c) => c.keywords.length);
    if (!withKeywords.length) {
      return { accepted: 0, keywordMatched: 0, scoreFiltered: 0, staleFiltered, reason: 'org has no enabled keywords configured' };
    }
    const minScore = Number(process.env.ENGAGE_MIN_SCORE ?? 60);

    let accepted = 0;
    let keywordMatched = 0;
    let scoreFiltered = 0;
    for (const ctx of withKeywords) {
      const allScored = this._ingest.scoreAllForOrg(posts, ctx as any);
      const scored = allScored.filter((p) => p.score >= minScore);
      keywordMatched += allScored.length;
      scoreFiltered += allScored.length - scored.length;
      this.logger.log(`[collected-ingest] projectId=${(ctx as any).projectId ?? null} posts=${posts.length} staleFiltered=${staleFiltered} keywordMatched=${allScored.length} scoreFiltered=${allScored.length - scored.length} minScore=${minScore} keywords=[${ctx.keywords.map((k) => k.keyword).join(', ')}]`);
      if (!scored.length) continue;
      accepted += await this._ingest.ingestForOrg(ctx as any, posts);
    }
    if (!keywordMatched) {
      const configured = [...new Set(withKeywords.flatMap((c) => c.keywords.map((k) => k.keyword)))].join(', ');
      return { accepted: 0, keywordMatched: 0, scoreFiltered, staleFiltered, reason: `no posts matched any keyword (configured: ${configured})` };
    }
    return { accepted, keywordMatched, scoreFiltered, staleFiltered };
  }

  /** Complete (if any) + claim next batch. Bootstrap = call with no `completed`. */
  async sync(
    orgId: string,
    body: { completed?: CompletedUnitInput; want?: number; force?: boolean; selectedUnits?: ScanUnitSelector[] }
  ): Promise<{ accepted: number; nextTasks: EngageScanTask[] }> {
    let accepted = 0;
    if (body.completed) {
      accepted = await this.ingestCompleted(body.completed);
    }
    const want = Math.min(Math.max(1, body.want ?? DEFAULT_WANT), MAX_WANT);
    // Snapshot the fast-lane hint BEFORE claiming, so the retraction below can
    // only drop the hint this claim actually accounted for — not one raised
    // while it was walking units (see clearEngageScanWork).
    const scoped = Array.isArray(body.selectedUnits);
    const hintToken = scoped ? null : await readEngageScanWork(orgId);

    const nextTasks = await this.claimNext(orgId, want, {
      force: body.force,
      selectedUnits: body.selectedUnits,
    });
    // Nothing left to hand out → drop the fast-lane hint so the extension's
    // 1-min probe stops asking for this expensive endpoint until new work is
    // written. Only on an EMPTY claim: a non-empty batch means the chained loop
    // is mid-drain and will come straight back for more.
    //
    // Never on the `selectedUnits` debug path: that asks about specific units,
    // so an empty result says nothing about the rest of the org — retracting an
    // org-wide hint from a unit-scoped query would let the Options panel park
    // genuinely due work on the 15-min backstop.
    if (!scoped && !nextTasks.length) await clearEngageScanWork(orgId, hintToken);
    return { accepted, nextTasks };
  }

  /**
   * Cheap "should the executor bother calling `sync`?" probe (one Redis GET).
   *
   * Backs the extension's 1-min fast-lane alarm, which exists so a keyword
   * created by e.g. operation-plan generation gets its first scan in ~a minute
   * instead of waiting out the 15-min backstop alarm. It is NOT a due
   * calculation: `sync` remains the authority on what is actually claimable,
   * and the backstop still calls it unconditionally — so a false negative here
   * costs latency, never coverage.
   */
  async hasPendingWork(orgId: string): Promise<boolean> {
    return hasEngageScanWork(orgId);
  }

  /**
   * Ingest a completed unit: validate the lease token → fan out the posts to
   * every subscribing org (server-side keyword match + persist) → advance the
   * cursor (server-DERIVED, not trusting the client) and release the lease.
   */
  private async ingestCompleted(completed: CompletedUnitInput): Promise<number> {
    this.logger.log(`[scan-ingest] ingestCompleted called, taskId=${completed.taskId}, posts=${completed.posts?.length ?? 0}`);
    const unit = await this._engageRepo.findScanCursorByToken(completed.taskId);
    if (!unit) {
      // Invalid / expired / rotated token, or the lease was reclaimed — ignore.
      this.logger.warn(`Ingest with stale/invalid lease token; dropped`);
      return 0;
    }

    const rawPosts = completed.posts ?? [];
    // Cursor is derived from the RAW yield, before the TTL gate: the cursor
    // tracks how far the scanner has read, not what we chose to keep. Deriving
    // it from the filtered set would replay the same expired page forever.
    const nextCursor = this._deriveCursor(rawPosts, completed.nextCursor);
    // Org-independent gate, applied once for the whole fan-out.
    const { kept: posts, dropped: staleFiltered } =
      await this._ingest.filterExpiredByPublishTime(rawPosts);

    let ctxs;
    try {
      ctxs = await this._engageRepo.getOrgContextsForUnit(
        unit.platform,
        unit.scanType as 'keyword' | 'channel' | 'tracked',
        unit.scanKey
      );
      this.logger.log(
        `[scan-ingest] unit=${unit.platform}/${unit.scanType}/${unit.scanKey} posts=${posts.length} staleFiltered=${staleFiltered} ctxs=${ctxs.length}`
      );
    } catch (err) {
      // Could not even resolve subscribers — release WITHOUT advancing so the
      // unit is retried, rather than stranding the shared lease for the TTL.
      this.logger.error(
        `Scan ingest: subscriber resolution failed for ${unit.platform}/${unit.scanType}/${unit.scanKey}: ${(err as Error).message}`
      );
      await this._lease.releaseByToken(completed.taskId).catch(() => undefined);
      return 0;
    }

    // Isolate per org: one org's transient ingest failure (LLM/DB) must NOT abort
    // the whole fan-out or strand the SHARED global lease — others still persist,
    // and the cursor still advances + releases below.
    let accepted = 0;
    for (const ctx of ctxs) {
      try {
        accepted += await this._ingest.ingestForOrg(ctx as any, posts);
      } catch (err) {
        this.logger.error(
          `Scan ingest fan-out failed for org=${(ctx as any).organizationId}: ${(err as Error).message}`
        );
      }
    }

    await this._lease
      .completeByToken(completed.taskId, nextCursor)
      .catch(() => undefined);
    return accepted;
  }

  /** Enumerate this org's due units, claim up to `want`, build instructions. */
  private async claimNext(
    orgId: string,
    want: number,
    opts: { force?: boolean; selectedUnits?: ScanUnitSelector[] } = {}
  ): Promise<EngageScanTask[]> {
    // ALL enabled configs — the legacy null-project row plus every project-scoped
    // one. A keyword/channel/tracked account activated on a project's config
    // (e.g. from a committed operation plan) must be scanned too, not only the
    // org-level ones. Scan units are global, so we merge across configs and dedup.
    const ctxs = await this._engageRepo.getEnabledConfigsForOrg(orgId);
    if (!ctxs.length) return [];

    const cadenceMs =
      (await this._entitlement.getScanIntervalHours(orgId)) * 3_600_000;
    const pacing = await this._config.getPacing();
    const platforms = await this._resolveScanPlatforms();
    const selectedUnitSet = Array.isArray(opts.selectedUnits)
      ? new Set(opts.selectedUnits.map((u) => this._selectorKey(u)))
      : null;

    // Enumerate every config's units, then dedup by global unit identity (a
    // keyword shared across projects is ONE global unit / cursor).
    const unitByKey = new Map<
      string,
      { platform: ScanTaskPlatform; scanType: ScanTaskType; scanKey: string }
    >();
    for (const ctx of ctxs) {
      for (const u of this._enumerateUnits(ctx, platforms)) {
        unitByKey.set(this._selectorKey(u), u);
      }
    }
    const units = selectedUnitSet
      ? [...unitByKey.values()].filter((u) => selectedUnitSet.has(this._selectorKey(u)))
      : [...unitByKey.values()];

    // Active normalised keywords across ALL enabled configs (deduped) — used to
    // build combined tracked+keyword and Reddit-channel queries.
    const activeKeywords = [
      ...new Set(
        ctxs
          .flatMap((ctx) => ctx.keywords)
          .filter((k) => k.enabled)
          .map((k) => normalizeKeyword(k.keyword))
          .filter(Boolean)
      ),
    ];

    const tasks: EngageScanTask[] = [];
    for (const u of units) {
      if (tasks.length >= want) break;
      const snap = await this._lease.claim({
        platform: u.platform,
        scanType: u.scanType,
        scanKey: u.scanKey,
        cadenceMs,
        force: opts.force || Boolean(selectedUnitSet),
      });
      if (snap) tasks.push(await this._buildTask(snap, pacing, activeKeywords));
    }
    return tasks;
  }

  private _selectorKey(u: ScanUnitSelector): string {
    return `${u.platform}:${u.scanType}:${u.scanKey}`;
  }

  /**
   * Resolve the live scan-platform allowlist:
   *   settings.operation_plan.allowed_platforms || ENGAGE_SUPPORTED_PLATFORMS
   * Delegated to EngageScanConfigService (which owns the Settings read + the
   * intersection with the scannable set). Falls back to the env-derived
   * ENV_SCAN_PLATFORMS when the config resolver is unavailable (partial mocks in
   * unit tests) or returns nothing — the gate must never open to zero silently
   * because of a wiring gap.
   */
  private async _resolveScanPlatforms(): Promise<ScanTaskPlatform[]> {
    try {
      const resolved = await this._config.getSupportedScanPlatforms?.();
      if (resolved?.length) return resolved as ScanTaskPlatform[];
    } catch (err) {
      this.logger.warn(
        `Scan platform resolution failed; using env fallback: ${(err as Error).message}`
      );
    }
    return ENV_SCAN_PLATFORMS;
  }

  /** Org config → flat list of global scan units (keyword × platform, channel,
   * tracked). Keyword text is normalised to the global scanKey. `platforms` is
   * the resolved allowlist (settings → env; see _resolveScanPlatforms). */
  private _enumerateUnits(
    ctx: {
      keywords: { keyword: string; enabled: boolean }[];
      monitoredChannels: { platform: string; channelId: string }[];
      trackedAccounts: { platform: string; username: string }[];
    },
    platforms: ScanTaskPlatform[]
  ): { platform: ScanTaskPlatform; scanType: ScanTaskType; scanKey: string }[] {
    const units: {
      platform: ScanTaskPlatform;
      scanType: ScanTaskType;
      scanKey: string;
    }[] = [];

    // The resolved allowlist is a hard gate on EVERY unit type (keyword/channel/
    // tracked), so an operator can fully kill a platform — e.g. an operation-plan
    // allowlist of just `reddit` (or `ENGAGE_SUPPORTED_PLATFORMS=reddit`) stops
    // all X scanning (X via the user's personal session is anti-automation-risky)
    // without a code change.
    const supported = new Set<ScanTaskPlatform>(platforms);

    for (const kw of ctx.keywords) {
      if (!kw.enabled) continue;
      const scanKey = normalizeKeyword(kw.keyword);
      if (!scanKey) continue;
      for (const platform of platforms) {
        units.push({ platform, scanType: 'keyword', scanKey });
      }
    }
    // Channels and accounts are rows of ONE table split by `platform`, so both
    // lists funnel through the same loop and `scanTypeFor` picks the scope. This
    // is what retired the old per-list platform allowlists, which overlapped on
    // x and reddit and could emit a unit no scanner could serve (an x 'channel'
    // was searched as a bare keyword, a reddit 'tracked' fetched as /r/<user>).
    const targets = [
      ...ctx.monitoredChannels.map((c) => ({
        platform: c.platform,
        key: c.channelId,
      })),
      ...ctx.trackedAccounts.map((a) => ({
        platform: a.platform,
        key: a.username,
      })),
    ];
    for (const t of targets) {
      // Canonicalise before EVERY use: `scanTypeFor` lowercases, so comparing
      // the raw column against `supported` would classify a legacy `"Reddit"`
      // row as a channel here and as an author target in every SQL filter.
      const platform = normalizePlatform(t.platform) as ScanTaskPlatform;
      if (!supported.has(platform)) {
        this.logger.debug(
          `[scan-units] skipping ${t.platform}:${t.key} — platform not in the resolved allowlist`
        );
        continue;
      }
      units.push({
        platform,
        scanType: scanTypeFor(platform),
        // Normalized so this shares ONE cursor with the workflow writer + the
        // status reader (they all key targets via scanKeyFor/normalizeUsername).
        scanKey: scanKeyFor({ platform, username: t.key }),
      });
    }
    return units;
  }

  /** Build the client instruction from a claimed snapshot + pacing config. */
  private async _buildTask(
    snap: ScanCursorSnapshot,
    pacing: EngageScanPacing,
    orgKeywords: string[] = []
  ): Promise<EngageScanTask> {
    const platform = snap.platform as ScanPlatform;
    // First scan of a unit (no cursor yet) does the deeper "initial" lookback.
    // A unit that HAS a cursor but hasn't been scanned within the freshness
    // window (e.g. the extension was offline for days) is just as uninformed
    // as a brand-new one — a single incremental page can't close that gap, so
    // treat it as "initial" again rather than silently under-scanning it.
    const hasCursor = Boolean(snap.lastSeenExternalId || snap.lastSeenAt);
    let phase: 'initial' | 'incremental' = hasCursor ? 'incremental' : 'initial';
    if (hasCursor) {
      // A cursor with no timestamp (should not normally happen, but the two
      // fields are independently nullable) can't be proven fresh — treat it
      // the same as stale rather than silently trusting it.
      const freshnessMs = snap.lastSeenAt
        ? await this._config.getFreshnessWindowMs(platform)
        : 0;
      const staleMs = snap.lastSeenAt
        ? Date.now() - snap.lastSeenAt.getTime()
        : Infinity;
      if (staleMs > freshnessMs) {
        phase = 'initial';
      }
    }
    const page = pacing.extension[platform][phase];

    // For X tracked units: narrow the query to org keywords so the extension
    // does `from:account (kw1 OR kw2) -filter:retweets` rather than fetching
    // all of the account's posts and relying on server-side keyword matching.
    // This cuts irrelevant data and reduces request volume (account safety).
    //
    // For Reddit channel units: narrow `/r/{sub}/new.json` to a keyword search
    // via `/r/{sub}/search?q=(kw1 OR kw2)&restrict_sr=on&sort=new` so the
    // extension only pulls keyword-relevant posts instead of the full firehose.
    //
    // Both rawQuerys are ephemeral — built at claim time from current keywords.
    // The cursor key (scanKey) is unchanged.
    let rawQuery: string | undefined;
    if (snap.scanType === 'tracked' && snap.platform === 'x' && orgKeywords.length) {
      rawQuery = buildTrackedKeywordQuery(snap.scanKey, orgKeywords);
    } else if (snap.scanType === 'channel' && snap.platform === 'reddit' && orgKeywords.length) {
      rawQuery = buildRedditChannelKeywordQuery(orgKeywords);
    }

    return {
      taskId: snap.leaseToken, // the client only ever sees the rotating token
      platform: snap.platform as ScanTaskPlatform,
      scanType: snap.scanType as ScanTaskType,
      scanKey: snap.scanKey,
      cursor: {
        lastSeenExternalId: snap.lastSeenExternalId,
        lastSeenAt: snap.lastSeenAt ? snap.lastSeenAt.toISOString() : null,
      },
      pacing: {
        maxPages: page.maxPages,
        pageSize: page.pageSize,
        pageDelayMs: page.pageDelayMs,
        pageJitterMs: page.jitterMs,
        interUnitDelayMs: pacing.extension.interUnit.delayMs,
        interUnitJitterMs: pacing.extension.interUnit.jitterMs,
        hourlyRequestCap: pacing.extension.session.hourlyRequestCap,
      },
      rawQuery,
    };
  }

  /**
   * Server-side cursor derivation: the newest post the extension returned (by
   * publish time) becomes the resume point. NEVER trusts a client-sent cursor to
   * move PAST that — a malicious client must not be able to advance the cursor
   * beyond real data and skip posts. The client cursor is only used to fill a
   * gap when no posts were returned (incremental no-op).
   */
  private _deriveCursor(
    posts: RawPost[],
    clientCursor?: { lastSeenExternalId?: string | null; lastSeenAt?: Date | null },
    now: number = Date.now()
  ): { lastSeenExternalId: string | null; lastSeenAt: Date | null } {
    // Only NON-FUTURE posts may advance the cursor. The shared global cursor is
    // resumed from `lastSeenExternalId`/`lastSeenAt`; a forged future-dated post
    // (client-controlled postPublishedAt) would otherwise jump the cursor past
    // real data and make every other org's next incremental scan skip genuine
    // posts. Future-dated entries are ignored entirely (id AND timestamp).
    const eligible = posts.filter((p) => p.postPublishedAt.getTime() <= now);
    if (eligible.length) {
      let newest = eligible[0];
      for (const p of eligible) {
        if (p.postPublishedAt > newest.postPublishedAt) newest = p;
      }
      return {
        lastSeenExternalId: newest.externalPostId,
        lastSeenAt: newest.postPublishedAt,
      };
    }
    // No eligible (non-future) posts → do not advance from posts.
    return {
      lastSeenExternalId: clientCursor?.lastSeenExternalId ?? null,
      lastSeenAt: clientCursor?.lastSeenAt ?? null,
    };
  }
}
