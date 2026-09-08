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
  /** Re-hosted avatar url, or null when the connect flow never got one. */
  picture?: string | null;
}

/** What the extension reported for one platform. */
export interface ExtensionSessionEntry {
  id?: string;
  handle?: string;
  name?: string;
  picture?: string;
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
 * Put a platform account id in the form `Integration.internalId` stores.
 *
 * Reddit is the one platform whose two sides disagree: the OAuth flow stores
 * what `/api/v1/me` returns as `id` (bare, e.g. `abc123`), while the extension
 * recovers the id from the session JWT, where it appears as a Reddit "fullname"
 * — the same id behind a `t2_` type prefix. Comparing them raw is why a Reddit
 * login never matched its own channel: the id comparison failed, and the handle
 * fallback had nothing to work with (the cookie-only probe reports no handle).
 *
 * Applied to BOTH sides, so it also covers rows already created carrying the
 * prefixed form. The prefix is Reddit-specific, so no other platform's id can
 * be altered by this.
 */
export function normalizeAccountId(value: string): string {
  return value.trim().replace(/^t2_/i, '');
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
    const target = normalizeAccountId(entry.id);
    const byId = candidates.find(
      (c) => normalizeAccountId(c.internalId) === target
    );
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
 * An avatar url worth handing to the storage uploader, which FETCHES it. Only
 * http(s): a `blob:`/`data:`/relative url resolves to nothing on this server, so
 * storing one would cost a failed fetch and a broken picture.
 */
export function isFetchableAvatar(url: string | undefined | null): url is string {
  return !!url && /^https?:\/\//i.test(url.trim());
}

/**
 * File extensions a stored "avatar" can carry that prove it is NOT an image.
 *
 * The uploader trusts whatever content-type the origin returned, so an avatar
 * url that answered with an error page (or a login redirect) was stored as
 * `<id>.html` and has been rendering as a broken picture ever since. Such a row
 * is treated as having no picture at all, so the next report can replace it.
 */
const NON_IMAGE_EXTENSIONS = new Set(['html', 'htm', 'json', 'txt', 'xml']);

/** Whether a row's stored picture is one we should keep rather than replace. */
export function isUsableStoredPicture(picture: string | null | undefined): boolean {
  const value = picture?.trim();
  if (!value) return false;
  // Compare on the PATH only: a query string routinely contains dots of its own.
  const path = value.split(/[?#]/)[0];
  const extension = path.slice(path.lastIndexOf('/') + 1).split('.').pop();
  // No extension at all is unjudgeable (many CDNs serve avatars that way) —
  // leave it alone rather than churning storage on a picture that may be fine.
  if (!extension || extension === path) return true;
  return !NON_IMAGE_EXTENSIONS.has(extension.toLowerCase());
}

/** The identity a new Integration is created from, when a report carries one. */
export interface ExtensionSessionSeed {
  internalId: string;
  name: string;
  username: string;
  picture?: string;
}

/**
 * What a reported login would create as an Integration, or null when it does
 * not identify the account well enough to create one.
 *
 * `internalId` prefers the platform's own account id and falls back to the
 * handle — mirroring the manual connect flow for these platforms, whose
 * providers set `id = username` because a handle is the only identifier the
 * platform exposes without an API (see quora/hackernews/medium providers).
 * A login with neither is a signed-in browser we cannot name, and naming is the
 * whole point of the row, so it creates nothing.
 */
export function buildExtensionSessionSeed(
  entry: ExtensionSessionEntry
): ExtensionSessionSeed | null {
  // Stored in the form the OAuth flow would store it, so connecting the same
  // account properly later UPDATES this row instead of adding a second one
  // (createOrUpdateIntegration upserts on organizationId + internalId).
  const id = entry.id ? normalizeAccountId(entry.id) : undefined;
  const handle = entry.handle?.trim();
  const internalId = id || handle;
  if (!internalId) return null;

  const username = handle || internalId;
  const picture = entry.picture?.trim();

  return {
    internalId,
    name: entry.name?.trim() || username,
    username,
    ...(isFetchableAvatar(picture) ? { picture } : {}),
  };
}

/** Display fields a report may correct on an integration that already exists. */
export interface ExtensionSessionSync {
  /** The platform handle, when the stored one has demonstrably gone stale. */
  profile?: string;
  /** Source avatar url to store, when the row effectively has no picture. */
  picture?: string;
}

/**
 * What the matched row should have corrected from this report.
 *
 * Deliberately narrow, because this runs every hour against rows a user can
 * also edit by hand:
 *   - `profile` only when the report matched the row by PLATFORM ID. That is
 *     the one case where "same account, different handle" is a fact rather than
 *     a guess — a handle-only match cannot tell a renamed account apart from a
 *     different one, and would happily write a handle onto the wrong row.
 *   - `picture` only when the row has none (or has the broken non-image kind).
 *     The stored picture is a re-hosted copy, so it can never compare equal to
 *     the platform url; refreshing on every report would re-upload hourly and
 *     overwrite a picture the user set themselves.
 *   - `name` never. A channel can be renamed in the UI, and a report has no way
 *     to tell that rename from a stale name.
 */
export function planExtensionSessionSync(
  row: ExtensionSessionCandidate,
  entry: ExtensionSessionEntry
): ExtensionSessionSync {
  const sync: ExtensionSessionSync = {};

  const handle = entry.handle?.trim();
  const matchedById =
    !!entry.id &&
    normalizeAccountId(row.internalId) === normalizeAccountId(entry.id);
  if (matchedById && handle) {
    if (!row.profile || normalizeHandle(row.profile) !== normalizeHandle(handle)) {
      sync.profile = handle;
    }
  }

  const picture = entry.picture?.trim();
  if (isFetchableAvatar(picture) && !isUsableStoredPicture(row.picture)) {
    sync.picture = picture;
  }

  return sync;
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
