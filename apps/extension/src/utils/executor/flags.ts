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

// LinkedIn / Medium / Quora background reads (scan + metrics) also drive the
// user's PERSONAL session, but they are NOT build-time gated: the backend scan
// allowlist (`settings.operation_plan.allowed_platforms || ENGAGE_SUPPORTED_
// PLATFORMS`) is the single switch. The server only leases scan tasks and only
// returns metrics-due posts for allowed platforms, so an operator toggles these
// platforms without rebuilding the extension. X keeps its build gate because the
// X read path is suspended outright (account risk), independent of the allowlist.
