# Engage Module — `GET /engage/config` Response Reference

**Version**: 1.0
**Date**: 2026-06-18
**Endpoint**: `GET /api/engage/config`
**Auth**: Valid session cookie; the org is resolved from the request — no parameters required.

This is the single endpoint the frontend reads to render plan limits, current usage,
reply pricing, and scan timing. The backend remains the source of truth — these values
are for UX only (disabling entrypoints, showing `N/cap`, labelling costs). Server-side
checks (`assertCanActivate`, balance + monthly-cap gates) still run on every mutating call.

Source: `EngageService.getConfig` (`libraries/nestjs-libraries/src/engage/engage.service.ts:106`),
which composes `EngageEntitlementService.getEntitlementSummary`
(`libraries/nestjs-libraries/src/engage/engage-entitlement.service.ts:318`)
and `EngageRepository.getOrgScanStatus` (`libraries/nestjs-libraries/src/engage/engage.repository.ts:448`).

---

## Response Shape

```jsonc
{
  // ── A. EngageConfig base fields ──
  "id": "uuid",
  "organizationId": "uuid",
  "enabled": false,
  "lastScanAt": "2026-06-18T10:00:00.000Z",   // or null
  "createdAt": "2026-05-01T00:00:00.000Z",
  "updatedAt": "2026-06-18T10:00:00.000Z",

  // ── B. entitlement: plan limits + usage + reply pricing ──
  "entitlement": {
    "plan": "starter",                          // "starter" | "developer" | "pro" | null
    "limits": {
      "keywordsMax": 3,                         // number | null (null = unlimited)
      "priorityAccountsMax": 10,                // shared pool: tracked accounts + monitored channels
      "keywordsPerProjectMax": 5,               // per-project counterparts
      "priorityAccountsPerProjectMax": 4,
      "scanIntervalHours": 24,
      "replyMonthlyCap": 10,                    // number | null (null = unlimited)
      "metricsWindowDaysMax": 7,
      "metricsFetchIntervalHours": 24
    },
    "usage": {                                  // ORG-WIDE enabled counts
      "keywords": 2,
      "trackedAccounts": 0,
      "subreddits": 1,
      "repliesThisPeriod": 4
    },
    "counts": {                                 // per-type org cap + project cap
      "keywords": {
        "added": 2, "active": 2, "max": 3,      // org scope
        "project": { "added": 2, "active": 2, "max": 5 }   // null without projectId
      },
      // trackedAccounts + subreddits share ONE cap pair (priorityAccounts*),
      // scoped PER PLATFORM: both report the same max (a per-platform bound),
      // while added/active are totals across platforms.
      "trackedAccounts": {
        "added": 0, "active": 0, "max": 10,
        "project": { "added": 0, "active": 0, "max": 4 }
      },
      "subreddits": {
        "added": 1, "active": 1, "max": 10,
        "project": { "added": 1, "active": 1, "max": 4 }
      },
      // The authoritative per-platform rollup for the shared pool: a platform
      // is addable when active < max AND project.active < projectMax (null =
      // unlimited) — the same rule the server-side assert enforces.
      "priorityAccounts": {
        "max": 10,                                // per-platform org cap
        "projectMax": 4,                          // per-platform project cap
        "byPlatform": {
          "x":      { "active": 3, "project": { "added": 2, "active": 2 } },
          "reddit": { "active": 1, "project": { "added": 1, "active": 1 } }
          // project is null when the request carried no projectId
        }
      }
    },
    "replyCredits": {                           // already rounded final cost
      "short": 2,
      "medium": 3,
      "long": 5
    }
  },

  // ── C. scanIntervals (legacy-compatible) ──
  "scanIntervals": {
    "scanIntervalHours": 24,
    "keywordHours": 24,
    "channelHours": 24,
    "trackedHours": 24
  },

  // ── D. scanStatus: per-org scan timing ──
  "scanStatus": {
    "lastScanAt": "2026-06-18T09:55:00.000Z",   // or null
    "nextScanAt": "2026-06-19T09:55:00.000Z",   // or null (derived, not stored)
    "keyword": { "lastScanAt": "...", "nextScanAt": "..." },
    "channel": { "lastScanAt": "...", "nextScanAt": "..." },
    "tracked": { "lastScanAt": "...", "nextScanAt": "..." }
  }
}
```

---

## A. EngageConfig base fields

Source: `model EngageConfig` (`libraries/nestjs-libraries/src/database/prisma/schema.prisma:1030`)

| Field | Type | Meaning |
|-------|------|---------|
| `id` | string | The org's engage config record ID |
| `organizationId` | string | Owning organization ID |
| `enabled` | boolean | **Master switch** for the engage module (false = module disabled) |
| `lastScanAt` | DateTime \| null | Coarse last-scan timestamp on the config row (per-type timing lives in `scanStatus`) |
| `createdAt` / `updatedAt` | DateTime | Record create / update timestamps |

---

## B. `entitlement`

### B1. `entitlement.plan`

| Field | Type | Meaning |
|-------|------|---------|
| `plan` | `"starter" \| "developer" \| "pro" \| null` | Current plan code; `null` = self-hosted / unlimited mode |

### B2. `entitlement.limits` — plan limits (8 fields)

Keywords / priority accounts are capped **twice**: an org-wide budget
(`*Max`) and a per-project one (`*PerProjectMax`). Both are enforced on every
activation, so a project's real headroom is `min(org remaining, project remaining)`.
The org cap bounds the account as a whole; the project cap stops one project from
eating the entire account budget. A per-project value larger than its org
counterpart is legal — the org cap simply wins.

`priorityAccountsMax` / `priorityAccountsPerProjectMax` are **one shared pool
per platform**: on each platform, tracked accounts AND monitored channels
(subreddits etc.) count against the cap together — a cap of 10 allows up to 10
follows on X *plus* 10 on Reddit, and so on. The former `subredditsMax` /
`subredditsPerProjectMax` fields were folded into it (legacy Settings overrides
still carrying them are summed in at read time).

| Field | Type | Meaning | `null` means |
|-------|------|---------|--------------|
| `keywordsMax` | number \| null | Max simultaneously-enabled keywords, org-wide | unlimited |
| `priorityAccountsMax` | number \| null | Max priority accounts (tracked accounts + monitored channels) PER PLATFORM, org-wide | unlimited (`0` = feature hidden) |
| `keywordsPerProjectMax` | number \| null | Max enabled keywords within ONE project | unlimited |
| `priorityAccountsPerProjectMax` | number \| null | Max priority accounts (per-platform pool) within ONE project | unlimited |
| `scanIntervalHours` | number | Scan interval in hours (smaller = more real-time) | — |
| `replyMonthlyCap` | number \| null | Monthly reply-draft quota | unlimited |
| `metricsWindowDaysMax` | number | Metrics-monitoring window ceiling (days) | — |
| `metricsFetchIntervalHours` | number | Metrics refresh interval (hours) | — |

**Default per-plan values** (`engage-entitlement.service.ts`, overridable via the
`engage_entitlements` Settings key — a partial override merges over these defaults
per plan, so an existing stored value that predates the per-project fields still
picks them up):

| Plan | keywordsMax | priorityAccountsMax | scanIntervalHours | replyMonthlyCap | metricsWindowDaysMax | metricsFetchIntervalHours |
|------|---|---|---|---|---|---|
| starter | 30 | 10 | 24 | 10 | 7 | 24 |
| developer | 100 | 60 | 24 | null (∞) | 14 | 12 |
| pro | 300 | null (∞) | 6 | null (∞) | 30 | 6 |

| Plan | keywordsPerProjectMax | priorityAccountsPerProjectMax |
|------|---|---|
| starter | 5 | 4 |
| developer | 15 | 18 |
| pro | 30 | 35 |

### B3. `entitlement.usage` — current usage (org-wide)

| Field | Type | Meaning | Compare against |
|-------|------|---------|-----------------|
| `keywords` | number | Enabled keywords now | `limits.keywordsMax` |
| `trackedAccounts` | number | Enabled tracked accounts now (all platforms) | per-platform: `trackedAccounts + subreddits` on ONE platform vs `limits.priorityAccountsMax` |
| `subreddits` | number | Enabled monitored channels now (all platforms) | same per-platform pool as above |
| `repliesThisPeriod` | number | Replies used this billing period | `limits.replyMonthlyCap` |

### B4. `entitlement.counts` — per-type org + project rollup

One entry per unit type (`keywords` / `trackedAccounts` / `subreddits`), each
`{ added, active, max, project }`. The top level is **org scope** (`active`/`max`
mirror `usage`/`limits`); `project` repeats the same shape scoped to the
`projectId` in the query.

| Field | Type | Meaning |
|-------|------|---------|
| `added` | number | Total rows including disabled ones |
| `active` | number | Enabled rows — the number the cap is checked against |
| `max` | number \| null | The applicable cap (`null` = unlimited, `0` = feature hidden) |
| `project` | object \| null | Same shape, project-scoped. **`null` when the request carried no `projectId`** (the extension's org-wide aggregate view has no single project to report) |

An "+ Add" entrypoint should be disabled when **either** scope is full:
`active >= max` at the org level, or `project.active >= project.max`.

For tracked accounts / monitored channels, the per-type blocks above report
cross-platform totals against a per-platform cap — precise gating uses the
extra **`counts.priorityAccounts`** block instead:

| Field | Type | Meaning |
|-------|------|---------|
| `max` | number \| null | Per-platform org cap for the shared pool (`null` = unlimited, `0` = feature hidden) |
| `projectMax` | number \| null | Per-platform cap within this project |
| `byPlatform.<p>.active` | number | Org-wide enabled tracked+channels on platform `<p>` |
| `byPlatform.<p>.project` | object \| null | `{ added, active }` for this project's rows on `<p>`; **`null` when the request carried no `projectId`** |

Platform `<p>` is addable when `byPlatform[p].active < max` AND
`byPlatform[p].project.active < projectMax` (each check skipped when its cap is
`null`) — the same rule the server-side assert enforces.

### B5. `entitlement.replyCredits` — reply cost (already rounded)

Final credit cost = `round(base × multiplier)` per length tier. Defaults: `base=2`,
multipliers `short=1.0 / medium=1.5 / long=2.5`, overridable via the
`engage_reply_credits` Settings key. The frontend can display these numbers directly.

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `short` | number | 2 | Credits charged for a short reply |
| `medium` | number | 3 | Credits charged for a medium reply |
| `long` | number | 5 | Credits charged for a long reply |

---

## C. `scanIntervals` (legacy-compatible)

A single per-plan cadence now applies to all unit types; the three per-type keys are
kept equal to `scanIntervalHours` for older frontend compatibility.

| Field | Type | Meaning |
|-------|------|---------|
| `scanIntervalHours` | number | Authoritative per-plan scan cadence |
| `keywordHours` | number | Keyword scan interval (= `scanIntervalHours`) |
| `channelHours` | number | Channel/subreddit scan interval (= `scanIntervalHours`) |
| `trackedHours` | number | Tracked-account scan interval (= `scanIntervalHours`) |

---

## D. `scanStatus` — per-org scan timing

Top-level rollup plus three categories (`keyword` / `channel` / `tracked`); each
category is a `ScanTiming` object. Source types `OrgScanStatus` / `ScanTiming` in
`engage.repository.ts:116` / `:75`.

| Field | Type | Meaning |
|-------|------|---------|
| `lastScanAt` | DateTime \| null | Most recent successful scan completion across all categories |
| `nextScanAt` | DateTime \| null | Earliest upcoming scan = `lastScanStartedAt + cadence` (derived, not stored) |
| `keyword` | ScanTiming | `{ lastScanAt, nextScanAt }` for keyword scans |
| `channel` | ScanTiming | `{ lastScanAt, nextScanAt }` for Reddit subreddit scans |
| `tracked` | ScanTiming | `{ lastScanAt, nextScanAt }` for X priority-account scans |

---

## Frontend usage cheat sheet

| UI scenario | Read |
|-------------|------|
| Module on/off state | `enabled` |
| Disable "+ Add Keyword" | `counts.keywords.active >= counts.keywords.max` **OR** `counts.keywords.project.active >= counts.keywords.project.max` (null max = no limit; null `project` = no project context) |
| "2/3 org · 2/5 in this project" | `counts.<type>.{active,max}` and `counts.<type>.project.{active,max}` |
| Hide priority-accounts feature | `limits.priorityAccountsMax === 0` |
| Which cap blocked an add | 403 body `{ code: "engage_limit_reached", limit, scope: "organization" \| "project", max, current }` |
| "Replies this month 4/10" | `usage.repliesThisPeriod` / `limits.replyMonthlyCap` |
| Reply price labels | `replyCredits.{short,medium,long}` |
| "Last / next scan" hint | `scanStatus.lastScanAt` / `scanStatus.nextScanAt` |
| Scan frequency copy | `scanIntervals.scanIntervalHours` |
| Show "∞ / Unlimited" | any `*Max` or `cap` equal to `null` |

---

## Not included here

The metrics-window **user override / effective value** (`{ effective, max, override }`)
is **not** exposed by `/engage/config` — only the plan ceiling `limits.metricsWindowDaysMax`.
`EngageEntitlementService.getMetricsWindowSetting`
(`engage-entitlement.service.ts:376`) returns the full read model, but it has **no HTTP
route yet**. Add a dedicated endpoint if the UI needs an editable metrics-window setting.
