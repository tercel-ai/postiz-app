// The single switch for reading X from the SERVER.
//
// Principle (docs/engage/x-tab-only-migration.md): X content is collected by
// opening a background browser tab in the extension and intercepting the request
// x.com's OWN JavaScript fires — never by calling the X API directly from the
// server. A tab-driven read carries the browser's authentic fingerprint
// (`x-client-transaction-id`, `Referer`, `sec-fetch-*`, page context) because
// x.com's own code produced it; a server-side API call does not, which is what
// carries automation-risk for the account.
//
// WHY DEFAULT OFF. Every other X switch in this codebase defaults ON and turns
// off only when explicitly set to `false` (`ENGAGE_X_SCAN_ENABLED`), so a host
// that never heard of the variable calls the X API. This one inverts that: an
// unset, misspelt, or dropped variable leaves the server silent. The failure
// mode of a config mistake should be "we collected nothing" (recoverable: the
// extension is the primary path anyway) and never "we hit X from a datacentre
// IP" (not recoverable — the account carries it).
//
// WHAT IT GATES. Every server-side READ of the X API:
//   · engage keyword / tracked scan   (third-party content — the whole reason)
//   · our own reply's metrics         (own token, own post — but the extension
//                                      covers it via metrics.reply.ts)
//   · reply-author profile lookup     (own reply's handle; degrades to
//                                      handle-only, so gating it is cosmetic)
//
// WHAT IT DOES NOT GATE: `integrations/social/x.provider.ts` — that is
// PUBLISHING to the org's own account with the org's own OAuth token. Writing as
// yourself is the sanctioned use of the API and has nothing to do with the
// scraping-risk this switch exists for. Gating it would simply break posting.

/** Env name, exported so tests and docs cannot drift from the implementation. */
export const X_API_ENABLED_ENV = 'X_API_ENABLED';

/**
 * True only when the server is explicitly allowed to call the X API.
 *
 * Accepts `true` / `1` / `yes` (case-insensitive, trimmed). ANYTHING else —
 * unset, empty, `false`, a typo — is OFF. Read at call time rather than cached
 * at import so a test (or a process that reloads config) can flip it without
 * re-importing the module graph.
 */
export function xApiEnabled(): boolean {
  const raw = (process.env[X_API_ENABLED_ENV] ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/**
 * One-line reason to log when a caller is about to skip an X read, so a "why is
 * there no X data?" investigation lands on the switch instead of on the
 * collector.
 */
export function xApiDisabledReason(what: string): string {
  return `${what} skipped: ${X_API_ENABLED_ENV} is not enabled — X is read through the extension's browser tab, not the server API (docs/engage/x-tab-only-migration.md).`;
}
