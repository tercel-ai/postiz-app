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

Where each level is **stored** (all inside one `EngageConfig.metadata` JSON
column, read through `engage-config-metadata.ts` — see
[Where these settings live](#where-these-settings-live)):

| Level | Scheduled publishing | Managed replies |
| --- | --- | --- |
| **Master** | `metadata.automationEnabled` | same key |
| **Feature** | `metadata.publishingEnabled` | `metadata.autoReplyMode != 'off'` |
| **Platform** | `metadata.replyPolicies[p].publishingEnabled` | `metadata.replyPolicies[p].autoReplyEnabled` |

Where the same levels appear on the **API**, which is deliberately not a mirror
of storage — the two per-platform maps are split by feature so neither endpoint
can write the other's keys:

| Level | Scheduled publishing | Managed replies |
| --- | --- | --- |
| **Master** | `enabled` | same field |
| **Feature** | `publishing.enabled` | `replies.autoReplyMode != 'off'` |
| **Platform** | `publishing.platforms[p].enabled` | `replies.platforms[p].autoReplyEnabled` |

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
publishing feature switch: it is stored independently of the platform list, so
switching it off keeps the selection instead of clearing it — which is why it
cannot be "is any platform on".

**Scanning is deliberately not gated.** `EngageConfig.enabled` remains the Engage
feature's own switch and still governs discovery. Turning Automation off stops
replying, not finding — so conversations keep accumulating and are there to act
on the moment it comes back. Gate scanning too by adding `automationEnabled` to
the scan queries, if that is ever wanted.

`GET /automation` transmits only the switches themselves, never the AND of them —
see [What the client derives rather than receives](#what-the-client-derives-rather-than-receives).

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

**Reply accounts.** Automation never picks an account: it sends through the
extension's own browser session, so the identity is whoever the user is already
signed in as. Choosing a specific account is a per-post edit, on a different
surface. The endpoints therefore neither return the connected accounts nor accept
per-account authorization — writing `IntegrationProject.engageEnabled` from here
meant a managed-reply save reached into an Engage setting that no gate anywhere
reads (the reply driver does not filter on it, and `pickXReplyIntegration`
matches by handle and ignores it).

**The new-conversation count.** It counts opportunities discovered by scanning,
which the Automation switches do not govern, so it belongs on the Engage surface
next to the conversations themselves — not on a page about switches and
schedules.

---

## GET /projects/:projectId/automation

Everything the Automation page renders, in one call. It replaced five separate
requests — two of them serialized, because the plan id had to come back before
the plan detail could be fetched — and two of those five turned out not to belong
on this page at all (the reply-account list and the new-conversation count are
Engage's, see [What Automation does NOT touch](#what-automation-does-not-touch)).

Deliberately **not** built out of the endpoints it replaced:

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

  // The active plan's send-queue rollup; zeroed when the project has no active
  // plan (READY, startsAt <= now <= endsAt). Flat and always present — a client
  // asking "how many posts are waiting" should not have to unwrap a nullable
  // object to learn the answer is none.
  //
  // The plan's ID is deliberately NOT returned. The client never names a plan
  // anywhere — the commit route resolves the project's active one server-side —
  // so handing the id out would only invite a caller to start passing it again,
  // which is exactly what let a sibling project's plan be activated before.
  "queue": {
    "totalPosts": 12,      // still-DRAFT roots whose publish time is still ahead
    "readyPosts": 10,      // have a body AND a resolved platform
    "attentionPosts": 2,   // totalPosts - readyPosts
    "platforms": ["x", "reddit"]
  },

  "publishing": {
    // The feature switch, on its own. `active` is NOT sent: it is just
    // `enabled && this`, and a value the client can compute is one that can
    // disagree with a server-sent copy of itself.
    "enabled": true,

    // The zone every window below is in, unless that window overrides it.
    // Hoisted because the project writes ONE zone for all its platforms (the
    // browser's), so repeating it per platform was the same string N times.
    // Absent when the windows genuinely disagree — an admin can pin a different
    // zone per platform, and a window with NO zone means UTC, which does not
    // agree with a sibling that names one.
    "timezone": "Asia/Taipei",

    // ONE entry per platform, carrying both halves of that platform's state.
    // Previously a `platforms` array beside a parallel `windows` map, which the
    // client had to cross-reference — and the array was a lossy projection of
    // the same information.
    //
    // `enabled` ABSENT = the project has never decided for this platform. A
    // platform can appear with only a `window` when an admin restricted it and
    // the project never touched it — that window has to stay visible, or the UI
    // would show its own default hours for a platform that is actually capped.
    "platforms": {
      "x":        { "enabled": true,  "window": { "start": "09:00", "end": "18:00" } },
      "reddit":   { "enabled": true,  "window": { "start": "07:00", "end": "12:00" } },
      "linkedin": { "enabled": false, "window": { "start": "09:00", "end": "18:00" } }
    }
  },

  "replies": {
    // Engage's OWN switch. It also gates scanning, is changeable from the Engage
    // page, and independently gates replying: with it off nothing is driven
    // whatever the mode says — so a client that only knew the mode could not
    // explain why replies are idle.
    "enabled": true,

    // Carries the feature switch AND the review/auto distinction, so a separate
    // `repliesEnabled` boolean would just restate `!== "off"`.
    "autoReplyMode": "off" | "review" | "auto",

    // ONE entry per platform: that platform's reply policy.
    //
    // Connected reply ACCOUNTS are deliberately absent. Automation never picks
    // an account — it sends through the extension's own browser session, so the
    // identity is whoever the user is already signed in as. Choosing a specific
    // account is a per-post edit, on a different surface.
    "platforms": {
      "x": { "autoReplyEnabled": true, "length": "short", "checkIntervalMinutes": 480 },
      "reddit": { "autoReplyEnabled": true, "length": "medium" }
    }
  }
}
```

### Telling "never configured" from "everything off"

`publishing.platforms` carries this per platform rather than in a separate flag:
an entry's `enabled` is **absent** until the project decides about that platform.
The two readings are opposite, so they must stay distinguishable:

| | meaning | effect on a commit |
| --- | --- | --- |
| no entry has `enabled` | never chose platforms | **unconstrained** — every platform the plan has |
| entries exist, all `false` | every platform deliberately off | queues **nothing** |

Collapsing them would either silently stop publishing for every project that
predates this setting, or silently ignore a user turning every platform off.

### What the client derives rather than receives

Three values are deliberately not transmitted, because each is computable from
what is — and a duplicated value is one that can disagree with itself:

| Derived | From |
| --- | --- |
| is publishing actually running | `enabled && publishing.enabled` |
| is replying actually running | `enabled && replies.autoReplyMode !== "off"` |
| the managed-replies feature switch | `replies.autoReplyMode !== "off"` |

Render the switch CONTROLS from each feature's own `enabled` / `autoReplyMode`,
and status, counts and "will this run" from the derived values. Driving the
controls off the derived value makes both snap to off the moment the master goes
off, which reads as "your settings were cleared" rather than "suspended".

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

Save the managed-reply half: the config flags and the per-platform reply policy.

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
  }
}
```

- **Response**: `{ "saved": true }`

Per-ACCOUNT authorization is deliberately not accepted. Automation never picks an
account — it sends through the extension's own browser session, so the identity
is whoever the user is signed in as; choosing a specific account is a per-post
edit on a different surface. The flag such a payload would write
(`IntegrationProject.engageEnabled`) is an Engage setting no gate anywhere reads,
and it stays on the Engage surface, which has a UI for it.

Publishing keys (`publishingEnabled`, `publishingWindowStart`,
`publishingWindowEnd`, `publishingTimezone`) sent here are **dropped**: they are
the publishing endpoint's to change. Conversely, the publishing endpoint
preserves every reply-side key. Both halves currently share
`EngageConfig.replyPolicies`, so each writer merges rather than replaces —
splitting that column is tracked separately.

Config flags **do** go through `EngageService.saveConfig`, so enabling Engage
still starts its workflows and triggers an immediate scan, exactly as
`POST /engage/config` does.
