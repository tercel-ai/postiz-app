# Engage Module — Documentation Index

The Engage module is the social engagement system (discover → reply → track) for
X and Reddit. This is the entry point to all Engage docs.

## Documents

| Doc | Audience | What's in it |
|-----|----------|--------------|
| [`prd.md`](./prd.md) | Product | Requirements, goals, scope of the Engage module. |
| [`tech-design.md`](./tech-design.md) | **Dev** | Architecture, the 5 Prisma models, Temporal workflows, scan/reply/metrics design. The authoritative engineering reference. |
| [`api.md`](./api.md) | Dev / Integrators | All `/engage/*` REST endpoints with request/response shapes. |
| [`config-response-reference.md`](./config-response-reference.md) | Dev / Frontend | Field-by-field reference for `GET /engage/config` — plan limits, usage, reply credits, scan timing. |
| [`startup-checklist.md`](./startup-checklist.md) | **Ops** | Cold-start & upgrade deployment, env vars, Prisma schema push, Temporal workflow registration, smoke test. |
| [`scripts.md`](./scripts.md) | **Ops / Dev** | Runbook for the 10 maintenance scripts, grouped by scenario (scanning, metrics repair, data-ticks). |
| [`sync-metrics-script.md`](./sync-metrics-script.md) | Ops | Detailed output walkthrough for `engage-sync-metrics.ts`. |
| [`reddit-loid-waf-bypass.md`](./reddit-loid-waf-bypass.md) | Dev | How Reddit public-JSON reads clear the anti-bot WAF (the `loid` cookie). |
| [`reddit-metrics-sync-todo.md`](./reddit-metrics-sync-todo.md) | Dev | Open TODOs on Reddit metrics syncing. |

## Where do I start?

- **Deploying / launching Engage** → [`startup-checklist.md`](./startup-checklist.md)
- **Understanding the design** → [`tech-design.md`](./tech-design.md)
- **Calling the API** → [`api.md`](./api.md)
- **Operating it day-to-day** (sync metrics, trigger scans, repair data) → [`scripts.md`](./scripts.md)

## Common operational tasks (→ [`scripts.md`](./scripts.md))

| I need to… | Script |
|------------|--------|
| Force a scan / check ticker state | `engage-scan.ts` |
| Fix an empty "sent" list (metrics + integration) | `engage-sync-metrics.ts` ⭐ |
| Figure out why one X reply has no metrics | `engage-diagnose-x-reply.ts` (read-only) |
| Probe metrics for one specific reply (X or Reddit) | `engage-fetch-raw.ts` |
| Backfill `Post.integrationId` on X replies | `backfill-engage-x-integration.ts` |
| Drop un-repliable opportunities | `cleanup-engage-opportunities.ts` |
| Manually seed one tweet into the pool | `ingest-engage-post.ts` |
| Rebuild `EngageDataTicks` from `Post` | `backfill-engage-data-ticks.ts` |

## Key architectural facts to know before operating

- The engage dashboard reads the **`Post`** table directly; `EngageDataTicks` is
  **write-only** and fully reconstructable from `Post`.
- X impressions/bookmarks are **owner-only** — a reply's metrics need an X integration
  whose handle matches the reply author; otherwise only public metrics are visible.
- The per-type scan workflows were consolidated into **one** cursor-driven ticker
  (`engage-scan-ticker`, signal `triggerScanNow`).
- Newly added or re-enabled keywords use **`EngageKeywordInitialScan`** catch-up
  rows before joining the shared global cursor, so users do not wait for the 24h
  keyword cadence or miss recent posts already behind `reddit/keyword/__global__`.
- Reddit public-JSON metric reads require a `loid` cookie to clear the WAF.
