# Automation API

A project's **Automation** surface: scheduled publishing (turn an operation
plan's drafts into queued posts) and managed replies (Engage). One project-scoped
namespace, three endpoints.

All routes are under `/projects/:projectId/automation` and require the standard
auth cookie/header.

## Why the project is in the path

`ProjectAuthGuard` is a **global** guard, but it only activates on a request that
actually carries a `projectId` — as a route param, query param, or body field. A
route without one is authorized by org membership alone.

The endpoints this namespace replaces did not carry one. `GET /operation-plans/:id`
and the old `POST /posts/schedule { planId }` were project-scoped actions wearing
org-scoped requests, which meant:

- an org member could read and activate **another project's** plan, and
- a project that had been **deactivated** could still be made to queue posts,
  despite the guard's rule that deactivating a project stops it producing new work.

Naming the project in the path fixes both, and the guard's GET/mutation split
lands correctly for free: the overview needs only project **access** (a
deactivated project must stay readable so its owner can inspect and re-enable it),
while both writes require the project to be **active**.

`AutomationService` additionally asserts that the plan it is about to commit
belongs to the authorized project — the guard authorizes the *id*, not the
relationship between the two.

## The switch chain

Three levels, ANDed. Nothing runs unless every level above it is on.

| Level | Scheduled publishing | Managed replies |
| --- | --- | --- |
| **Master** | `metadata.automationEnabled` | same key |
| **Feature** | `metadata.publishingEnabled` | `metadata.autoReplyMode != 'off'` |
| **Platform** | `metadata.replyPolicies[p].publishingEnabled` | `metadata.replyPolicies[p].autoReplyEnabled` |

All of it lives in one `EngageConfig.metadata` JSON column, read through
`engage-config-metadata.ts` — see [Where these settings live](#where-these-settings-live).

**Every switch defaults to OFF when absent.** Automation posts and replies with
the user's real accounts, so a missing — or malformed — value must never read as
authorized; this matches `enabled` and `autoReplyMode`, which have always
defaulted off for the same reason.

Nothing grandfathers a project in, either: configuring replies or picking
platforms is not the same as authorizing them to run. Every project starts with
Automation off and someone turns it on.

`publishingEnabled` is the one genuine three-state — absent means "never chosen",
which resolves from the platform selection, and that is distinct from an explicit
`false`. It is not a permission default: the master switch above it still has to
be on for anything to publish.

The managed-replies feature switch **is** `autoReplyMode`, not a second boolean
beside it — one question, one answer, no precedence rule to get wrong. The mode
also carries `review` vs `auto`, so the switch and the mode were already the same
field.

**The switches gate FUTURE work only.** A post already in `QUEUE`, or a reply the
extension is mid-send on, is past the gate and finishes. Turning a switch off is
a configuration change, not a recall — it stops new posts entering the queue
(`schedulePlanPosts` short-circuits) and stops the reply driver handing anything
out (`getAutoReplyConfigs` filters the project out of the query, so no budget or
pacing lookup is spent on it). Nothing is un-queued and nothing is rolled back to
`DRAFT`.

**A switch suspends, it does not reset.** Turning the master off leaves both
feature switches and every platform selection exactly as they were, so turning it
back on restores the configuration rather than an empty form. Same for the
publishing feature switch: it is a column of its own, so switching it off keeps
the platform list instead of clearing it.

**Scanning is deliberately not gated.** `EngageConfig.enabled` remains the Engage
feature's own switch and still governs discovery. Turning Automation off stops
replying, not finding — so conversations keep accumulating and are there to act
on the moment it comes back. Gate scanning too by adding `automationEnabled` to
the scan queries, if that is ever wanted.

### Reading the switches from a client

`GET /automation` reports each feature's **own** switch (`enabled`) separately
from the AND with the master (`active`):

- render the switch controls from `enabled` — rendering them from `active` makes
  both snap to off the moment the master goes off, which reads as "your settings
  were cleared" rather than "suspended";
- render status, counts, and "will this run" from `active`.

`publishing.enabledConfigured` distinguishes an explicit choice from the legacy
derived rule (see the column comment on `publishingEnabled`): projects that
predate the column resolve their feature switch from "is any platform on", so a
deploy changes nothing for them.

## Where these settings live

One JSON column: `EngageConfig.metadata`, read and written only through
`libraries/nestjs-libraries/src/engage/engage-config-metadata.ts`.

`autoReplyMode` and `replyPolicies` used to be columns of their own, and the
Automation switches were about to add two more. None of them is ever queried
BY — the driver loads the config row and reads them in code — so every new knob
cost a migration and bought nothing. `enabled` stays a real column precisely
because scan enumeration *does* filter on it, which is the test for whether a
value belongs in a column at all.

Two consequences worth knowing:

**The switch chain is applied in code, not in SQL.** A JSON path filter could
express it, but keeping it in TypeScript means the reply driver's gate and every
other read share one implementation of the defaults — and a default that differs
between the query and the code is exactly the bug that would be hardest to see.
`getAutoReplyConfigs` therefore filters `enabled` + `projectId` in the query and
applies the chain after. Affordable because the row count there is "projects in
this org", not "opportunities".

**One reader, one writer.** `readEngageConfigMetadata` applies the defaults and
drops malformed values; `mergeEngageConfigMetadata` folds a patch onto the
current settings and returns the whole object, so the stored blob is always
self-describing rather than a sparse diff readers have to reassemble. Nothing
else parses the column.

> **The model name is a misnomer.** `EngageConfig` now holds the per-project
> config for both Engage *and* scheduled publishing. Renaming it is a code-only
> change (`@@map("EngageConfig")` keeps the table) but touches every
> `engageConfig` model reference and `PrismaRepository<'engageConfig'>` type
> argument, so it is tracked separately. Read it as "project automation config".

## What Automation does NOT touch

**Hand-created posts.** A post the user wrote themselves carries
`operationPlanId = null`. Every plan query matches `operationPlanId` by
**equality**, and null never equals a plan id — so turning Automation on, saving
platforms, or committing a plan can never move a manual draft. This is
structural, not a filter applied afterwards, and is pinned by
`posts.repository.plan-scope.spec.ts`.

**Superseded plans.** Re-running a project's plan soft-deletes the prior plan's
drafts, and `deletedAt: null` is part of the same query — so an old plan's posts
never resurface.

---

## GET /projects/:projectId/automation

Everything the Automation page renders, in one call. Replaces five separate
requests (two of them serialized, because the plan id had to come back before the
plan detail could be fetched).

Deliberately **not** built out of the endpoints it replaces:

- the plan side reads a **rollup** rather than every post of the plan (the page
  shows four numbers), and
- the engage side reads the bare config row rather than the fully decorated
  `GET /engage/config`, which resolves entitlements plus a scan cursor per
  keyword, channel and tracked account — none of it shown here.

It is also strictly read-only: unlike `GET /engage/config`, loading this page
does **not** create an `EngageConfig` row for a project that has never used Engage.

- **Response**:

```jsonc
{
  "projectId": "<project-uuid>",

  // The Automation master switch.
  "enabled": true,

  // null when the project has no active plan (READY, startsAt <= now <= endsAt).
  "plan": {
    "id": "<operation-plan-uuid>",
    "queue": {
      "totalPosts": 12,      // still-DRAFT roots whose publish time is still ahead
      "readyPosts": 10,      // have a body AND a resolved platform
      "attentionPosts": 2,   // totalPosts - readyPosts
      "platforms": ["x", "reddit"]
    }
  },

  "publishing": {
    // false = the project has never expressed a preference. Distinct from
    // `enabled: false` with `configured: true`, which is the master switch off.
    "configured": true,        // has the project ever chosen PLATFORMS?
    "enabled": true,           // the feature switch, on its own
    "enabledConfigured": true, // is that switch explicit, or the legacy derived rule?
    "active": true,            // master AND feature — will publishing run?
    "platforms": ["x", "reddit"],

    // EFFECTIVE windows — the project's own override already layered onto the
    // admin-level `extension_publish.time_window` setting. A platform absent
    // here is unconstrained.
    "windows": {
      "x": { "start": "09:00", "end": "17:00", "timezone": "Asia/Shanghai" }
    }
  },

  "replies": {
    "enabled": true,           // the ENGAGE feature switch (also gates scanning)
    "autoReplyMode": "off" | "review" | "auto",
    "repliesEnabled": true,    // the feature switch — the mode IS the switch
    "active": true,            // master AND feature
    // Reply-side keys only — the publishing keys that currently share the same
    // column are reported under `publishing` above.
    "policies": { "x": { "autoReplyEnabled": true, "length": "short" } },
    "accounts": [
      { "id": "<integration-uuid>", "name": "...", "picture": "...",
        "providerIdentifier": "x", "engageEnabled": true }
    ]
  },

}
```

The new-conversation count is deliberately **not** here. It is an Engage metric —
it counts opportunities discovered by scanning, which the Automation switches do
not govern — and belongs on the Engage surface next to the conversations
themselves, not on a page about switches and schedules.

### `configured` vs an empty platform list

`publishing.platforms: []` is ambiguous on its own, and the two readings are
opposite:

| | meaning | effect on a commit |
| --- | --- | --- |
| `configured: false` | never picked platforms | **unconstrained** — every platform the plan has |
| `configured: true` | every platform deliberately off | queues **nothing** |

Collapsing them would either silently stop publishing for every project that
predates this setting, or silently ignore a user turning every platform off.

This is the PLATFORM level, separate from the feature switch above it: a project
can have publishing switched on with no platform picked yet (`enabled: true`,
`platforms: []`, `configured: false`), and one with platforms picked but the
feature switched off (`enabled: false`, `platforms: ["x"]`).

---

## POST /projects/:projectId/automation/enabled

The project's Automation master switch.

- **Body**: `{ "enabled": true | false }` — required. An empty body is a `400`
  rather than being read as "off".
- **Response**: `{ "saved": true, "enabled": false }`

Writes **only** that column. Both feature switches and every platform selection
underneath keep their values, so flipping it off and back on restores exactly the
configuration that was there. Nothing is committed either way: resuming does not
retroactively queue the posts that were skipped while it was off.

Its own endpoint rather than a field on the two feature endpoints because it
governs both — folding it into either would make "suspend everything" a write
that also has to carry that feature's whole configuration.

Not routed through `EngageService.saveConfig`, for the same reason the publishing
endpoint isn't: that method starts the global Engage workflows and kicks an
immediate scan whenever it is handed `enabled`.

---

## POST /projects/:projectId/automation/publishing

Save which platforms this project publishes to and when — and, with `commit`,
queue the active plan in the same call.

- **Body**:

```jsonc
{
  // The scheduled-publishing FEATURE switch. Omit to leave it as it is — a
  // client reordering platforms should not have to restate it. Independent
  // from `platforms`: switching the feature off keeps the selection intact so
  // it comes back unchanged.
  "enabled": true,

  // The COMPLETE enabled set, not a delta: every platform absent from it is
  // turned off. A partial-update shape would make "turn every platform off"
  // inexpressible.
  "platforms": ["x", "reddit"],

  // Optional, per platform. Only the platforms named here change; a stored
  // window survives a save that does not mention it.
  //
  // SEND THE TIMEZONE. Absent, it falls back to the project's stored zone,
  // then the admin window's, then UTC — so bounds picked against a local
  // clock end up enforced against a different one. A UI that shows the user
  // a local-time window must stamp the zone that window was read in.
  "windows": {
    "x": { "start": "09:00", "end": "17:00", "timezone": "Asia/Shanghai" }
  },

  "commit": true,                        // optional — also queue the active plan
  "publishMethod": "extension" | "api"   // optional, only meaningful with commit
}
```

- **Response**: `{ "saved": true, "scheduled": <schedule result> | null }`

`scheduled` is `null` when `commit` was absent, **and** when the project has no
active plan — choosing publishing platforms is configuration, and a project may
do it before it has ever generated one. The result otherwise carries the same
`scheduled` / `failed` / `total` / `alreadyScheduled` shape as
[`POST /posts/schedule`](./posts-api.md#post-postsschedule), scoped to the
committed platform slice.

**The plan id is resolved server-side** from the project's active plan. The
client never names a plan, so it cannot name the wrong one.

**Not routed through `EngageService.saveConfig`.** That method starts the global
Engage workflows and kicks an immediate scan whenever it is handed `enabled` —
saving publishing settings has no business doing either.

### Per-platform publish time window

Three tiers, most specific wins: **project window → admin platform override →
admin global default**. The admin tiers live in the `extension_publish.time_window`
setting (see [posts-api.md](./posts-api.md)); the project tier is what this
endpoint writes.

`start`/`end` are local `"HH:MM"` and may wrap past midnight (e.g. `22:00`–`02:00`).
A platform with no window at any tier is **unconstrained**.

The zone resolves per window: the project's own `timezone` wins; absent, it
inherits the zone of the admin window it narrows (an admin who pinned
`America/New_York` meant those bounds to be New York time, and a project
shortening the hours inside that window did not mean to reinterpret them);
absent both, **UTC**. `GET /automation` returns the resolved zone alongside each
window, so a client can show which zone the times are actually enforced in
rather than assuming the viewer's own.

Applied **at commit time**, not at plan generation, so a window configured or
edited after the plan was generated still takes effect. For each `DRAFT` root
about to be committed: if its platform resolves to a window and its materialized
`publishDate` falls outside it (in the window's timezone), a **new random instant
inside the window** replaces it — re-picked, never clamped to the nearest
boundary, since the materialized time was only ever the plan's generated default.
Applies group-wide: a thread's segments share one publish time.

A malformed project window is **dropped** and the admin tier stands, rather than
the window being cleared — a bad edit must never widen publishing past what an
admin allowed.

### Platform filter

`platforms` restricts the commit to those platforms, matching
`Post.providerIdentifier` case-insensitively (`"X"` and `"x"` are the same
filter). Every count in the result — `total`, `alreadyScheduled`, `scheduled`,
`failed` — is scoped to the filtered set, so a caller that committed only `x`
never sees counts for posts it did not ask to touch.

Idempotent by construction: `state = DRAFT` is itself the filter, so a repeated
commit matches nothing. `total > 0` with an empty `scheduled` means the slice is
already committed; `total = 0` means nothing matched.

---

## POST /projects/:projectId/automation/replies

Save the managed-reply half: config flags, per-platform reply policy, and
per-account reply authorization — in one call instead of a config write plus one
request per account (whose partial failure left no coherent state to report).

- **Body** — every field optional; only what is present is written, so a client
  can flip one switch without restating the rest. An entirely empty body is a
  `400` rather than a silent no-op reported as success.

```jsonc
{
  "enabled": true,
  "autoReplyMode": "off" | "review" | "auto",

  // Merged key-by-key over what is stored, per platform.
  "policies": {
    "x": { "autoReplyEnabled": true, "length": "short", "mentionTags": ["@acme"] }
  },

  "accounts": [
    { "integrationId": "<integration-uuid>", "engageEnabled": true }
  ]
}
```

- **Response**: `{ "saved": true, "accounts": <number applied> }`

Publishing keys (`publishingEnabled`, `publishingWindowStart`,
`publishingWindowEnd`, `publishingTimezone`) sent here are **dropped**: they are
the publishing endpoint's to change. Conversely, the publishing endpoint
preserves every reply-side key. Both halves currently share
`EngageConfig.replyPolicies`, so each writer merges rather than replaces —
splitting that column is tracked separately.

Config flags **do** go through `EngageService.saveConfig`, so enabling Engage
still starts its workflows and triggers an immediate scan, exactly as
`POST /engage/config` does.
