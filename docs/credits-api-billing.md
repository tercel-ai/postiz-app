# Credits: What Each API Call Costs

Which API calls spend credits, how much, what shows up on the statement, and what
happens when the balance runs out. Organised by endpoint, so you can look up a
feature and get an answer.

---

## 1. The short version

- Credits are the unit of AI spend. **$1 = 100 credits.**
- Most AI calls are charged **by tokens actually consumed** — a long post costs
  more than a short one. A few are charged at a **flat rate** per item.
- Charging happens **after** the call succeeds. A failed generation costs nothing.
- **Running out does not block the work.** Deductions go through and the shortfall
  is recorded as debt. Only the Agent chat endpoint pre-checks the balance.

---

## 2. What each endpoint costs

### Charged by tokens

Cost scales with the length of the input and the output.

| Endpoint | What it does | Charged as |
|---|---|---|
| `POST /copilot/agent` | Agent chat (the assistant on the Agent page) | `ai_copywriting` / `chat` |
| `POST /copilot/chat` ⚠️ | Site-wide editor assistant + autosuggestions — **off unless `COPILOT_CHAT_ENABLED=true`** | `ai_copywriting` / `chat` |
| `POST /posts/generator` | Generate posts from a brief | `ai_copywriting` / `post_gen` |
| `POST /posts/generator/draft` | Same, draft mode | `ai_copywriting` / `post_gen` |
| `POST /engage/opportunities/:id/generate-post` | Reference-post generation | `ai_copywriting` / `post_gen_reference` |
| `POST /projects/:projectId/operation-plans` | Generate an operation plan | `operation_plan` |

An operation plan makes **many** LLM calls (a main generation plus per-post
shrink passes). They are billed as **one transaction** with a per-call breakdown —
one charge on the statement, not twenty.

### Image generation

| Endpoint | What it does | Charged as |
|---|---|---|
| `POST /media/generate-image` | Generate an image | `image_gen` / `image` |
| `POST /media/generate-image-with-prompt` | Generate an image, AI writes the prompt first | `image_gen` / `image` |

**On the default configuration these are charged by tokens too**, not per image —
the default image model (`gemini-3.1-flash-image-preview`) is priced per token, at
roughly a third of the text rate. A per-image mode exists and can be switched on
in `ai_model_pricing` (§6.1), but nothing uses it out of the box.

With prompt enhancement on, one call produces **two** line items — the prompt text
and the image — both on the same charge.

### Charged at a flat rate

Length does not matter; the price is fixed per item.

| Endpoint | What it does | Charged as |
|---|---|---|
| `POST /engage/opportunities/:id/draft` | Generate an engage reply draft | `engage_reply`, **fixed price per reply length** (short / medium / long) |
| `POST /posts` | Publish a post beyond the plan's included quota | `post_overage`, fixed per post |
| *(internal)* Post analytics refresh | Refresh metrics for a published post | fixed per platform — **off by default**, see §6 |

Engage reply drafts also count against a **monthly cap** separate from credits.
Hitting the cap returns `403 engage_reply_cap_reached` — that is a plan limit, not
a balance problem, and upgrading is the only way past it.

### Free — these call AI but are not charged

| Endpoint | Note |
|---|---|
| `POST /posts/separate-posts` | Splits long content into a thread. Consumes tokens, bills nothing. |
| `POST /media/generate-video` | Video generation is not wired to credits yet. |

There is also a **configuration-dependent gap**: `POST /copilot/chat` is only
metered when the deployment runs on OpenRouter (`IMAGE_PROVIDER=openrouter`). On
a direct-OpenAI deployment that endpoint consumes AI without charging.

> These are gaps, not policy. If you are forecasting cost from billing records,
> these calls are invisible in them.

---

## 3. How the amount is worked out

For token-charged calls:

```
cost = input_tokens × input_price + output_tokens × output_price
```

Prices are per **single token** and come from the admin-editable
`ai_model_pricing` config (§6). The default text pricing bills roughly **4× more
for output than for input** — generated text is the expensive part, not the prompt.

**There is one text price and one image price, not a price per model.** Whichever
model actually served the request, a text call is priced from the `text` entry and
an image call from the `image` entry. The model name is recorded on the charge for
audit, but it does not change the rate.

One rule worth knowing: **a call that produces no usable token count is still
charged**, at a small floor amount per call. AI that ran is never free.

Flat-rate calls read their amount straight from the config; no token counting is
involved. The `per_image` mode (`count × price`) works the same way, but is not
enabled by default — see §2.

---

## 4. Running out of credits

**Work is not blocked.** A deduction against an insufficient balance still
succeeds, and the shortfall is recorded as debt on the charge. This is deliberate:
an autosuggestion that fails mid-sentence because a balance crossed zero is worse
than a small negative balance.

The one exception: **`POST /copilot/agent`** pre-checks the balance and returns
**`402`** with the required amount and current balance when it is at or below
zero. It is a deliberate conversation turn, so it is worth stopping up front.

Separately, a subscription that has lapsed blocks posting and channels outright —
that is a subscription state, not a credit balance. `GET /user/subscription`
returns `noActiveSubscription: true` with a `blockedReason` saying which of three
situations it is:

| `blockedReason` | Means | What to tell the user |
|---|---|---|
| `no_package` | No subscription to bill against | Subscribe |
| `invalid_status` | Cancelled, expired, or refunded — `status` names which | Renew |
| `stale_period` | Status is still valid but the period lapsed long ago | **Contact support** — a renewal webhook was missed on our side, so they most likely *did* pay |

`stale_period` is the one worth handling separately: telling a paying customer to
subscribe because a webhook was dropped is the wrong answer. `status` carries
aisee-core's raw value and is present whenever a package was returned at all.

---

## 5. Reading the statement

Every charge writes a record carrying the amount, the per-model breakdown, the
business type, and the related entity (post, plan, opportunity) where one exists.

### One charge does not always mean one API call

Two endpoints deliberately group calls into a single charge:

- **Operation plans** — every LLM call for one plan lands on one charge, broken
  down per model.
- **`POST /copilot/chat`** — charges are **accumulated per hour**, not per
  request. Its autosuggestion boxes fire on every typing pause, so one charge per
  request would put a ledger line behind every keystroke pause. Expect **one
  charge per active hour**, tagged with how many calls it covers and which UI
  produced them (`Chat`, `Suggestion`, `Task`, `TextareaCompletion`,
  `TextareaPopover`).

An accumulating hour is charged when the next hour's activity begins, or sooner
if it crosses a threshold. A session that stops mid-hour leaves its last chunk
**pending until someone settles it** — it is visible and chargeable, it just is
not automatic.

### What a record's status means

| Status | Meaning |
|---|---|
| `success` | Charged. |
| `pending` | Record written, charge not completed — needs attention. |
| `failed` | The charge was rejected. Retryable. |
| `accruing` | Still accumulating, **not charged yet**. Normal for `/copilot/chat`. |
| `skipped` | Credit billing not configured on this deployment. |
| `internal` | Subscription billing (`BILL_TYPE=internal`) — recorded, no credits moved. |
| `reserved` | Engage reply slot held against the monthly cap. |
| `released` | Reservation returned (generation failed) — does not count. |
| `unbilled` | Reply was delivered but the charge failed. Still counts against the cap, so a billing outage cannot be used to exceed it. |

`accruing` is **not** a problem state — it is what a live `/copilot/chat` session
looks like. `pending` and `failed` are the ones worth chasing.

### Where to look

**Admin endpoints** (`/admin/billing/…`) list and summarise these records, and can
re-run a charge that failed or settle one that is still accumulating:

- `GET /records` — the ledger, filtered by business **scene** (which product action
  burned the credits, not just the coarse business type), plus status, date range,
  single-charge amount range and a keyword. Its `totals` is the credit sum over the
  whole filtered set, not the page.
- `GET /stats` — the same filtered set, aggregated per scene: how many charges and,
  the number this page exists for, **how much one charge of that business costs** on
  average, at least and at most.
- `GET /meta` — what the filters accept, including every scene with a one-line
  description of the spend it represents.

Full parameter reference: [admin-api.md § Billing](./admin-api.md#billing).

**There is no end-user endpoint for the credit balance in this API.** Balance and
statement live on the Aisee side and are read there. Note that
`GET /copilot/credits` is **not** it — that returns the *subscription* allowance
for images/videos under subscription billing, a different quota entirely.

---

## 6. Every knob that changes what is charged

Three tiers, in order of how fast a change lands: **Settings** (live, or within
5 min), **environment variables** (needs a restart), **code constants** (needs a
deploy).

### 6.1 Settings — editable at runtime

Written with `PUT /admin/settings/<key>`. All of them **seed themselves on
startup** if absent, so the key exists before you first edit it.

---

#### `ai_model_pricing` — the price of every AI call

| | |
|---|---|
| **Structure** | `{ text: Entry, image: Entry }` where `Entry = { servicer, provider, model, billing_mode, price, input_price?, output_price? }` |
| **Default** | text: `openrouter` / `gpt-5.1`, `input_price=0.000375`, `output_price=0.0015`; image: `gemini-3.1-flash-image-preview` |
| **Seeded** | `ai-pricing.service.ts:48` `onModuleInit` |
| **Read** | `ai-pricing.service.ts:56` `getPricingConfig()` — **cached 5 minutes** |
| **Selection** | `config[usage.type]` — by **type**, not by model name |
| **Calculation** | both prices set → `prompt × input_price + completion × output_price`; otherwise → `total_tokens × price`. `per_image` → `count × price` |

```bash
curl -X PUT "$BACKEND/admin/settings/ai_model_pricing" -H 'Content-Type: application/json' \
  -d '{"value":{"text":{"servicer":"openrouter","provider":"openai","model":"gpt-5.1","billing_mode":"per_token","price":"0.0015","input_price":"0.000375","output_price":"0.0015"},"image":{"servicer":"openrouter","provider":"google","model":"gemini-3.1-flash-image-preview","billing_mode":"per_token","price":"0.00045","input_price":"0.0000225","output_price":"0.00045"}},"type":"object"}'
```

> ⚠️ **5-minute cache** — unlike the other keys here, a price change takes up to
> 5 minutes to take effect on a running instance.
> ⚠️ Prices are **strings**, and they are **credits per single token**. A
> misplaced decimal is a 10× billing error; `$1 = 100 credits`.

---

#### `engage_reply_credits` — flat price per reply draft

| | |
|---|---|
| **Structure** | `{ base: number, multipliers: { short, medium, long } }` |
| **Default** | `base=2`, `{1.0, 1.5, 2.5}` → **2 / 3 / 5** credits |
| **Seeded** | `engage-entitlement.service.ts:317` `onModuleInit` |
| **Read** | `engage-entitlement.service.ts:521` `_loadReplyCredits()` — shallow-merged onto defaults, so setting only `base` works |
| **Calculation** | `cost = max(0, round(base × multiplier))` |

```bash
curl -X PUT "$BACKEND/admin/settings/engage_reply_credits" -H 'Content-Type: application/json' \
  -d '{"value":{"base":3,"multipliers":{"short":1.0,"medium":1.5,"long":2.5}},"type":"object"}'
```

> ⚠️ `SettingsService` has **no cache** — the change is live immediately, but
> every draft generation costs one extra DB read.

---

#### `post_send_overage_cost` — price per post beyond the plan quota

| | |
|---|---|
| **Structure** | a plain `number` (not an object) |
| **Default** | `25` credits per post |
| **Seeded** | `post-overage.service.ts:108` `onModuleInit` |
| **Read** | `post-overage.service.ts:119` `getOverageCost()` — no cache |
| **Calculation** | flat: one charge of this amount per post over quota |

```bash
curl -X PUT "$BACKEND/admin/settings/post_send_overage_cost" \
  -H 'Content-Type: application/json' -d '{"value":25,"type":"number"}'
```

> Where the quota itself starts is `post_plan_limits`, below — this key only sets
> the price once it is exceeded.

---

#### `post_analytics_credits` — price per analytics refresh

| | |
|---|---|
| **Structure** | `{ enabled: boolean, default: number, perPlatform: Record<string, number> }` |
| **Default** | `{ enabled: false, default: 1, perPlatform: {} }` |
| **Seeded** | `post-analytics-credit.service.ts:39` `onModuleInit` |
| **Read** | `post-analytics-credit.service.ts:53` — `perPlatform` merged onto defaults |
| **Calculation** | `perPlatform[providerIdentifier] ?? default`, per integration per run |

```bash
curl -X PUT "$BACKEND/admin/settings/post_analytics_credits" -H 'Content-Type: application/json' \
  -d '{"value":{"enabled":true,"default":1,"perPlatform":{"x":2}},"type":"object"}'
```

> ⚠️ **`enabled` defaults to `false`** — analytics refresh currently charges
> **nothing**. Turning it on starts billing a daily job that runs per integration;
> model the volume before flipping it.
> Deduction is best-effort: a billing failure is logged and analytics still runs.

---

#### `post_plan_limits` — where overage charging begins

| | |
|---|---|
| **Structure** | per-plan `{ postSendLimit, postChannelLimit, … }`; `null` = unlimited |
| **Default** | absent → limits come from the aisee package as-is |
| **Read** | `post-plan-limits.service.ts:268` `applyOverrides()` |
| **Effect on billing** | sets the free quota; `post_send_overage_cost` prices everything past it |

> Not a price. It moves the line where charging starts, which changes the bill
> just as much.

---

### 6.2 Environment variables — need a restart

| Variable | Default | Effect |
|---|---|---|
| `COPILOT_CHAT_ENABLED` | `false` | Serves `POST /copilot/chat`. Only the exact string `true` enables it; anything else → `404`. |
| `COPILOT_CHAT_STREAM_USAGE` | `true` | Whether that endpoint asks the provider to report token counts. Set `false` only if a provider rejects the request — **the endpoint keeps working but its spend stops being charged**. |
| `IMAGE_PROVIDER` | `openai` | `openrouter` is the metered path for `POST /copilot/chat`; any other value leaves it unbilled (§2). |
| `OPENROUTER_TEXT_MODEL` | `openai/gpt-4.1` | Which model that endpoint calls. Does **not** change the rate — pricing is by type (§3). |
| `BILL_TYPE` | — | `third` = charged against credits. `internal` = subscription billing; every endpoint still records what it *would* have cost, but no credits move. |

### 6.3 Code constants — need a deploy

| Constant | Value | Meaning |
|---|---|---|
| `COPILOT_CHAT_ACCRUAL_THRESHOLD_CREDITS` | `5` | An accumulating `/copilot/chat` hour is charged early once it reaches this. Also bounds how much can sit unsettled when a session stops mid-hour (§5). |
| minimum charge | `0.01` credits **per call** | Floor applied when a call yields no usable token count. |

## 7. Questions we get asked

**"Why did one post cost more than another?"**
Token-charged calls scale with length — input and output. A long thread with a
long brief costs several times a one-liner. Per-image and flat-rate calls do not
vary.

**"I was charged but the generation failed."**
Charging happens after success. If a charge exists for a failed generation, the
failure happened after the AI returned — worth reporting.

**"The balance went negative."**
Expected. See §4 — debt is allowed by design.

**"Autosuggestions are eating credits."**
They are token-charged like anything else, and they fire on typing pauses rather
than on an explicit action. `COPILOT_CHAT_ENABLED` turns that whole surface off.
Charges from it record which UI produced them, so the share is measurable before
deciding.

**"There are fewer charges than I expected."**
`/copilot/chat` groups an hour of activity into one charge, and operation plans
group a whole plan into one — see §5. Check the call count on the record before
concluding something went unbilled.

**"A charge sat at `accruing` and never completed."**
That session stopped mid-hour. It is settled when the org is active again, or
manually via the admin endpoints.

**"Cost forecasts do not match the bill."**
Check §2's *free* list first — those calls consume AI without appearing in any
billing record. On a non-OpenRouter deployment, add `/copilot/chat` to that list.

**"Spend looks flat and uniform across very different requests."**
Either `ai_model_pricing` is missing its `text`/`image` entry entirely, so every
call falls through to the per-call floor — or the calls really are being billed at
one rate, which is expected: there is one text price, not a price per model. See §3.
