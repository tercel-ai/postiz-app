# Integration Schedule Rules

Multi-type time-slot scheduling for integrations. Rules are combined using **union** semantics — for any given date, all matching rules contribute their time slots.

## Table of Contents

- [Data Format](#data-format)
- [Rule Types](#rule-types)
- [API Reference](#api-reference)
- [Project-Scoped Schedules (IntegrationProject)](#project-scoped-schedules-integrationproject)
- [Common Operations (CRUD Examples)](#common-operations-crud-examples)
- [Resolution Logic (Union)](#resolution-logic-union)
- [Backward Compatibility](#backward-compatibility)
- [Validation Rules](#validation-rules)
- [Frontend UI](#frontend-ui)
- [Key Files](#key-files)

---

## Data Format

### V2 Format (current)

```json
{
  "version": 2,
  "schedules": [
    { "type": "daily",        "time": 540 },
    { "type": "weekday",      "time": 840 },
    { "type": "dayOfWeek",    "day": 1, "time": 420 },
    { "type": "specificDate", "date": "2026-03-01", "time": 600 }
  ]
}
```

### Legacy Format (still accepted, auto-converted)

```json
[
  { "time": 540 },
  { "time": 840 }
]
```

When the system reads legacy data, it is transparently converted to V2 with all entries as `daily` rules. No database migration is required.

### The `time` Field

`time` is an integer representing **minutes from midnight UTC** (range: 0–1439).

| `time` value | UTC time | Example local time (UTC+8) |
|---|---|---|
| `0` | 00:00 | 08:00 |
| `540` | 09:00 | 17:00 |
| `840` | 14:00 | 22:00 |
| `1380` | 23:00 | 07:00 (+1 day) |

---

## Rule Types

### `daily` — Every Day

Matches **every day** of the year.

```json
{ "type": "daily", "time": 540 }
```

> Posts at 09:00 UTC every day.

### `weekday` — Monday through Friday

Matches **weekdays only** (Mon=1 through Fri=5).

```json
{ "type": "weekday", "time": 840 }
```

> Posts at 14:00 UTC on weekdays. Does nothing on Saturday/Sunday.

### `dayOfWeek` — Specific Day of the Week

Matches a **single day of the week**, recurring every week.

```json
{ "type": "dayOfWeek", "day": 1, "time": 420 }
```

`day` values follow JavaScript's `Date.getDay()` convention:

| `day` | Day |
|---|---|
| `0` | Sunday |
| `1` | Monday |
| `2` | Tuesday |
| `3` | Wednesday |
| `4` | Thursday |
| `5` | Friday |
| `6` | Saturday |

> Posts at 07:00 UTC every Monday.

### `specificDate` — One Exact Date

Matches a **single calendar date** (non-recurring).

```json
{ "type": "specificDate", "date": "2026-03-01", "time": 600 }
```

> Posts at 10:00 UTC on March 1, 2026 only. Does nothing on any other date.

---

## API Reference

### Endpoints

| Method | Path | Scope | Description |
|---|---|---|---|
| `GET` | `/integrations/list` | org | Read all integrations with their (org-level) schedule rules |
| `POST` | `/integrations/:id/time` | org | Replace all schedule rules for one integration (account default) |
| `GET` | `/integrations/integration-project/list?projectId=` | project | Channels bound to a project, each with that project's schedule |
| `POST` | `/integrations/integration-project` | project | Bind/update a channel↔project pair (partial-merge; see [Project-Scoped Schedules](#project-scoped-schedules-integrationproject)) |
| `DELETE` | `/integrations/integration-project?integrationId=&projectId=` | project | Unbind a channel from a project (hard delete) |

> **Important:** The org-level `POST /integrations/:id/time` uses **full-replacement** semantics. Every call replaces the entire `schedules` array. There is no PATCH — to add, modify, or delete a single rule, the client must read the current state, modify the array, and POST the full result back.
>
> The **project-level** `POST /integrations/integration-project` is different — it is a **partial-merge upsert**: only the fields present in the body (`postingTimes` and/or `disabled`) change. The `postingTimes` payload itself, when present, is still a full `schedules` array (same validation as the org endpoint).

### Read — `GET /integrations/list`

Returns all integrations. The `time` field on each integration contains the V2 schedule:

```json
{
  "integrations": [
    {
      "id": "abc123",
      "name": "My Twitter",
      "time": {
        "version": 2,
        "schedules": [
          { "type": "daily", "time": 540 },
          { "type": "weekday", "time": 840 }
        ]
      }
    }
  ]
}
```

Old data stored in legacy format is converted on read — the API always returns V2.

### Write — `POST /integrations/:id/time`

**V2 format (recommended):**

```json
{
  "version": 2,
  "schedules": [
    { "type": "daily", "time": 540 },
    { "type": "weekday", "time": 840 },
    { "type": "dayOfWeek", "day": 5, "time": 960 },
    { "type": "specificDate", "date": "2026-12-25", "time": 720 }
  ]
}
```

**Legacy format (still accepted):**

```json
{
  "time": [
    { "time": 540 },
    { "time": 840 }
  ]
}
```

Legacy payloads are automatically converted to V2 (`daily` rules) before storage.

**Response:** `{ "id": "<integration-id>" }`

**Error (400):** Returned when validation fails:

```json
"Schedule rule 0: time must be an integer between 0 and 1439"
```

---

## Project-Scoped Schedules (IntegrationProject)

A channel (`Integration`) is org-level, but a single channel can be **shared by
multiple projects**, and each project may want its **own posting times** on that
channel. That relationship — and its per-pair schedule — lives in the
`IntegrationProject` join table, not on `Integration` (defined in
`libraries/.../prisma/schema.prisma`). The behavior:

| Aspect | Org-level (`Integration.postingTimes`) | Project-level (`IntegrationProject.postingTimes`) |
|---|---|---|
| Who owns it | the channel (account default) | the `(integration, project)` pair |
| Set via | `POST /integrations/:id/time` (full replace) | `POST /integrations/integration-project` (partial merge) |
| Read via | `GET /integrations/list` | `GET /integrations/integration-project/list?projectId=` |
| Used for scheduling by | `find-slot` **without** `projectId` | `find-slot` **with** `projectId` |

### Semantics

- **No fallback.** Project-scoped slots come **only** from the
  `IntegrationProject` row. A pair whose `postingTimes` is empty means that
  project has **no** posting times on that channel — the scheduler will not
  auto-schedule to it. It does **not** fall back to `Integration.postingTimes`.
- **Unbound = invisible.** A channel with no `IntegrationProject` row for a
  project does not belong to that project and never appears in its channel list.
- **`disabled` (per-project pause).** A binding can be paused
  (`disabled: true`) to keep the pair and its schedule while temporarily
  excluding the channel from that project's scheduling. Effective enablement is
  `Integration.disabled OR IntegrationProject.disabled` — disabling the channel
  globally overrides all its project bindings.
- **Hard delete on unbind.** Unbinding removes the row (and its schedule)
  outright; there is no soft delete.

### Bind / update a pair — `POST /integrations/integration-project`

```jsonc
// Bind (no schedule yet) — creates the pair with an empty schedule:
{ "integrationId": "abc123", "projectId": "prj_9" }

// Set this project's schedule on the channel (partial merge — disabled untouched):
{
  "integrationId": "abc123",
  "projectId": "prj_9",
  "postingTimes": {
    "version": 2,
    "schedules": [
      { "type": "weekday", "time": 540 },
      { "type": "weekday", "time": 840 }
    ]
  }
}

// Pause this channel for this project (partial merge — postingTimes untouched):
{ "integrationId": "abc123", "projectId": "prj_9", "disabled": true }
```

Because it is a partial merge, toggling `disabled` never wipes `postingTimes`
and vice versa. The call is idempotent on the `(integrationId, projectId)` key.

### Unbind — `DELETE /integrations/integration-project?integrationId=abc123&projectId=prj_9`

Keys go in the **query string**, not a body (DELETE bodies are unreliable across
proxies). Returns `{ "success": true }`. The channel's org-level schedule and
any other project's binding are unaffected.

### Read a project's channels — `GET /integrations/integration-project/list?projectId=prj_9`

Same shape as `GET /integrations/list`, plus a `projectDisabled` flag; each
channel's `time` field is **that project's** normalized schedule.

### Scheduling with a project

Pass `?projectId=` to `find-slot` to schedule against the project's slots:

```
GET /posts/find-slot?projectId=prj_9              → next slot across the project's channels
GET /posts/find-slot/:integrationId?projectId=prj_9  → next slot for one channel in that project
GET /public/v1/find-slot/:integrationId?projectId=prj_9  → same, public API
```

Omitting `projectId` preserves the legacy org-level behavior. Autopost and the
AI agent currently have no project context and always schedule org-level.

> **Not affected:** Operation-plan post generation does **not** use time slots —
> each generated post's `publishDate` comes from the plan payload's `utcDate`,
> so project schedules do not apply there.

---

## Common Operations (CRUD Examples)

Since the API is full-replacement, every write operation follows the same flow:

```
1.  GET  /integrations/list          → read current schedules
2.  (modify the schedules array in memory)
3.  POST /integrations/:id/time      → write the full new array
```

All examples below assume the integration `abc123` starts with this state:

```json
{
  "version": 2,
  "schedules": [
    { "type": "weekday", "time": 540 },
    { "type": "weekday", "time": 840 }
  ]
}
```

> Two weekday slots: 09:00 and 14:00 UTC, Monday through Friday.

---

### Add a Rule

**Goal:** Keep the existing weekday slots, and also add a Saturday 10:00 slot.

**Step 1 — Read** current schedules from `GET /integrations/list` (see `time` field on integration `abc123`).

**Step 2 — Append** the new rule to the array:

```diff
  {
    "version": 2,
    "schedules": [
      { "type": "weekday", "time": 540 },
      { "type": "weekday", "time": 840 },
+     { "type": "dayOfWeek", "day": 6, "time": 600 }
    ]
  }
```

**Step 3 — POST** the full array:

```
POST /integrations/abc123/time

{
  "version": 2,
  "schedules": [
    { "type": "weekday", "time": 540 },
    { "type": "weekday", "time": 840 },
    { "type": "dayOfWeek", "day": 6, "time": 600 }
  ]
}
```

**Result:**

| Day | Slots |
|---|---|
| Mon–Fri | 09:00, 14:00 |
| Saturday | 10:00 |
| Sunday | (none) |

---

### Delete a Rule

**Goal:** Remove the 14:00 weekday slot, keep only 09:00.

**Step 1 — Read** current schedules.

**Step 2 — Remove** the unwanted rule from the array:

```diff
  {
    "version": 2,
    "schedules": [
      { "type": "weekday", "time": 540 },
-     { "type": "weekday", "time": 840 }
    ]
  }
```

**Step 3 — POST:**

```
POST /integrations/abc123/time

{
  "version": 2,
  "schedules": [
    { "type": "weekday", "time": 540 }
  ]
}
```

**Result:** Only 09:00 on weekdays.

---

### Delete All Rules — Clear the Schedule

**Goal:** Remove all posting time slots from an integration.

No need to read first — just POST an empty `schedules` array:

```
POST /integrations/abc123/time

{
  "version": 2,
  "schedules": []
}
```

**Result:** The integration has zero posting slots on every day. The scheduler will find no available times for this integration and will not auto-schedule any posts to it.

> **Note:** This does not delete existing scheduled/queued posts. It only affects future auto-scheduling. Posts that are already in the queue will still be published at their assigned times.

---

### Modify a Rule — Change Time

**Goal:** Move the 09:00 weekday slot to 10:00.

**Step 1 — Read** current schedules.

**Step 2 — Change** the `time` value on the target rule:

```diff
  {
    "version": 2,
    "schedules": [
-     { "type": "weekday", "time": 540 },
+     { "type": "weekday", "time": 600 },
      { "type": "weekday", "time": 840 }
    ]
  }
```

**Step 3 — POST** the updated array.

---

### Modify a Rule — Change Type (Weekday 09:00 → Monday-only 09:00)

**Goal:** The 09:00 slot currently fires Mon–Fri. Change it to fire on **Monday only**.

This is a **delete + add** in one operation: remove the old `weekday` rule, add a new `dayOfWeek` rule.

**Step 1 — Read** current schedules:

```json
{
  "version": 2,
  "schedules": [
    { "type": "weekday", "time": 540 },
    { "type": "weekday", "time": 840 }
  ]
}
```

**Step 2 — Replace** the `weekday` 540 rule with a `dayOfWeek` rule:

```diff
  {
    "version": 2,
    "schedules": [
-     { "type": "weekday", "time": 540 },
+     { "type": "dayOfWeek", "day": 1, "time": 540 },
      { "type": "weekday", "time": 840 }
    ]
  }
```

**Step 3 — POST:**

```
POST /integrations/abc123/time

{
  "version": 2,
  "schedules": [
    { "type": "dayOfWeek", "day": 1, "time": 540 },
    { "type": "weekday", "time": 840 }
  ]
}
```

**Result:**

| Day | Slots |
|---|---|
| Monday | 09:00, 14:00 |
| Tue–Fri | 14:00 |
| Sat–Sun | (none) |

Why does Monday have two slots? The `dayOfWeek(1)` rule contributes 09:00 on Monday, and the `weekday` rule contributes 14:00 on all weekdays (including Monday). Union merges them.

---

### Bulk Replace — Full Schedule Reset

**Goal:** Throw away all existing rules and set a completely new schedule.

Simply POST the new array without reading the old one:

```
POST /integrations/abc123/time

{
  "version": 2,
  "schedules": [
    { "type": "daily", "time": 480 },
    { "type": "specificDate", "date": "2026-12-25", "time": 720 }
  ]
}
```

**Result:** 08:00 UTC every day, plus an extra 12:00 slot on Christmas.

---

### Add a One-off Slot for a Specific Date

**Goal:** Keep the regular weekday schedule, but add an extra 18:00 slot on March 15 for a product launch.

```
POST /integrations/abc123/time

{
  "version": 2,
  "schedules": [
    { "type": "weekday", "time": 540 },
    { "type": "weekday", "time": 840 },
    { "type": "specificDate", "date": "2026-03-15", "time": 1080 }
  ]
}
```

**Result:**

| Day | Slots |
|---|---|
| Mon–Fri (normal) | 09:00, 14:00 |
| Sun, March 15 | 18:00 (specificDate only, weekday rules don't match Sunday) |

Wait — March 15, 2026 is a **Sunday**. The weekday rules won't fire that day, so the only slot is the `specificDate` 18:00. If March 15 were a weekday, the result would be 09:00, 14:00, 18:00 (union of all three).

---

### Frontend Workflow

In the UI, these operations map to user actions in the time-table modal:

| Operation | User Action |
|---|---|
| **Add** | Select rule type + day/date (if needed) + hour/minute, click "Add" |
| **Delete** | Hover over a slot in the list, click the trash icon, confirm |
| **Modify type** | Delete the old rule, add a new rule with the desired type |
| **Modify time** | Delete the old rule, add a new rule with the same type but different time |
| **Save** | Click "Save Changes" — sends the full `schedules` array to `POST /:id/time` |

The modal accumulates all changes locally. Nothing is sent to the server until "Save Changes" is clicked. If the user closes the modal without saving, all changes are discarded.

---

## Resolution Logic (Union)

When the scheduler needs to find available time slots for a given date, it evaluates **every rule** and collects all matching time values into a **union set** (deduplicated).

### Example Configuration

```json
{
  "version": 2,
  "schedules": [
    { "type": "daily",        "time": 540 },
    { "type": "daily",        "time": 900 },
    { "type": "weekday",      "time": 720 },
    { "type": "dayOfWeek",    "day": 1, "time": 420 },
    { "type": "specificDate", "date": "2026-03-02", "time": 600 }
  ]
}
```

### Resolution by Day

**Monday, March 2, 2026:**

| Rule | Matches? | Time added |
|---|---|---|
| `daily` time=540 | Yes (always) | 540 |
| `daily` time=900 | Yes (always) | 900 |
| `weekday` time=720 | Yes (Mon is weekday) | 720 |
| `dayOfWeek` day=1 time=420 | Yes (Mon = 1) | 420 |
| `specificDate` 2026-03-02 time=600 | Yes (exact match) | 600 |

**Result:** `[420, 540, 600, 720, 900]` — 5 posting slots

---

**Tuesday, March 3, 2026:**

| Rule | Matches? | Time added |
|---|---|---|
| `daily` time=540 | Yes | 540 |
| `daily` time=900 | Yes | 900 |
| `weekday` time=720 | Yes (Tue is weekday) | 720 |
| `dayOfWeek` day=1 time=420 | No (Tue = 2, not 1) | — |
| `specificDate` 2026-03-02 time=600 | No (wrong date) | — |

**Result:** `[540, 720, 900]` — 3 posting slots

---

**Saturday, March 7, 2026:**

| Rule | Matches? | Time added |
|---|---|---|
| `daily` time=540 | Yes | 540 |
| `daily` time=900 | Yes | 900 |
| `weekday` time=720 | No (Sat is not weekday) | — |
| `dayOfWeek` day=1 time=420 | No (Sat = 6) | — |
| `specificDate` 2026-03-02 time=600 | No | — |

**Result:** `[540, 900]` — 2 posting slots

---

### Deduplication

If multiple rules produce the same time value for a given day, it counts as **one slot**:

```json
{
  "version": 2,
  "schedules": [
    { "type": "daily",   "time": 540 },
    { "type": "weekday", "time": 540 }
  ]
}
```

On a Wednesday, both rules match with time=540. The result is `[540]` (one slot), not `[540, 540]`.

### Days with No Slots

If no rule matches a given date (e.g., Saturday with only `weekday` rules), that day has **zero posting slots** and the scheduler skips to the next day.

---

## Backward Compatibility

| Scenario | Behavior |
|---|---|
| Old data in DB: `[{"time":120},{"time":400}]` | `normalizePostingTimes()` converts to V2 with `daily` rules on read |
| Old client sends `{"time":[{"time":540}]}` | Service converts to V2 `daily` rules, validates, stores as V2 |
| New client sends V2 | Stored as-is after validation |
| `GET /integrations/list` | Always returns V2 format regardless of stored format |

No database migration is needed. The `postingTimes` column remains a `String` type. Conversion happens lazily at read time.

---

## Validation Rules

All schedule rules are validated before storage. The following constraints apply:

| Field | Constraint | Error message |
|---|---|---|
| `type` | Must be one of: `daily`, `weekday`, `dayOfWeek`, `specificDate` | `invalid type "..."` |
| `time` | Integer, `0 <= time < 1440` | `time must be an integer between 0 and 1439` |
| `day` (dayOfWeek only) | Integer, `0 <= day <= 6` | `dayOfWeek.day must be an integer 0~6` |
| `date` (specificDate only) | String matching `YYYY-MM-DD`, must be a valid calendar date | `specificDate.date must be YYYY-MM-DD` or `not a valid calendar date` |

Extra properties on rule objects are stripped before storage (only `type`, `time`, `day`, `date` are kept).

---

## Frontend UI

The time-table modal (`time.table.tsx`) provides:

1. **Rule type selector** — dropdown with: Every Day / Weekdays (Mon-Fri) / Day of Week / Specific Date
2. **Day of week dropdown** — shown only when "Day of Week" is selected (Sunday through Saturday)
3. **Date picker** — shown only when "Specific Date" is selected
4. **Hour / Minute selectors** — always visible, sets the time-of-day in local time
5. **Schedule list** — sorted by rule type then time, each entry shows:
   - Time in local format (HH:mm)
   - Color-coded badge: purple (daily), blue (weekday), amber (day of week), green (specific date)
   - Delete button on hover

The calendar day-view (`calendar.tsx`) filters schedule rules to show only those matching the currently viewed date.

---

## Key Files

| File | Purpose |
|---|---|
| `libraries/.../dtos/integrations/posting-times.types.ts` | TypeScript type definitions for all rule types |
| `libraries/.../dtos/integrations/posting-times.utils.ts` | `normalizePostingTimes`, `resolveTimeSlotsForDate`, `validateScheduleRules`, `serializePostingTimes` |
| `libraries/.../dtos/integrations/posting-times.utils.spec.ts` | 40 unit tests covering all functions |
| `libraries/.../integrations/integration.service.ts` | `serializeTimesBody()` (shared validation), `setTimes()`, `upsertIntegrationProject()` / `removeIntegrationProject()` / `listProjectIntegrations()`, `findFreeDateTime(orgId, integrationId?, projectId?)` (project-aware merge) |
| `libraries/.../integrations/integration.repository.ts` | `setTimes()`, `getProjectPostingTimes()`, `upsertIntegrationProject()` / `removeIntegrationProject()` / `listProjectIntegrations()`, `createOrUpdateIntegration()` (default V2 times) |
| `libraries/.../posts/posts.service.ts` | `findFreeDateTime(orgId, integrationId?, projectId?)` wrapper + `findFreeDateTimeRecursive()` — date-aware slot resolution with 365-day guard |
| `apps/backend/.../integrations.controller.ts` | `POST /:id/time`, `GET /list`, `POST`/`DELETE`/`GET` `/integration-project*` (project bindings) |
| `apps/backend/.../public-api/.../public.integrations.controller.ts` | `GET /public/v1/find-slot/:id?projectId=` |
| `libraries/.../prisma/schema.prisma` | `IntegrationProject` model (per-project binding + `postingTimes` + `disabled`) |
| `apps/frontend/.../calendar.context.tsx` | Frontend `PostingTimesV2` / `ScheduleRule` types |
| `apps/frontend/.../time.table.tsx` | Schedule rule editor UI |
| `apps/frontend/.../calendar.tsx` | Day-view filtering by rule type |
| `libraries/.../prisma/schema.prisma` | `postingTimes` column default (V2 format) |
