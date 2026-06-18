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
      "priorityAccountsMax": 0,                 // number | null (0 = feature hidden)
      "subredditsMax": 1,
      "scanIntervalHours": 24,
      "replyMonthlyCap": 10,                    // number | null (null = unlimited)
      "metricsWindowDaysMax": 7,
      "metricsFetchIntervalHours": 24
    },
    "usage": {
      "keywords": 2,
      "trackedAccounts": 0,
      "subreddits": 1,
      "repliesThisPeriod": 4
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

### B2. `entitlement.limits` — plan limits (7 fields)

| Field | Type | Meaning | `null` means |
|-------|------|---------|--------------|
| `keywordsMax` | number \| null | Max simultaneously-enabled keywords | unlimited |
| `priorityAccountsMax` | number \| null | Max tracked priority accounts | unlimited (`0` = feature hidden) |
| `subredditsMax` | number \| null | Max monitored subreddits | unlimited |
| `scanIntervalHours` | number | Scan interval in hours (smaller = more real-time) | — |
| `replyMonthlyCap` | number \| null | Monthly reply-draft quota | unlimited |
| `metricsWindowDaysMax` | number | Metrics-monitoring window ceiling (days) | — |
| `metricsFetchIntervalHours` | number | Metrics refresh interval (hours) | — |

**Default per-plan values** (`engage-entitlement.service.ts`, overridable via the
`engage_entitlements` Settings key):

| Plan | keywordsMax | priorityAccountsMax | subredditsMax | scanIntervalHours | replyMonthlyCap | metricsWindowDaysMax | metricsFetchIntervalHours |
|------|---|---|---|---|---|---|---|
| starter | 3 | 0 (hidden) | 1 | 24 | 10 | 7 | 24 |
| developer | 10 | 10 | 5 | 24 | null (∞) | 14 | 12 |
| pro | 30 | null (∞) | 15 | 6 | null (∞) | 30 | 6 |

### B3. `entitlement.usage` — current usage

| Field | Type | Meaning | Compare against |
|-------|------|---------|-----------------|
| `keywords` | number | Enabled keywords now | `limits.keywordsMax` |
| `trackedAccounts` | number | Enabled priority accounts now | `limits.priorityAccountsMax` |
| `subreddits` | number | Enabled subreddits now | `limits.subredditsMax` |
| `repliesThisPeriod` | number | Replies used this billing period | `limits.replyMonthlyCap` |

### B4. `entitlement.replyCredits` — reply cost (already rounded)

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
| Disable "+ Add Keyword" | `usage.keywords >= limits.keywordsMax` (null = no limit) |
| Hide priority-accounts feature | `limits.priorityAccountsMax === 0` |
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
