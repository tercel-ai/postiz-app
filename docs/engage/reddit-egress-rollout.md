# Reddit egress hardening — cross-repo rollout

## Running without server Reddit access

Set `REDDIT_EGRESS_MODE=extension` in the deployment environment and restart the
backend and orchestrator so both processes read the new setting. This skips the
server Reddit reads used by the two flows below. Keep this setting while the
server has no working Reddit route. The diagnostics later in this document test
server egress and may still return 403 in this mode.

| Flow | Browser extension handoff | Verification |
|---|---|---|
| Operation plan | The server can reuse a monitored subreddit. When a target still needs lookup, it saves the draft with a pending target. The extension's background runner reads `/engage/reddit-targets/pending`, resolves the target with the user's Reddit session, and submits it to `/engage/reddit-targets/resolve`. | Generate a plan that needs a new Reddit target. Verify the pending item becomes a post with a subreddit after the extension runs. |
| Add a subreddit | The web app sends `version: "v2"` to `/engage/monitored-channels/search`. With `needsExtension: true`, the page asks the extension for results through `aisee:reddit-channel-search`. Selecting a result uses the existing add endpoint. | Search from `/engage/keywords-accounts` with the updated extension installed and a Reddit session available. Verify that the picker shows results and that extension failures appear separately from an empty search. |

Deploy a backend with both endpoint contracts before relying on the extension.
The browser must have a build that includes the Reddit bridge and target runner.

The sections below retain the original rollout context and record the frontend
handoff needed for an outage. Verify which build is installed in each environment
before switching the server to extension mode.

---

## What this was

Channel search returned `[]` and operation-plan Reddit posts silently vanished.
The diagnosis that got reported ("Reddit now requires login") was wrong; so were
two of the intermediate ones. The measured cause:

| Claim | Verdict |
|---|---|
| Reddit's `.json` API now requires an account | **No.** It requires the `loid` cookie that clears its Imperva WAF. |
| `oauth.reddit.com` is IP-blocked from our exit | **No.** That was an artefact of probing without a loid. |
| `globalThis.fetch` bypasses the proxy | **No.** The global dispatcher does route it. |
| `REDDIT_PROXY`'s exit IP was dead | **Yes.** Swapping the proxy restored everything with no code change. |

Two facts worth keeping:

- **AWS datacenter IPs are WAF-blocked even WITH a valid loid.** Verified on the
  prod host: direct route 403, residential proxy 200. So `REDDIT_DIRECT_READ`
  must **not** be set there — the proxy is mandatory, not an optimisation.
- **`REDDIT_CLIENT_ID`/`SECRET` are unset in prod**, so every Reddit read goes
  down the public + loid path. Reddit's user-authorized API is unusable.

The code changes exist so the NEXT time a proxy exit dies, the system degrades
visibly instead of silently.

---

## 1. postiz-app — DONE (committed)

Commits `ee50efa8` … `9afd52bb` (6). 30 files.

| Area | Change |
|---|---|
| `engage/reddit-egress.ts` (new) | Circuit breaker + `REDDIT_EGRESS_MODE` gate. Opens after 3 consecutive failures for 10 min, half-opens for exactly one probe. |
| `engage/reddit-pending-target.ts` (new) | The parked-post marker `settings.redditTargetPending`. |
| `engage/reddit-target-resolution.service.ts` (new) | `GET|POST /engage/reddit-targets/pending|resolve` — the extension's handshake. |
| `engage/reddit-loid.ts` | Breaker wired in; **IP-rotation bug fixed** (a fresh `ProxyAgent` per retry — undici pools per-dispatcher, so the old retry ladder reused one exit IP); `REDDIT_BROWSER_UA` exported; `warmRedditLoidCache()` added. |
| `integrations/social/reddit.provider.ts` | Sends the **loid** on every Reddit call (it never did — that alone was a guaranteed 403); UA switched to the browser string; refuses `generateAuthUrl`/`authenticate`/`refreshToken` when app credentials are unset. |
| `engage/engage.service.ts` | Reddit search no longer takes the OAuth branch — one route, public + loid. |
| `operation-plan/*` | A Reddit post with no resolvable community is **parked**, not dropped. |
| `posts/posts.repository.ts` | Parked posts excluded from the extension publish queue. |
| `scripts/diagnose-reddit-*.ts` (3 new) | See **Diagnostics** below. |

**No schema change.** The parked marker lives in `Post.settings`, an existing
`String?` column — verified: no `schema.prisma` in the diff. **No `prisma db
push` required.**

### Deploy

Nothing special. Build, restart.

```bash
pnpm run build:backend && pnpm run build:orchestrator
```

### Verify after restart

1. Logs show `[reddit] loid cache warm`.
2. Channel search in the UI returns results.
3. `npx tsx scripts/diagnose-reddit-egress.ts` → verdict ✅.

### Config

| Var | Prod value | Why |
|---|---|---|
| `REDDIT_PROXY` | Residential exit when using server reads | The server needs a working exit in `auto` mode. |
| `REDDIT_DIRECT_READ` | leave unset | Setting it on this host enables a route that cannot work. |
| `REDDIT_EGRESS_MODE` | `auto` with working server egress, `extension` during an outage | `extension` hands these Reddit reads to the browser. |
| `REDDIT_USER_AGENT` | unset | Defaults to the browser UA. The Reddit-documented format self-identifies as a script and names an account. |

---

## 2. aisee-browser-extension — Reddit bridge and target runner

Commit `b75ee68`. 11 files.

- `utils/executor/reddit-search.ts` — subreddit search + community probe on the
  user's own Reddit session.
- `utils/executor/reddit-target.runner.ts` — resolves parked plan posts. Rides
  the existing 15-min scan alarm (not a new one: a second uncoordinated source
  of Reddit reads is what the scan cadence exists to prevent), gated on a cheap
  count so an idle tick costs one empty query.
- `pages/content/reddit-bridge.ts` — `aisee:reddit-channel-search` and
  `aisee:reddit-target-resolve`.

The bridge is already injected into aisee-app's origins (`app.aisee.live`,
`app-dev.aisee.live`, `localhost:3000`) — no manifest change needed.

Install a build containing the bridge and target runner before using extension
mode. A browser with an older build will not answer a channel-search request.

---

## 3. aisee-app — Add a subreddit

The search endpoint returns a bare array by default. The dialog opts in to
`version: "v2"` through `searchChannelsV2` and accepts the legacy array when
connected to an older backend. `lib/extension/reddit-channel-search.ts` handles
the same-origin round trip when `needsExtension` is true. An extension error or
timeout appears as a search failure. A successful empty result uses the existing
empty state.

---

## Ordering

```
postiz-app  ──────────────►  (independent, ships first, restores search)
extension   ──────────────►  (independent; enables the fallback to succeed)
aisee-app   ──────────────►  (ONLY after the extension release)
```

- postiz-app before extension: the extension's runner calls
  `/engage/reddit-targets/*`, which only exists after the backend ships.
- aisee-app last: its `needsExtension` branch can only succeed once the
  extension is released.
- Nothing needs to ship **simultaneously**.

---

## Testing the fallback path

While `REDDIT_PROXY` is healthy, `needsExtension` is permanently `false` and the
whole extension path is dead code in practice. To exercise it, force the backend
to hand off:

```bash
REDDIT_EGRESS_MODE=extension   # restart backend
```

Then channel search returns `{ results: [], needsExtension: true }` for a `v2`
caller, and parked plan posts appear on `GET /engage/reddit-targets/pending`.
Restore `auto` after the test if server egress is healthy.

---

## Diagnostics

Three scripts, and knowing which answers what saves the detour this incident
took.

| Script | Question |
|---|---|
| `diagnose-reddit-egress.ts` | Does this host have a ROUTE at all? Direct vs proxy, exit IP, can a loid be minted. |
| `diagnose-reddit-provider.ts` | Which ENDPOINTS answer, under what conditions? Read + write paths × loid × UA × transport. |
| `diagnose-reddit-search.ts` (pre-existing) | OAuth route only. **Blind spot: it never sends a loid**, so it reports 403 for everything and proves nothing about the public path. |

Run the first two. A 403 with a ~190KB Imperva body means "no loid", not "IP
banned" — that single confusion produced three wrong diagnoses in a row.

---

## Known gaps

- **No real Reddit post has been published** through the changed provider. The
  loid and UA changes are covered by unit tests and a build only. Send one test
  post before trusting API publishing.
- **A 200 carrying a WAF interstitial does not trip the breaker.**
  `redditPublicGet` only inspects the status; callers parse the body. Reachable
  in principle, not observed.
- **`ProxyFallbackDispatcher` (`helpers/proxy/setup-dispatcher.ts`) is
  untouched.** Its comment claims "the loid cookie keeps direct working", which
  the prod measurement disproves on this host — direct is 403 even with a loid.
  It was left alone because it was measured NOT to be firing. Revisit if a
  `[dispatcher] … falling back to direct connection` line ever shows up
  alongside Reddit failures.
- **9 pre-existing test failures** in
  `users.service.getUserLimits.spec.ts` — present before this work (verified by
  stashing), unrelated.
