# Reddit public-API access: the `loid` cookie

## Problem

Engage's Reddit discovery (subreddit search, post search, comment/thread metrics)
falls back to Reddit's **public** `*.reddit.com/*.json` endpoints whenever no user
OAuth token is available. As of mid-2026 these endpoints are fronted by an
**Imperva anti-bot WAF** that returns a `403` "network security" block page to
any request lacking a valid `loid` cookie — **regardless of IP, User-Agent, or
TLS fingerprint**.

This surfaced as the channel search returning `[]`: the primary `subreddits/search.json`
request timed out / 403'd and the `about.json` fallback returned the 403 block page.

## Investigation (what we ruled out)

| Client / condition | Result |
|---|---|
| `undici` / `curl` (any User-Agent, any of 3 UAs) | **403** block page |
| Residential proxy IP (multiple exits) | **403** — homepage 200, but `.json` 403 |
| `curl_cffi` impersonating Chrome's JA3/TLS fingerprint | **403** |
| Real browser (paste URL) from a clean IP | **200** + JSON |
| Playwright headless, no stealth | **403** (`navigator.webdriver` detected) |
| Playwright headless **+ stealth** | **200** |
| **Any HTTP client + a valid `loid` cookie** | **200** |

Key finding: the **only** thing that matters is the `loid` cookie. With a valid
`loid`, plain `undici`/`curl`/`urllib` all return `200` — no browser, no TLS
impersonation, no proxy required. User-Agent and IP are not the gate.

## Solution — `reddit-loid.ts`

`loid` = Reddit's "logged-out id", a long-lived (~400-day) anonymous visitor
identifier. We mint one cheaply:

1. `POST https://www.reddit.com/api/v1/access_token` (any body). This is handled
   by Reddit's app server (`snooserv`) **behind** the WAF, so even though it
   answers `401/403` for our grant, it still sets a usable `loid` in the
   response `Set-Cookie`.
2. Cache that cookie process-wide (refresh every `REDDIT_LOID_TTL_MS`, default 6h).
3. Attach `Cookie: loid=<value>` to every public `.json` request via
   `redditPublicHeaders()`.
4. On a `403` despite the cookie, `clearRedditLoidCache()` and retry once
   (self-heal for a rotated/flagged id).

### Call sites wired up

- `engage.service.ts` — `_searchRedditSubreddits` (search + about), `_syncRedditMetrics` (info + thread)
- `apps/orchestrator/.../engage-scan.activity.ts` — global `search.json`, per-subreddit `search.rss`
- `apps/orchestrator/.../engage-data-ticks.activity.ts` — `info.json`, thread `.json`

OAuth (`oauth.reddit.com`) paths are unchanged — a real token bypasses the WAF
on its own; `loid` is only for the unauthenticated public fallback.

## Proxy

All outbound `*.reddit.com` traffic (including loid minting) automatically routes
through the proxy because `setup-dispatcher.ts` installs `HTTPS_PROXY` /
`REDDIT_PROXY` as undici's **global dispatcher**. Set `REDDIT_PROXY` to send only
Reddit traffic through a dedicated clean IP and keep the server's own IP off
Reddit's rate-limit radar. `loid` is not IP-bound, so a rotating residential
proxy is fine (and helps avoid per-IP throttling at volume).

## Fallback if the loid path ever closes

If Reddit stops issuing a usable `loid` via the token endpoint, the heavyweight
fallback is a real browser: `scripts/test-reddit-playwright.mjs` demonstrates a
headless Chromium + stealth + homepage warm-up that obtains the cookie jar. Run
the browser only as an occasional cookie-minter, then reuse the cookie with plain
`undici` (the steady-state path stays lightweight).

## Diagnostics

- `scripts/diagnose-reddit-search.ts` — token-acquisition + search matrix (direct/proxy, grants, UAs).
- `scripts/test-reddit-playwright.mjs` — proves the browser path; `HEADFUL=1` to watch.
- `scripts/test-proxy.ts` — verifies a proxy URL is reachable and prints the exit IP.
