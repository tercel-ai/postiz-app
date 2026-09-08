/**
 * Pure helpers for consuming an extension session report (PATCH
 * /integrations/extension-session). Kept out of IntegrationService so the
 * matching rules can be tested without standing up the Nest module and its
 * database dependencies — the rules are where the subtle cases live, not the
 * writes around them.
 */

/** One integration considered as a match target for a reported platform login. */
export interface ExtensionSessionCandidate {
  id: string;
  /** Platform-side account id, what `PlatformLoginEntry.id` is comparable to. */
  internalId: string;
  /** Human-readable handle as stored by the OAuth flow; the fallback match key. */
  profile: string | null;
}

/** What the extension reported for one platform. */
export interface ExtensionSessionEntry {
  id?: string;
  handle?: string;
}

/**
 * Conservative normalization for comparing a reported handle against
 * `Integration.profile`. Case and the platform's display prefixes (`@` on X,
 * `u/` on Reddit) are the only differences we treat as noise — anything else
 * is left to fail the comparison rather than guessed at, since per-platform
 * `profile` formatting hasn't been audited across all seven platforms.
 */
export function normalizeHandle(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, '').replace(/^u\//, '');
}

/**
 * Resolve which integration (if any) the browser is currently signed into for
 * a platform, given every integration the org has on it.
 *
 * `internalId` wins: it is the platform's own account id on both sides, so it
 * matches exactly. `handle` is a fallback for platforms whose probe could not
 * recover an id — weaker, because a handle can be changed on the platform
 * while the account stays the same. No match returns null; the caller leaves
 * every row at API rather than guessing which one to flip.
 */
export function matchExtensionSessionCandidate(
  entry: ExtensionSessionEntry,
  candidates: ReadonlyArray<ExtensionSessionCandidate>
): string | null {
  if (entry.id) {
    const byId = candidates.find((c) => c.internalId === entry.id);
    if (byId) return byId.id;
  }

  if (entry.handle) {
    const target = normalizeHandle(entry.handle);
    const byHandle = candidates.find(
      (c) => !!c.profile && normalizeHandle(c.profile) === target
    );
    if (byHandle) return byHandle.id;
  }

  return null;
}

/**
 * Merge this report's diagnostic handle into a row's existing `metadata`,
 * preserving every other key. `metadata` is a shared bucket — anything else
 * stored there must survive the hourly session report, so this replaces one
 * key rather than the whole object. Returns null when nothing is left to
 * store, so the caller can clear the column instead of leaving `{}` behind.
 */
export function mergeSessionHandleIntoMetadata(
  existing: unknown,
  handle: string | null
): Record<string, unknown> | null {
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};

  if (handle) {
    base.extensionSessionHandle = handle;
  } else {
    delete base.extensionSessionHandle;
  }

  return Object.keys(base).length > 0 ? base : null;
}
