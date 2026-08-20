/**
 * `EngageConfig.metadata` — the single home for this row's per-project SETTINGS,
 * and the only place that knows how to read them.
 *
 * Every setting here used to be (or was about to become) its own column. None of
 * them is ever queried BY: the driver loads the config row and reads them in
 * code, so a column bought a migration per knob and bought nothing back.
 * `enabled` stays a column precisely because scan enumeration DOES filter on it.
 *
 * Reads go through `readEngageConfigMetadata` and writes through
 * `mergeEngageConfigMetadata`, so defaults and validation are applied in exactly
 * one place. Nothing here trusts the stored shape: the column is JSON, so a
 * value of the wrong type is always possible and always falls to the safe side.
 */

/** Per-(project, platform) policy — reply keys and publishing keys share one object. */
export interface EngagePlatformPolicy {
  // ── Reply side ──────────────────────────────────────────────────────────
  autoReplyEnabled?: boolean;
  /** Local-time window 'HH:MM'; absent = no window restriction. */
  windowStart?: string;
  windowEnd?: string;
  /** IANA timezone the window is expressed in. */
  timezone?: string;
  defaultStrategy?: string;
  length?: 'short' | 'medium' | 'long';
  mentionTags?: string[];
  /** Minimum minutes between two auto-replies on THIS platform. */
  checkIntervalMinutes?: number;

  // ── Publishing side ─────────────────────────────────────────────────────
  publishingEnabled?: boolean;
  publishingWindowStart?: string;
  publishingWindowEnd?: string;
  publishingTimezone?: string;
}

export type AutoReplyMode = 'off' | 'review' | 'auto';

export interface EngageConfigMetadata {
  /** Automation master switch. */
  automationEnabled: boolean;
  /**
   * Scheduled-publishing feature switch, or `null` for "never set explicitly" —
   * which callers resolve from the platform selection instead. Three states, not
   * two: a plain boolean could not tell "deliberately off" from "never
   * configured", and those resolve oppositely.
   */
  publishingEnabled: boolean | null;
  /** Managed-replies feature switch; the mode IS the switch. */
  autoReplyMode: AutoReplyMode;
  replyPolicies: Record<string, EngagePlatformPolicy>;
}

/** What a caller may change. Absent keys are left as they are. */
export type EngageConfigMetadataPatch = Partial<{
  automationEnabled: boolean;
  publishingEnabled: boolean;
  autoReplyMode: AutoReplyMode;
  replyPolicies: Record<string, EngagePlatformPolicy>;
}>;

/** The row shape this module reads. */
export interface EngageConfigMetadataSource {
  metadata?: unknown;
}

const AUTO_REPLY_MODES: readonly AutoReplyMode[] = ['off', 'review', 'auto'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asMode(value: unknown): AutoReplyMode | null {
  return typeof value === 'string' && (AUTO_REPLY_MODES as readonly string[]).includes(value)
    ? (value as AutoReplyMode)
    : null;
}

/** Keeps only well-formed per-platform objects, lower-casing the platform key. */
function asPolicies(value: unknown): Record<string, EngagePlatformPolicy> | null {
  if (!isPlainObject(value)) return null;
  const out: Record<string, EngagePlatformPolicy> = {};
  for (const [platform, policy] of Object.entries(value)) {
    // A non-object value here would be spread into indexed characters by any
    // merge downstream ({...'ab'} -> {0:'a',1:'b'}), quietly corrupting the row.
    if (!isPlainObject(policy)) continue;
    out[platform.toLowerCase()] = policy as EngagePlatformPolicy;
  }
  return out;
}

/** Resolve a config row's settings, with defaults applied. */
export function readEngageConfigMetadata(
  row: EngageConfigMetadataSource | null | undefined
): EngageConfigMetadata {
  const meta = isPlainObject(row?.metadata) ? row!.metadata : {};

  // Absent resolves to 'off' deliberately: replying with a real account's
  // session is the irreversible part of this feature.
  const mode = asMode(meta.autoReplyMode) ?? 'off';
  const policies = asPolicies(meta.replyPolicies) ?? {};

  return {
    // Absent = FALSE. Automation publishes and replies with the user's real
    // accounts, so the absence of a setting must never grant that permission —
    // same reason `enabled` defaults to off. A malformed value lands here too,
    // which is the safe side for exactly the same reason.
    automationEnabled:
      typeof meta.automationEnabled === 'boolean' ? meta.automationEnabled : false,
    // Absent = null, NOT false — the caller derives it from the platform
    // selection so a pre-switch project keeps behaving exactly as before.
    publishingEnabled:
      typeof meta.publishingEnabled === 'boolean' ? meta.publishingEnabled : null,
    autoReplyMode: mode,
    replyPolicies: policies,
  };
}

/**
 * Fold a patch onto a row's current settings and return the whole object to
 * store. Returns the FULL resolved set, not just the patch, so the stored blob
 * is always self-describing rather than a sparse diff readers have to reassemble.
 *
 * `replyPolicies` is replaced, not deep-merged: callers that mean to change one
 * platform pass the merged map (they have to, since they alone know which keys
 * they own), and a deep merge here would make removing a key impossible.
 */
export function mergeEngageConfigMetadata(
  row: EngageConfigMetadataSource | null | undefined,
  patch: EngageConfigMetadataPatch
): EngageConfigMetadata {
  const current = readEngageConfigMetadata(row);
  return {
    automationEnabled: patch.automationEnabled ?? current.automationEnabled,
    publishingEnabled:
      patch.publishingEnabled !== undefined
        ? patch.publishingEnabled
        : current.publishingEnabled,
    autoReplyMode: patch.autoReplyMode ?? current.autoReplyMode,
    replyPolicies: asPolicies(patch.replyPolicies) ?? current.replyPolicies,
  };
}

/**
 * Does this project reply unattended right now? The managed-replies half of the
 * switch chain, minus the per-platform level (applied later, per platform).
 *
 * Expressed once so the driver's filter and the API's `active` flag can never
 * disagree about what "on" means.
 */
export function isRepliesActive(meta: EngageConfigMetadata): boolean {
  return meta.automationEnabled && meta.autoReplyMode !== 'off';
}
