/**
 * Scan-target scope resolution + the legacy "monitored channel" shape.
 *
 * `EngageTrackedAccount` is the single scan-target table: one row per thing the
 * scan loop polls. What that row MEANS is decided by `platform` alone — there is
 * no discriminator column, because no platform has both a channel scope and an
 * author scope. Reddit targets a community (a subreddit); every other platform
 * targets an author feed. Deriving the scope instead of storing it is what makes
 * a "reddit tracked account" or an "x monitored channel" unrepresentable — both
 * were creatable before the merge and neither had a scanner that could serve it.
 *
 * If a platform ever needs BOTH scopes (e.g. tracking a u/ handle on Reddit),
 * the migration is to add a nullable `targetType` column that overrides this
 * derivation — not to split the table again.
 */

import { BadRequestException } from '@nestjs/common';
import {
  isValidUsername,
  normalizeUsername,
} from '@gitroom/nestjs-libraries/engage/engage-scan-lease.service';
import { SCANNABLE_PLATFORMS } from '@gitroom/nestjs-libraries/engage/engage-scan-config.service';

/** Scan scopes a target row can produce. Mirrors `EngageScanCursor.scanType`. */
export type ScanTargetScope = 'channel' | 'tracked';

/**
 * Platforms whose scan target is a COMMUNITY rather than an author. Reddit only:
 * its scanner fetches `/r/<key>/new.json`. Everything else resolves a per-author
 * feed and is `tracked`.
 */
export const CHANNEL_SCOPE_PLATFORMS = new Set<string>(['reddit']);

/**
 * Canonical form of a platform identifier. `platform` is a free-form string at
 * the DTO boundary, but it decides the row's SCOPE, and every predicate derived
 * from that decision (the `in`/`notIn` list filters, the scan-unit allowlist,
 * the per-platform entitlement pool) compares it as stored. Canonicalising once
 * on write is what keeps `scanTypeFor` — which lowercases — from disagreeing
 * with those comparisons: a row stored as `"Reddit"` would otherwise be a
 * channel to the partitioner and an author target to every SQL filter.
 */
export function normalizePlatform(platform: string | null | undefined): string {
  return (platform ?? '').trim().toLowerCase();
}

/** The scan scope a target row on `platform` produces. */
export function scanTypeFor(platform: string | null | undefined): ScanTargetScope {
  return CHANNEL_SCOPE_PLATFORMS.has(normalizePlatform(platform))
    ? 'channel'
    : 'tracked';
}

/**
 * Bare subreddit name. Reddit community names are 2–21 chars of `[a-z0-9_]` —
 * NOT the same alphabet as a Reddit *username*, which also allows `-` and runs
 * to 30 chars. Exported so the operation-plan resolver and the write boundary
 * validate against ONE rule; validating a community key with the handle rule
 * accepted `foo-bar` (never a real subreddit) and silently turned `u/alice`
 * into a subreddit named `alice`.
 */
export const SUBREDDIT_NAME_RE = /^[a-z0-9_]{2,21}$/;

/** Is `normalizedKey` a legal target key for this platform's SCOPE? */
export function isValidTargetKey(platform: string, normalizedKey: string): boolean {
  return scanTypeFor(platform) === 'channel'
    ? SUBREDDIT_NAME_RE.test(normalizedKey)
    : isValidUsername(platform, normalizedKey);
}

/**
 * THE write boundary for a scan target. Every path that inserts into
 * `EngageTrackedAccount` must go through this — the per-row add endpoints AND
 * the bulk setup path, which previously wrote the same table from the same
 * externally-supplied DTO with neither guard, so a `monitoredChannels` entry on
 * platform `x` became a tracked target whose key was interpolated unescaped
 * into the shared X `from:` query.
 *
 * Canonicalises the platform, asserts the caller reached the door matching that
 * platform's scope, normalises the key to its canonical scan-unit form, and
 * validates it against the SCOPE's alphabet. Throws `BadRequestException` —
 * these are all client-input errors.
 */
export function buildScanTargetKey(
  rawPlatform: string | null | undefined,
  rawKey: string,
  expectedScope: ScanTargetScope
): { platform: string; username: string } {
  const platform = normalizePlatform(rawPlatform);
  if (!platform) {
    throw new BadRequestException('A scan target requires a platform.');
  }
  // Does a scanner exist for this platform AT ALL? Deliberately checked against
  // the capability list, not the operator's current allowlist: a disabled
  // platform is a config state someone flips, but a platform with no scanner
  // can never produce a unit. Without this, `POST /engage/tracked-accounts
  // {platform:'youtube'}` returned 200 and stored a row that shows in the
  // settings UI and consumes the org's per-platform priority-accounts budget,
  // while `_enumerateUnits` silently skips it forever — the same defect the
  // channel door was narrowed to eliminate.
  if (!(SCANNABLE_PLATFORMS as readonly string[]).includes(platform)) {
    throw new BadRequestException(
      `Platform "${platform}" has no scanner — engage cannot collect from it. ` +
        `Supported: ${[...SCANNABLE_PLATFORMS].join(', ')}.`
    );
  }
  if (scanTypeFor(platform) !== expectedScope) {
    throw new BadRequestException(
      expectedScope === 'channel'
        ? `Platform "${platform}" has no channel scope — add it as a tracked account instead.`
        : `Platform "${platform}" has no author scope — add it as a monitored channel instead.`
    );
  }

  const username = normalizeUsername(platform, rawKey ?? '');
  if (!isValidTargetKey(platform, username)) {
    throw new BadRequestException(
      expectedScope === 'channel'
        ? `Invalid ${platform} channel "${rawKey}": use a plain community name (2-21 chars, letters, digits, _).`
        : `Invalid ${platform} username "${rawKey}": use a plain handle (letters, digits, _${
            platform === 'reddit' ? ', -' : ''
          }).`
    );
  }
  return { platform, username };
}

/** A scan-target row, narrowed to the fields the shape helpers below touch. */
export interface ScanTargetRow {
  id: string;
  configId: string;
  organizationId: string;
  platform: string;
  username: string;
  displayName?: string | null;
  picture?: string | null;
  categoryLabel?: string | null;
  audienceSize: number;
  enabled: boolean;
  lastCheckedAt?: Date | null;
  metadata?: unknown;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A channel-scope row rendered in the legacy `EngageMonitoredChannel` field
 * names. The `/engage/monitored-channels` routes and the two frontend components
 * that read them keep this shape after the table merge — the alias is what let
 * the merge ship without a coordinated frontend/extension release.
 */
export interface MonitoredChannelShape {
  id: string;
  configId: string;
  organizationId: string;
  platform: string;
  channelId: string;
  channelName: string;
  audienceSize: number;
  enabled: boolean;
  lastScannedAt: Date | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}

/** Render one channel-scope target row in the legacy monitored-channel shape. */
export function toChannelShape<T extends ScanTargetRow>(
  row: T
): MonitoredChannelShape {
  return {
    id: row.id,
    configId: row.configId,
    organizationId: row.organizationId,
    platform: row.platform,
    channelId: row.username,
    // channelName was NOT NULL before the merge; displayName is optional, so
    // fall back to the key rather than emitting null into the old contract.
    channelName: row.displayName ?? row.username,
    audienceSize: row.audienceSize,
    enabled: row.enabled,
    lastScannedAt: row.lastCheckedAt ?? null,
    metadata: row.metadata ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Split a config's scan targets into the two lists callers still consume:
 * `monitoredChannels` (channel scope, legacy field names) and `trackedAccounts`
 * (author scope, unchanged). One pass, order-preserving.
 */
export function partitionScanTargets<T extends ScanTargetRow>(
  rows: T[]
): { monitoredChannels: MonitoredChannelShape[]; trackedAccounts: T[] } {
  const monitoredChannels: MonitoredChannelShape[] = [];
  const trackedAccounts: T[] = [];
  for (const row of rows) {
    if (scanTypeFor(row.platform) === 'channel') {
      monitoredChannels.push(toChannelShape(row));
    } else {
      trackedAccounts.push(row);
    }
  }
  return { monitoredChannels, trackedAccounts };
}

/**
 * The scan-unit key for a target row — the value `EngageScanCursor.scanKey`
 * carries for BOTH scopes. Both normalize through `normalizeUsername`, so a
 * subreddit stored as `r/AskReddit` and one stored as `askreddit` resolve to the
 * same cursor. Use this rather than calling `normalizeUsername` directly at a
 * key-derivation site: one call shape means a future change to how targets are
 * keyed has exactly one place to land.
 */
export function scanKeyFor(row: {
  platform: string | null | undefined;
  username: string;
}): string {
  return normalizeUsername(normalizePlatform(row.platform) || 'x', row.username);
}
