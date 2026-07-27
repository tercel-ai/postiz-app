// Build-time feature flags for the executor.
//
// X (Twitter) scan + metrics go through the user's PERSONAL x.com session via
// internal GraphQL, which X's anti-automation flags aggressively (it has
// temp-limited real accounts in testing). So the X executor is OFF BY DEFAULT
// and must be explicitly opted into at build time:
//
//   ENGAGE_X_ENABLED=true   (e.g. in a pack profile or the build env)
//
// Anything else (unset / "false" / "0") keeps X disabled — the executor refuses
// X scan tasks and skips X metrics, so a stray backend X task can never drive a
// request to x.com. Reddit (public .json) is unaffected. Pair with the backend
// allowlist ENGAGE_SUPPORTED_PLATFORMS for end-to-end control.
const rawXEnabled = (
  import.meta.env?.ENGAGE_X_ENABLED ??
  process?.env?.ENGAGE_X_ENABLED ??
  ''
)
  .toString()
  .trim()
  .toLowerCase();

export const X_EXECUTOR_ENABLED = rawXEnabled === 'true' || rawXEnabled === '1';

// LinkedIn scan + metrics drive a real linkedin.com tab with the user's PERSONAL
// session and scrape the rendered DOM. LinkedIn flags automation at least as
// aggressively as X, so the LinkedIn executor is OFF BY DEFAULT and opted into at
// build time the same way:
//
//   ENGAGE_LINKEDIN_ENABLED=true   (e.g. in a pack profile or the build env)
//
// Anything else keeps it disabled — the executor refuses LinkedIn scan tasks and
// skips LinkedIn metrics, so a stray backend LinkedIn task can never drive a
// request to linkedin.com. This gates the BACKGROUND read paths only; the
// user-initiated post-publish poster is not gated (mirrors the X poster).
const rawLinkedinEnabled = (
  import.meta.env?.ENGAGE_LINKEDIN_ENABLED ??
  process?.env?.ENGAGE_LINKEDIN_ENABLED ??
  ''
)
  .toString()
  .trim()
  .toLowerCase();

export const LINKEDIN_EXECUTOR_ENABLED =
  rawLinkedinEnabled === 'true' || rawLinkedinEnabled === '1';

// Medium + Quora BACKGROUND metrics drive a real medium.com / quora.com tab with
// the user's personal session and scrape the rendered engagement counters (claps
// / responses, upvotes / views). Both platforms flag automation, so — exactly
// like X and LinkedIn — the background read path is OFF BY DEFAULT and opted into
// at build time:
//
//   ENGAGE_MEDIUM_ENABLED=true
//   ENGAGE_QUORA_ENABLED=true
//
// Anything else keeps them disabled, so a stray backend metrics task can never
// drive a request to medium.com / quora.com. This gates the BACKGROUND read path
// only; the user-initiated post-publish posters are NOT gated (mirrors X/
// LinkedIn: the poster runs only when the user asked to publish).
const rawMediumEnabled = (
  import.meta.env?.ENGAGE_MEDIUM_ENABLED ??
  process?.env?.ENGAGE_MEDIUM_ENABLED ??
  ''
)
  .toString()
  .trim()
  .toLowerCase();

export const MEDIUM_EXECUTOR_ENABLED =
  rawMediumEnabled === 'true' || rawMediumEnabled === '1';

const rawQuoraEnabled = (
  import.meta.env?.ENGAGE_QUORA_ENABLED ??
  process?.env?.ENGAGE_QUORA_ENABLED ??
  ''
)
  .toString()
  .trim()
  .toLowerCase();

export const QUORA_EXECUTOR_ENABLED =
  rawQuoraEnabled === 'true' || rawQuoraEnabled === '1';
