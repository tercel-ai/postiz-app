# Operation-Plan Generation — Gap Analysis & Completion Checklist

**Status:** Living document
**Owner:** Postiz
**Scope:** `POST /projects/{projectId}/operation-plans` — how `contentItems` and `engagePolicies` are generated.
**Reference plan:** `AISEE_30天GEO运营计划.xlsx` (a hand-crafted 30-day GEO/AEO operating calendar) — used here as the "gold standard" of what a rich plan looks like.

---

## 1. How generation works today

Generation is delegated **entirely to an LLM**. There are no deterministic content rules; the code provides only:

1. **A short system prompt** — `libraries/nestjs-libraries/src/database/prisma/operation-plan/operation-plan.service.ts` (the `generateStructuredText(...)` call in `create()`).
2. **A structural Zod schema** (`GeneratedPlanSchema`) passed as `response_format` (OpenAI Structured Outputs) — constrains the *shape*, not the *content*.
3. **Post-generation validation** (`_validateGeneratedPlan`) — 4 hard checks: dates in `[start,end]`, unique `Post.id`s, platform ∈ requested set, `Σ keywordTargets ≤ targetRepliesPerDay`.

Inputs fed to the model (user prompt) are: `projectId`, `range {startAt,endAt,durationDays}`, `platforms`, `analysisResult` (`task.result`, raw), `productSnapshot`, `sourceUrl`.

Output schema:

- `contentItems[]`: `{ contentId, utcDate, themeKey, themeTitle, platforms[]{ id(uuid), platform, content, media? } }`
- `engagePolicies[]`: `{ platform, themeTitle, targetRepliesPerDay(int≥0), keywordTargets: Record<keywordId,int≥0>, enabled }`
- `warnings[]`

**Bottom line:** plan quality currently depends almost entirely on that short prompt + the quality of the upstream `task.result`. The business rules layer is very thin.

---

## 2. Gap analysis — reference plan vs generator

The reference spreadsheet embodies rules the generator neither encodes nor can reliably produce.

| # | Rule embodied in the reference plan | Generator today | Gap layer |
|---|---|---|---|
| A | **Week structure + weekly themes** — WK1 foundations → WK2 third-party listings → WK3 co-mention density → WK4 consolidation, plus a buffer period at the end | schema has no `week`/`phase` field; prompt never mentions week structure; `contentItems` is a flat dated list | schema + prompt |
| B | **6 task types** — post / engage / corpus (语料) / technical (技术) / score-test (分数测试) / review (复盘) | only "post" (`contentItems`) and "engage" (`engagePolicies`) exist; corpus/technical/score-test/review have **no carrier at all** | **data model** (largest gap) |
| C | **Workday/weekend weighting** — 5 engage replies on weekdays, 3 on weekends (day-varying) | `engagePolicies[].targetRepliesPerDay` is a **single scalar per platform**, not day-varying; prompt has no workday rule | schema + prompt |
| D | **Per-platform cadence & AI-citation weight** (Playbook sheet) — X daily, LinkedIn 3–4/wk, Medium 1/wk, HN 1–2/mo, Quora 2–3/wk, Dev.to 1/wk, weight per platform | prompt gives no frequency/weight guidance; platform occurrence counts unguided | prompt (optional constraint) |
| E | **13+ channels** — owned blog / Medium / HN / Quora / Dev.to / Product Hunt / G2 / YouTube / Wikidata / Reddit / X / LinkedIn / Analysis | validation only allows **connected, non-disabled integrations** (x/linkedin/instagram/reddit); blog/Medium/HN/Quora/Wikidata/G2/YouTube **cannot be emitted** | **scope** (fundamental) |
| F | **Score-driven topic selection** — the whole plan is derived from the Scores sheet (attack claude 10, perplexity 0, grok 0, Web Presence 65.5, hreflang gap…), with task refs (#sr01…#sr09, #ac01/#ac03) | `task.result` is passed raw; prompt never instructs the model to parse module scores, prioritize lowest-slope platforms, or map gaps→tasks | prompt (+ optional pre-compute) |
| G | **Score-test / review cadence** — Day-1 baseline + weekly full re-scan (Tuesdays) + midweek Perplexity/Grok spot-checks (Sundays) + weekly review + end buffer | no task type, no cadence rule | data model + prompt |
| H | **Content norms** — every external link canonical back to the owned site; build-in-public (publish the real score); bilingual titles; AI-citable angle | prompt has none of this | prompt |
| I | **Quotas are computed** — reply targets tied to platform/day; design §6 `plannedTarget = min(configuredTarget, eligibleCount)` | `targetRepliesPerDay`/`keywordTargets` are entirely LLM-chosen; no supply-based computation | prompt or pre-compute |

**Key judgement:** roughly **60% of the reference calendar (corpus / technical / score-test / review rows) are not publishable Posts and not Engage replies at all** — they are operational to-dos (build a comparison page, add hreflang, submit a G2 listing, run a re-scan, write an SOP). The current data model (`contentItems` → DRAFT `Post`, `engagePolicies` → send-time pacing) has **no home** for them. The biggest gap is therefore a **data-model gap**, not a prompt gap.

---

## 3. Completion checklist (by layer & priority)

### 🔴 P0 — Decisions — **RESOLVED (2026-07-17)**
1. **Plan boundary — DECIDED: this version generates ONLY "publishable content + Engage quota"** (`contentItems` → DRAFT Posts, `engagePolicies` → reply pacing). The reference plan's other four task types (corpus / technical / score-test / review) are explicitly OUT of scope for this version — see P3. This resolves the tension with the contract doc's "editorial copy belongs to aisee-core": Postiz owns post copy + engage targets, nothing else.
2. **Platform-set boundary — DECIDED: a Settings-configured allowlist, INTERSECTED with connected integrations (option A).**
   - Rationale: a plan platform must resolve to a real `Integration.providerIdentifier` twice — at input validation (`getConnectedPlatforms`) and again at materialization (`OPERATION_PLAN_PLATFORM_NOT_CONNECTED`). **Configuring `medium` in Settings would NOT make Medium publishable** — with no Medium integration, materialization fails. So Settings can only ever *narrow* the set, never widen it.
   - Effect: ops can restrict which connected platforms a plan may use (e.g. allow only `x`/`linkedin` even when `instagram` is connected) without a code change.
   - **IMPLEMENTED (2026-07-17)**: `operation_plan.allowed_platforms` Setting (json string[], `[]` = no restriction), enforced in `_validateInput` after the connected check → `400 PLATFORM_NOT_ALLOWED`. A malformed/empty value can't lock anyone out. Editable in aisee-manage → 配置管理 → 运营计划.
   - Rejected (option B): letting Settings admit non-integration channels (Medium/HN/Quora/Wikidata/G2/YouTube/owned blog). Those have no Post carrier and would need the operational-task carrier from P3 — out of scope for this version.

### 🟠 P1 — Prompt layer (no data-model/schema change; fastest ROI) — **DONE, see §4**
3. Inject a **week-structure rule**: partition `[start,end]` into w1..wN, give each week a phase, sequence foundation → distribution → density → consolidation. *(P1 constraint: reflected via `themeKey`/`themeTitle` only — no new `week` field.)*
4. Inject **workday/weekend weighting** + per-platform weekly cadence intent. *(P1 constraint: `targetRepliesPerDay` stays a single scalar; the prompt steers it to a sustainable weekday-level number and notes weekend pacing is a human/operator concern.)*
5. Inject **score-driven selection**: parse `analysisResult`, prioritize the weakest dimensions/platforms, reflect the targeted gap in `themeTitle`.
6. Inject **content norms**: canonical-back-to-owned-site, build-in-public, AI-citable angle, concise publish-ready copy.
7. Keep few-shot **abstract** (do NOT hardcode the AISEE/GEO example — the generator serves any project; a literal GEO few-shot would bias every plan).

### 🟡 P2 — Schema layer (changes Zod + validation + docs; no DB migration — `planPayload` is already `Json`)
8. ~~Add `week`/`phaseTitle` to `contentItems[]`~~ — **DROPPED (2026-07-17).** The week is **derivable** from `contentItems[].utcDate` + `OperationPlan.startsAt`; storing it duplicates state that can drift out of sync. Concrete dates are the single source of truth — consumers that want week grouping compute it. (The week/phase remains a *generator* concern, expressed via the `themeKey`/`themeTitle` convention from P1.)
9. ~~Make `engagePolicies` support a **per-day target schedule**~~ — **DONE (2026-07-17).** `engagePolicies[].dailyTargets: [{ date: "YYYY-MM-DD", target: n }]` overrides `targetRepliesPerDay` (now the *default* for un-listed days), keyed by concrete UTC date — no week abstraction, per the P2-8 decision. This finally makes the reference plan's "weekday 5 / weekend 3" rule expressible **and enforced**:
   - **Generation**: `GeneratedPlanSchema` + prompt instruct the model to emit the weekday default plus dated overrides for the days that differ (typically weekends). No DB migration (`planPayload` is `Json`).
   - **Validation**: dates must be `YYYY-MM-DD`, inside `[startAt, endAt]`, non-repeating, integer ≥ 0.
   - **Enforcement**: `EngageService._assertProjectDailyTarget` resolves the target for the day being sent (`dailyTargets[thatDate] ?? targetRepliesPerDay`) instead of the flat default. A `0` override is honoured as "send nothing this day" (checked by presence, not truthiness, so it isn't mistaken for "uncapped").
   - **Reporting**: `GET /operation-plans/:id` → `engageStats[date][].targetRepliesPerDay` surfaces that day's resolved target.
   - Backward compatible: plans without `dailyTargets` behave exactly as before.
10. ~~Add optional per-`platform` cadence/weight metadata~~ — **DONE (2026-07-17).** Admin-configurable via the `operation_plan.platform_cadence` Setting (`{ platform: { cadence, citationWeight, notes } }`, free-form prose since it's editorial guidance). Forwarded to the generator as the `platformPlaybook` input for the **requested** platforms only; platforms with no fields filled are skipped, and the prompt instruction is omitted entirely when the playbook is empty. A malformed Settings value degrades to the built-in defaults rather than breaking generation. Editable in aisee-manage → 配置管理 → 运营计划.

> **Naming note (not a bug):** the request body uses `startAt`/`endAt` while the column + response use `startsAt`/`endsAt`. This split is deliberate and specified by the upstream contract — `aisee-live-geo-growth-plan.md` §3: "`startAt`/`endAt` persist directly to the existing `OperationPlan.startsAt`/`endsAt` columns."

### 🟢 P3 — The reference plan's ~60% (OUT OF SCOPE for this version, per P0-1)
11. Add an **operational-task** type (corpus / technical / score-test / review) — neither a Post nor an Engage reply.
    - **Cost correction (2026-07-17):** this was previously filed as "data-model layer, largest, needs a new table". That over-stated it. `OperationPlan.planPayload` is already a `Json` column, so **storing** an `operationalTasks[]` section costs **no migration** — just a `GeneratedPlanSchema` field + prompt. The real cost is elsewhere: **(a) no materialization target** — `contentItems` become DRAFT Posts, but "build the comparison page" / "run a re-scan" is not a Post and has no carrier; **(b) no display/checkbox surface** (the reference sheet's "状态 ✓" column).
    - So the question is not *where to put them* but *what they DO once generated*. Until (a)+(b) have an answer, generating them would just produce inert JSON.
    - **Clarification of the current state:** the four task types are **not stored anywhere today, and never were** — `GeneratedPlanSchema` has no such field, so the model is never asked for them and never returns them. `planPayload`'s actual keys are `goal`, `contentItems`, `engagePolicies`, `warnings`, `campaignId`, `generatorVersion`, `durationDays`. This is an absence-of-feature, not a storage gap.
12. **Score tracking** (the Scores sheet) ↔ plan linkage: re-scan → backfill → slope comparison. Absent today.

### Validation
13. `_validateGeneratedPlan` currently has only 4 hard checks; once the above rules land, extend it (week coverage completeness, workday cadence sanity, etc.).

---

## 4. P1 applied (prompt strengthening)

**Change:** the system prompt in `operation-plan.service.ts` `create()` was rewritten to encode rules 3–6 **within the existing schema** — no schema, validation, or data-model change; `GeneratedPlanSchema` is untouched.

What the new prompt now instructs (all steered through existing fields only):
- **Week phases** via a `themeKey` phase token + a `themeTitle` prefix (no new field).
- **Workday-weighted** content counts derived from the actual dates; a single sustainable weekday-level `targetRepliesPerDay` (weekend pacing acknowledged as an operator concern, since per-day targets need P2).
- **Score-driven** prioritization of the weakest analysis dimensions/platforms, reflected in `themeTitle`.
- **Content norms**: canonical-back-to-owned-site, build-in-public, AI-citable framing, concise publish-ready copy.
- Few-shot kept **abstract** to avoid biasing non-GEO projects.

**Explicitly still NOT covered by P1** (needs P2/P3): real week/day structure fields, per-day reply schedules, the corpus/technical/score-test/review task types, non-integration channels, and computed (supply-based) quotas. Those remain in the checklist above.

## 5. keywordTargets id-mapping (resolved — approach B)

**Gap:** the design keys `engagePolicies[].keywordTargets` by `EngageKeyword.id`, but the upstream task only provides keyword **text** (`product_snapshot.keywords`), and the generator was given no `EngageKeyword` id↔text mapping — so the LLM could never produce valid id keys, and downstream pacing (`countProjectKeywordSentRepliesToday`) / overview (`resolveKeywordTexts`) that expect ids would not match.

**Fix (approach B — generate-with-text, map-on-persist):**
- New primitive `EngageRepository.resolveOrCreateKeywordIds(organizationId, projectId, keywords[])` — returns `{ text: EngageKeyword.id }`, creating any missing keyword (via `addKeyword`, so initial-scan seeding + `(configId, keyword)` conflict handling are consistent), after `getOrCreateConfig`. Normalized dedup (`normalizeKeyword`). **Writes rows** — not for read-only paths.
- The generator prompt now asks for `keywordTargets` keyed by **keyword text**. On the real persist path, `OperationPlanService._mapKeywordTargetsToIds` rewrites each policy's `keywordTargets` from text → id (get-or-create) before storing `planPayload`.
- **Dry-run keeps text keys and creates nothing** (the preview stays write-free; mapping runs only on the billing/persist path).
- `GeneratedPlanSchema` unchanged (`z.record(z.number())` — keys are strings either way). Texts that normalize to one keyword (e.g. `"AI"`/`"ai"`) collapse to one id, summing targets.

**Curated keyword override (added):** because `product_snapshot.keywords` are SEO/brand keywords (not necessarily the intended Engage *scan* keywords), the request body now accepts an optional `keywords: string[]`. Keyword-source priority: (1) `input.keywords` verbatim when non-empty; (2) the AI-analyzed `result.code_web_analyzer.keywords` (semantic, analysis-derived — preferred over the SEO tags); (3) `product_snapshot.keywords` (last resort). The generator is instructed to use ONLY keywords from the resolved list. Whatever it targets still gets get-or-created on the persist path.

**version_name mapping (fixed):** the aisee payload carries the analysis revision as `version_name` (e.g. "12.0"), but the client read only `version`/`task_version` → `OperationPlan.sourceTaskVersion` was always null. `getTaskDetail` now falls back to `version_name`. This is audit/provenance only ("which analysis revision this plan was built from") — unrelated to Engage runtime, which never reads `sourceTaskVersion`.
