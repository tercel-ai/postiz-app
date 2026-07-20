# Operation Plan API Reference

## Overview

Operation plans turn a completed Aisee analysis task into a project-scoped publishing and Engage execution plan. The plan is owned by the current Postiz organization and the route project (`aisee-core.products.id`).

Base paths are mounted on the existing authenticated backend API. All requests require the normal Postiz session cookie.

## Create Operation Plan

```http
POST /projects/{projectId}/operation-plans
Content-Type: application/json
```

Creates or returns the operation plan for one completed Aisee task. `taskId` is the idempotency key for the organization: a retry with the same `taskId`, `projectId`, date range, and platform set returns the same plan without regenerating content or charging again.

**Generation is asynchronous.** On the real (non-`dryRun`) path the endpoint persists a stub row and returns it **immediately** with `status: "GENERATING"` and empty content (`contentItems`, `engagePolicies`, `data` not yet filled). LLM generation and billing then run in a background job that advances the row `GENERATING → BILLING_PENDING → READY` (or a terminal failure). Clients take the returned `id` and **poll [`GET /operation-plans/{id}`](#get-operation-plan-overview)** until `status` reaches a terminal state — do not treat the POST response as the finished plan. (`dryRun` is the exception: it runs generation inline and returns the finished preview in one call.)

### Path Params

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectId` | string | Yes | Opaque Aisee product id. Must match the source task's `product_id`. |

### Query Params

| Parameter | Type | Default | Description |
|---|---|---|---|
| `dryRun` | `"true"` \| `"1"` | off | **Preview mode.** Runs input validation, task resolution, and LLM generation + plan validation, then returns the generated plan **without** billing, persistence, or Post materialization. Use it to eyeball generation quality (and estimated token usage) before committing credits + DB rows. The LLM call still runs (real token cost to the platform), but **no user credit is deducted and nothing is written**. Any other value = the real flow. |

> **Dry-run response.** Same shape as the normal response plus `"dryRun": true`, `"status": "PREVIEW"`, `"id": null` (not persisted), and `"estimatedUsage"` (the generation's token usage). If the task already has a persisted plan, dry-run returns that existing plan read-only (with `dryRun: true`) — it never regenerates, reconciles billing, or re-materializes.

### Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| `taskId` | string | Yes | Aisee analysis task id. The task must belong to the organization owner's mapped Aisee user and be completed with a usable result. |
| `startAt` | string | Yes | UTC ISO 8601 instant. Must be in the future. |
| `endAt` | string | Yes | UTC ISO 8601 instant. Must be after `startAt`. |
| `platforms` | string[] | Yes | Non-empty list of requested platforms. Each must pass the `operation_plan.allowed_platforms` admin allowlist (empty allowlist = no restriction). A connected OAuth integration is **not** required — publishing is by-platform via the plugin, so a platform without an integration still yields DRAFT posts with a null `integrationId`. |
| `keywords` | string[] | No | Curated Engage keyword set for the plan's reply policies. When non-empty, these are used verbatim as the candidate keywords. When omitted or empty, the generator falls back — in priority order — to the AI-analyzed `result.code_web_analyzer.keywords` (semantic, analysis-derived), then to `product_snapshot.keywords` (short SEO/brand tags). Each keyword the generator actually targets is created as an `EngageKeyword` on the persist path (see the `keywordTargets` note below). |

```json
{
  "taskId": "c3a923d7-fce1-4a02-bac2-98e25fb626b7",
  "startAt": "2026-07-20T00:00:00Z",
  "endAt": "2026-08-16T00:00:00Z",
  "platforms": ["x", "linkedin", "instagram"],
  "keywords": ["GEO", "AEO", "AI search visibility"]
}
```

### Response

`201 Created`

**Immediate response (new task).** The background job has not run yet, so content is empty and `status` is `GENERATING`:

```json
{
  "id": "operation-plan-uuid",
  "projectId": "aisee-product-id",
  "taskId": "c3a923d7-fce1-4a02-bac2-98e25fb626b7",
  "sourceTaskVersion": "v1",
  "campaignId": "campaign-uuid",
  "durationDays": 28,
  "platforms": ["x", "linkedin", "instagram"],
  "generatorVersion": "operation-plan-v1",
  "status": "GENERATING",
  "startsAt": "2026-07-20T00:00:00.000Z",
  "endsAt": "2026-08-16T00:00:00.000Z",
  "data": {},
  "contentItems": [],
  "engagePolicies": [],
  "warnings": []
}
```

**Completed shape.** Once the background job reaches `READY`, the same fields are populated. You get this exact (flat) shape by **re-POSTing the same `taskId`** — the request is idempotent and returns the existing plan in whatever status it currently holds, so a repeat POST of an already-finished task returns the full plan below directly. (To *poll* for readiness use `GET /operation-plans/{id}`, which returns a different `{ plan, posts, engageStats }` envelope — see [Get Operation Plan Overview](#get-operation-plan-overview) — not this flat record.)

```json
{
  "id": "operation-plan-uuid",
  "projectId": "aisee-product-id",
  "taskId": "c3a923d7-fce1-4a02-bac2-98e25fb626b7",
  "sourceTaskVersion": "v1",
  "campaignId": "campaign-uuid",
  "durationDays": 28,
  "platforms": ["x", "linkedin", "instagram"],
  "generatorVersion": "operation-plan-v1",
  "status": "READY",
  "startsAt": "2026-07-20T00:00:00.000Z",
  "endsAt": "2026-08-16T00:00:00.000Z",
  "data": {
    "title": "30-day GEO visibility push",
    "description": "Close the weakest AI-presence gaps (Claude, Perplexity) with owned corpus + third-party citations.",
    "baselineScore": 48.03,
    "targetScore": 72
  },
  "contentItems": [
    {
      "contentId": "D01",
      "utcDate": "2026-07-20T00:00:00.000Z",
      "themeKey": "positioning",
      "themeTitle": "AI search positioning",
      "platforms": [
        {
          "id": "11111111-1111-4111-8111-111111111111",
          "platform": "x",
          "content": "Publish-ready post text",
          "media": []
        }
      ]
    }
  ],
  "engagePolicies": [
    {
      "platform": "x",
      "themeTitle": "Helpful answers for GEO questions",
      "targetRepliesPerDay": 5,
      "dailyTargets": [
        { "date": "2026-07-25", "target": 3 },
        { "date": "2026-07-26", "target": 3 }
      ],
      "keywordTargets": {
        "kw_uuid_geo": 3,
        "kw_uuid_ai_search": 2
      },
      "enabled": true
    }
  ],
  "billingTransactionId": "aisee-transaction-id",
  "creditAmount": "0.250000",
  "warnings": []
}
```

> **`data` (plan goal).** A JSON summary stored on the plan (separate from `planPayload`): `title` and `description` (LLM-generated campaign framing) plus `baselineScore` and `targetScore` (0-100). `baselineScore` is the source analysis's aggregate `total_score` (from `result.result.total_score`); `targetScore` is the LLM's realistic post-campaign estimate, clamped to `[baselineScore, 100]`. Present in the `dryRun` preview too.

> **`targetRepliesPerDay` vs `dailyTargets`.** `targetRepliesPerDay` is the **default** daily reply target; `dailyTargets` overrides it for specific UTC dates (`YYYY-MM-DD`, inside the plan range, no repeats) — that is how a plan paces weekdays and weekends differently. A date not listed keeps the default; a `target` of `0` means "send nothing that day". The send-time pacing gate resolves the day's target this way, and `GET /operation-plans/:id` surfaces the resolved value per day as `engageStats[date][].targetRepliesPerDay`. `dailyTargets` may be an empty list when every day shares the default. Targets are **dated, never week-numbered** — the week is derivable from the date plus `startsAt`.

> **`keywordTargets` keys.** The generator produces `keywordTargets` keyed by **keyword TEXT**. On the real (persisting) path the backend maps each text to its `EngageKeyword.id` — creating the keyword under the project's Engage config if it doesn't exist yet — and stores the plan with **`EngageKeyword.id` keys** (as shown above), which is what pacing and the overview endpoint read. In a **`dryRun` preview the keys stay keyword text** and no `EngageKeyword` rows are created. Two keyword texts that normalize to the same keyword (e.g. `"AI"` / `"ai"`) collapse to one id, summing their targets.

`contentItems[].platforms[].id` is a required UUID reserved for the materialized `Post.id`. After the plan is marked `READY`, the server creates DRAFT `Post` rows with that id, `Post.title = contentItems[].themeTitle`, `Post.settings.themeKey = contentItems[].themeKey`, and `Post.operationPlanId = plan.id`. Repeating the same request reuses the existing plan and skips already-created posts by `Post.id`; it does not create duplicates.

### Status Values

The real (non-`dryRun`) path is a background state machine. The POST returns synchronously in `GENERATING`; every later transition happens off-request and is observed by polling `GET /operation-plans/{id}`.

```
GENERATING ──▶ BILLING_PENDING ──▶ READY        (happy path)
    │                  │
    │                  └──────────▶ BILLING_FAILED   (credit deduction rejected)
    └─────────────────────────────▶ FAILED           (generation failed)
```

| Status | Terminal? | Meaning | What to do |
|---|---|---|---|
| `GENERATING` | no | Stub persisted; LLM generation is running (or a crashed worker's row is awaiting the sweeper). Content fields are empty. This is what a fresh POST returns. | Keep polling. |
| `BILLING_PENDING` | no | Generation finished and the plan is persisted; credit confirmation is in flight (or awaiting reconciliation after a lost response). Content is populated; `billingTransactionId`/`creditAmount` are not yet set. | Keep polling. |
| `READY` | **yes** | Plan generated **and** billing confirmed (or skipped). `contentItems`/`engagePolicies`/`data` populated; DRAFT `Post` rows materialized. | Render the plan. |
| `BILLING_FAILED` | **yes** | Generation succeeded but credit deduction was rejected (e.g. insufficient credit at confirm time). `errorCode: CREDIT_DEDUCTION_FAILED`. | Stop polling; surface a billing error. |
| `FAILED` | **yes** | Generation itself failed (LLM/validation error). `errorCode: GENERATION_FAILED`. Aisee is notified directly so `product.result.operation_plan_status` is flipped to `failed`. | Stop polling; surface a generation error. |

> **Durability.** A `GENERATING` row whose worker crashed mid-run is re-driven by the generation sweeper (`resumeStuckGenerations`, every ~interval, rows untouched > `OPERATION_PLAN_GENERATION_STALE_MS`); a `BILLING_PENDING` row whose confirmation was lost is retried by `reconcileBillingPending`. Both are idempotent on the plan id, so a slow row is never double-billed. In practice a stuck row still converges to a terminal state without a new POST.

### Errors

These are **synchronous** rejections raised during request validation (task resolution, allowlist, duration, credit pre-check) — the request fails and **no plan row is created**. Once the endpoint has returned a `GENERATING` stub, later failures are **not** HTTP errors: they surface as a terminal `status` (`FAILED` / `BILLING_FAILED`) on the polled plan (see [Status Values](#status-values)).

| Status | Code | Meaning |
|---|---|---|
| `400` | `DURATION_EXCEEDS_MAX` | Requested range exceeds the configured maximum duration. |
| `400` | `PLATFORM_NOT_ALLOWED` | One or more requested platforms are excluded by the `operation_plan.allowed_platforms` admin allowlist. |
| `400` | n/a | `taskId`, `startAt`, `endAt`, or `platforms` failed validation. |
| `402` | `INSUFFICIENT_CREDIT` | The organization cannot be charged for generation. |
| `404` | `TASK_NOT_FOUND` | Task is missing, belongs to a different Aisee user, or belongs to a different project. |
| `409` | `TASK_NOT_READY` | Task is not completed or has no usable result. |
| `409` | `TASK_ALREADY_PLANNED` | The same task already has a plan with different project/range/platform inputs. |
| `503` | `AISEE_UNAVAILABLE` | Aisee task lookup is unavailable. |
| `503` | `OPERATION_PLAN_UNAVAILABLE` | Required generation or billing dependencies are not configured. |

## Get Operation Plan Overview

```http
GET /operation-plans/{id}
```

Returns the persisted plan summary, every `Post` generated under the plan, and the Engage reply pacing grid for the plan's date range. The lookup is organization-scoped.

### Path Params

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | Yes | `OperationPlan.id`. |

### Response

`200 OK`

```json
{
  "plan": {
    "id": "operation-plan-uuid",
    "projectId": "aisee-product-id",
    "taskId": "c3a923d7-fce1-4a02-bac2-98e25fb626b7",
    "campaignId": "campaign-uuid",
    "platforms": ["x", "linkedin"],
    "status": "READY",
    "startsAt": "2026-07-20T00:00:00.000Z",
    "endsAt": "2026-08-16T00:00:00.000Z",
    "data": {
      "title": "30-day GEO visibility push",
      "description": "Close the weakest AI-presence gaps (Claude, Perplexity) with owned corpus + third-party citations.",
      "baselineScore": 48.03,
      "targetScore": 72
    }
  },
  "posts": [],
  "engageStats": {
    "2026-07-20": [
      {
        "platform": "x",
        "themeTitle": "Helpful answers for GEO questions",
        "targetRepliesPerDay": 5,
        "keywords": [
          {
            "keywordId": "kw_uuid_geo",
            "keyword": "GEO",
            "actualReplies": 1,
            "targetReplies": 3
          },
          {
            "keywordId": "kw_uuid_ai_search",
            "keyword": "AI search",
            "actualReplies": 0,
            "targetReplies": 2
          }
        ]
      }
    ]
  }
}
```

`plan.data` is the plan-level goal summary (see the `data` note under Create). It is `null` for legacy plans created before this field existed.

> **While the plan is still generating.** This endpoint always returns `200` — it does not 404 or block on an in-flight plan. Until `plan.status` reaches `READY`, the plan is a stub: `data` is `{}`, `posts` is `[]`, and `engageStats` is `{}` (content, DRAFT posts, and pacing are only filled in once the plan is `READY`). **`plan.status === "READY"` is the only reliable readiness signal — never infer readiness from whether `posts`/`data` are empty**, or you will treat a `GENERATING` plan as an empty one.

`engageStats` is keyed by UTC date; **each day is an array with one entry per platform** (a plan can span x/linkedin/instagram, each with its own Engage policy). Each entry carries that platform's `themeTitle`, the **resolved** `targetRepliesPerDay` for that day (the policy's `dailyTargets` override when one exists, else the default), and a `keywords` array — every keyword item has the persisted `EngageKeyword.id`, display text, actual replies sent on that platform that UTC day, and the configured target. `actualReplies` counts replies whose linked `Post.publishDate` falls on that UTC date **and** whose opportunity is on that platform. A keyword configured under two platforms appears once per platform (not summed).

### Errors

| Status | Meaning |
|---|---|
| `404` | The plan does not exist for the current organization. |

## Admin Settings

Seeded on backend boot (`OperationPlanService.onApplicationBootstrap`, insert-if-absent — an operator's value is never clobbered), so they appear in the admin Settings UI with a description and default. Editable in **aisee-manage → 配置管理 → 运营计划** (`/post/operation-plan-config`).

| Key | Type | Default | Effect |
|---|---|---|---|
| `operation_plan.max_duration_days` | number | `30` | Max plan length in whole days; a longer range → `400 DURATION_EXCEEDS_MAX`. |
| `operation_plan.allowed_platforms` | json (string[]) | `[]` | Allowlist of platforms a plan may use. **Empty = no extra restriction.** Violations → `400 PLATFORM_NOT_ALLOWED`. |
| `operation_plan.platform_cadence` | json | per-platform defaults | Publishing rhythm fed to the generator as **input** (`platformPlaybook`), so content volume follows the team's playbook instead of the model's guess. |

> **Clients read these from `GET /engage/config`.** Its response carries an `operationPlan: { maxDurationDays, allowedPlatforms }` block so a plan-creation UI can bound its date range and platform picker without an extra request. There, `allowedPlatforms` is the **raw allowlist, returned verbatim** — it is **not** intersected with connected integrations, so an allowlisted-but-unconnected platform is still offered (it is still plannable; POST accepts it). This keeps the picker in lockstep with the create endpoint's single platform gate. `platform_cadence` is **not** exposed — it is generator-only steering.

> **Empty allowlist.** When `operation_plan.allowed_platforms` is unset/empty the create endpoint is **unrestricted** (any platform is accepted), but `GET /engage/config` returns `allowedPlatforms: []` — a picker cannot enumerate "anything". So an empty array there means "the admin hasn't scoped platforms; configure the allowlist to drive the picker", **not** "no platform available". A client that wants to plan a platform while the allowlist is empty can still POST it directly.

`platform_cadence` shape — all fields optional free-form prose (it is editorial guidance, not a machine rule); only the **requested** platforms are forwarded, and a platform with all fields empty is skipped:

```json
{
  "x": {
    "cadence": "1 post per weekday, lighter on weekends; 1-2 threads per week",
    "citationWeight": "medium — Grok reads X directly",
    "notes": "optional"
  }
}
```

## Integration-testing Quickstart

End-to-end recipe for exercising generation against a real Aisee task. The order matters: **preview first (free, no writes), then commit (bills credits, writes rows)**.

### 0. Prerequisites

| Requirement | Notes |
|---|---|
| Postgres | The app DB. **Do not run `prisma db push`** to add plan columns — it drops the hand-made `EngageOpportunity_postContent_trgm_idx` (not declarable in `schema.prisma`). Apply the SQL under `libraries/nestjs-libraries/src/database/prisma/migrations/` instead, then `prisma generate`. |
| **Temporal on `:7233`** | The backend **refuses to boot** without it: `TemporalRegister.onModuleInit` connects at startup, and the failure surfaces as `Backend failed to start on port 3000` with a raw `14 UNAVAILABLE ... ECONNREFUSED ::1:7233`. operation-plan itself never uses Temporal — it's just a boot dependency. |
| Elasticsearch | **Not required.** `docker-compose.dev.yaml` sets `ENABLE_ES=true`, but ES 7.17 **crashes on Apple Silicon** (`Exited 134`), leaving Temporal stuck on `Waiting for Elasticsearch`. Postgres visibility supports everything this app needs (custom search attributes + `workflow.list` queries). Start Temporal with `ENABLE_ES=false`. |
| LLM provider | Generation calls `OpenaiService.generateStructuredText`. With `IMAGE_PROVIDER=openrouter` (and no `OPENAI_API_KEY`) it routes to OpenRouter using `OPENROUTER_TEXT_MODEL`. |
| Aisee orchestrator | `AISEE_ORCHESTRATOR_URL` must be reachable — the task lookup (`GET /task/detail/{taskId}`) and credit deduction both go through it. |

> **Search attributes are per-namespace.** The app registers `organizationId`/`postId` on `TEMPORAL_NAMESPACE` (e.g. `dev`). Inspecting the wrong namespace makes them look unregistered:
> ```bash
> temporal operator search-attribute list --namespace "$TEMPORAL_NAMESPACE"   # not --namespace default
> ```

### 1. Preview the plan (`dryRun`) — free, zero writes

Confirm `projectId` is the task's **`product_id`** (not the user id), and that every requested platform passes the `operation_plan.allowed_platforms` allowlist (a connected integration is not required — see the `platforms` field note).

```bash
curl -sS -X POST \
  'http://localhost:3000/projects/{projectId}/operation-plans?dryRun=true' \
  -H "Cookie: auth=$JWT" \
  -H 'Content-Type: application/json' \
  -d '{
        "taskId": "{taskId}",
        "startAt": "2026-08-01T00:00:00Z",
        "endAt":   "2026-08-14T00:00:00Z",
        "platforms": ["x"]
      }' | jq .
```

Expect `201` with `"dryRun": true`, `"status": "PREVIEW"`, `"id": null`. The LLM call still runs (~40-60s, real token cost) but **no credit is deducted and nothing is written**.

**Review the preview before committing** — a `201` only means the plan is well-formed, not that it is any good. Check:

- `data` — is `targetScore` a realistic uplift from `baselineScore`?
- `contentItems[].platforms[].content` — the actual copy. Length is gate-checked server-side, but read a few for tone/accuracy.
- `engagePolicies[].keywordTargets` — **keyword TEXT keys** at this stage; verify they're keywords you actually want (they get **created** as `EngageKeyword` rows on commit).
- `warnings[]` — the generator flags infeasibility here.

Iterate freely: re-running a dry-run costs tokens but never credits or rows.

### 2. Commit the plan — **async: bills credits, writes rows**

Same request without `?dryRun=true`. The endpoint returns **immediately** with `201` and `"status": "GENERATING"` (empty content); generation + billing run in the background. Background side effects, in order:

1. `OperationPlan` stub written as `GENERATING` up front, so the id is returned immediately;
2. LLM generation runs; on success the row is filled in and advanced to `BILLING_PENDING` (**before** billing, so a lost confirmation is recoverable — see `reconcileBillingPending`);
3. credits deducted via Aisee `/credit/deduct` (+ confirm);
4. status → `READY`, `billingTransactionId` + `creditAmount` set;
5. every keyword in `keywordTargets` is **get-or-created** as an `EngageKeyword` (this also seeds its initial scan) and the keys are rewritten to `EngageKeyword.id`;
6. `contentItems` materialize into DRAFT `Post` rows.

Expect the initial `201` to carry `"status": "GENERATING"`. **Poll `GET /operation-plans/{planId}` (step 3)** until `plan.status` is `READY` (with a non-null `billingTransactionId`) or a terminal failure (`FAILED` / `BILLING_FAILED`).

### 3. Verify

```bash
curl -sS "http://localhost:3000/operation-plans/{planId}" -H "Cookie: auth=$JWT" | jq .
```

Check `plan.data` (goal), `posts` (DRAFT, each carrying `projectId` + `settings.{campaignId,contentId,themeKey}`), and `engageStats` (one **array per UTC day**, one entry per platform, `keywordId` resolved back to display text).

### 4. Idempotency

`taskId` is the idempotency key (`UNIQUE(organizationId, taskId)`):

- **Same** `taskId` + same params → returns the existing plan instantly (no LLM call, no second charge; same `id`/`billingTransactionId`/`creditAmount`).
- Same `taskId` + **different** range/platforms → `409 TASK_ALREADY_PLANNED`.

To generate a genuinely new plan, use a different source task — or delete the existing `OperationPlan` row in a test DB.

### Troubleshooting

| Symptom | Cause |
|---|---|
| `404 TASK_NOT_FOUND` | `projectId` isn't the task's `product_id`, or the task's `user_id` isn't the org owner's Aisee user. |
| `400 PLATFORM_NOT_ALLOWED` | A requested platform is excluded by the `operation_plan.allowed_platforms` allowlist. (A missing OAuth integration is no longer an error — the plan still generates and posts get a null `integrationId`.) |
| plan stuck in `GENERATING` / lands on `FAILED` | Generation failures are now **async**: the POST returns `GENERATING`, then the background job fails the row (`FAILED` + `errorCode: GENERATION_FAILED`). Check backend logs for the generation error; a crashed worker's row is re-driven by the generation sweeper. |
| `400 ... outside the requested range` / `... over the N limit` / `... not requested` | The generator broke a contract; the message names the offending item. Historically a synchronous `400`; now these validation failures fail the background row as `FAILED`. Re-run — or tighten the prompt if it repeats. |
| `500` + `Unterminated string in JSON` | The completion was truncated. `OPERATION_PLAN_MAX_TOKENS` is the budget; a very long range needs more. |
| `500` + `Provider returned error` / `invalid_json_schema` | The generation schema violated OpenAI Structured Outputs (every field must be required — use `.nullable()`, never bare `.optional()`; no dynamic-key `z.record()`; only date-time/time/date/duration/email/hostname/ipv4/ipv6/uuid string formats — `.url()` emits the rejected `uri`). The unit test *"generation schema is OpenAI structured-outputs compatible"* guards all three. |
