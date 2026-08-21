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
| **Feature** | `metadata.publishingEnabled` | `metadata.autoReplyEnabled` |
| **Platform** | `metadata.replyPolicies[p].publishingEnabled` | `metadata.replyPolicies[p].autoReplyEnabled` |

Where the same levels appear on the **API**, which is deliberately not a mirror
of storage — the two per-platform maps are split by feature so neither endpoint
can write the other's keys:

| Level | Scheduled publishing | Managed replies |
| --- | --- | --- |
| **Master** | `enabled` | same field |
| **Feature** | `publishing.enabled` | `replies.autoReplyEnabled` |
| **Platform** | `publishing.platforms[p].enabled` | `replies.platforms[p].autoReplyEnabled` |

Managed replies depend on one more switch that publishing has no equivalent of:
`EngageConfig.enabled`, which governs post **discovery**. It is reported as
`replies.scanEnabled` but is **not** an Automation control — see below.

### Scanning is turned on WITH replying, never off with it

Discovery belongs to the Engage page. The Automation page neither shows it nor
accepts it: `POST /automation/replies` has no `scanEnabled` field, and a body
carrying one is ignored as an unrecognised property.

Instead the coupling is **one-way and implicit**:

| The save | What happens to scanning |
| --- | --- |
| replying switched **on** (`autoReplyEnabled: true`, or a mode sent alone) | switched **on** with it |
| replying switched **off** | **untouched** |
| policies-only save | **untouched** |

**On, because replying with scanning off is not a configuration, it is a dead
end.** A reply answers an opportunity Engage found; with nothing found, nothing
is drafted, and the page shows a switch that is on and permanently idle carrying
no control that explains why. Two toggles for what a user experiences as one
decision is the confusion this removes — and doing it in the service rather than
asking the client to send both means the client cannot forget.

**Off never propagates, because discovery is not Automation's to stop.** Emptying
the Engage page as a side effect of a decision made on the Automation page is the
inverse of the same confusion, and it matches the rule the chain already states:
turning Automation off stops replying, not finding, so conversations keep
accumulating and are there the moment it comes back.

`replies.scanEnabled` is still transmitted for **diagnosis**, because the one
state this page cannot cause — the Engage page switching scanning off under an
active reply config — is otherwise unexplainable here: replies would read as on
and sit idle. Render it as status if at all, never as a toggle.

**Every switch defaults to OFF when absent.** Automation posts and replies with
the user's real accounts, so a missing — or malformed — value must never read as
authorized; this matches `enabled` and `autoReplyEnabled`, which have always
defaulted off for the same reason.

Nothing grandfathers a project in, either: configuring replies or picking
platforms is not the same as authorizing them to run. Every project starts with
Automation off and someone turns it on.

`publishingEnabled` is the one genuine three-state — absent means "never chosen",
which resolves from the platform selection, and that is distinct from an explicit
`false`. It is not a permission default: the master switch above it still has to
be on for anything to publish.

### There is no reply MODE

`metadata.autoReplyEnabled` is a plain boolean. It replaced a tri-state
`autoReplyMode` (`off | review | auto`) whose middle value meant "draft it and
park it for a human to send".

That mode is retired, for two reasons that pointed the same way. Managed replying
has **one** behaviour — the backend drafts, the extension sends — so `review`
described a product step that does not exist. And no client ever wrote anything
else: the Automation page sent `enabled ? "review" : "off"`, which is a boolean
spelled as an enum, next to an `enabled` field that already said the same thing.

**Stored rows are read, not migrated.** A row written before the switch still
carries `autoReplyMode`, and `readEngageConfigMetadata` reads `review` or `auto`
as `true`, anything else as `false`. The first write of any kind replaces the
whole blob and the old key disappears. Reading a stale `review` as `false` would
have silently switched off every project not touched since.

One place the retired name survives on the wire: `POST /api/engage/reply-due`
still returns a constant `"mode": "auto"` on every item. The extension no longer
reads it, but older builds do — and the extension updates on Chrome's schedule in
browsers nobody controls, so the backend cannot drop a field a deployed client
might still gate on. See
[the retirement order](engage/api.md#post-apiengagereply-due).

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

Deliberately **not** built out of the endpoints it replaced: the engage side
reads the bare config row rather than the fully decorated `GET /engage/config`,
which resolves entitlements plus a scan cursor per keyword, channel and tracked
account — none of it shown here.

It says nothing about the operation plan either — not its id, not a rollup of its
posts. The client never names a plan (the commit route resolves the project's
active one server-side), and the page has no number to show about one.

It is also strictly read-only: unlike `GET /engage/config`, loading this page
does **not** create an `EngageConfig` row for a project that has never used Engage.

- **Response**:

```jsonc
{
  "projectId": "<project-uuid>",

  // The Automation master switch.
  "enabled": true,

  // ISO timestamp of the last post this project actually published, or null if
  // it never has. Covers scheduled posts AND engage replies — both are Post
  // rows, and both are "something that went out"; scoping it to an operation
  // plan would make a project that only replies look like it had never acted.
  //
  // A real timestamp rather than a "checked N minutes ago": there is no polling
  // clock to report. The status banner used to show a hardcoded "Just now"
  // beside a hardcoded "In 24 min" countdown, neither of which measured
  // anything.
  "lastPublishedAt": "2026-08-19T07:30:00.000Z",

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
    // Engage's post-SCAN switch — whether this project keeps DISCOVERING
    // opportunities at all. READ-ONLY here: it belongs to the Engage page, and
    // POST /automation/replies has no field for it — switching replying on turns
    // it on. Render as status, never as a toggle. Present so that the one state
    // this page cannot cause (the Engage page switching scanning off under an
    // active reply config) is explainable instead of "on but idle".
    "scanEnabled": true,

    // The managed-reply switch.
    "autoReplyEnabled": false,

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
| is replying actually running | `enabled && replies.scanEnabled && replies.autoReplyEnabled` |
| the managed-replies feature switch | `replies.autoReplyEnabled` |

Render the switch CONTROLS from each feature's own `enabled` / `autoReplyEnabled`
(`scanEnabled` is status, not a control),
and status, counts and "will this run" from the derived values. Driving the
controls off the derived value makes both snap to off the moment the master goes
off, which reads as "your settings were cleared" rather than "suspended".

---

## POST /projects/:projectId/automation/enabled

The project's Automation master switch.

- **Body**: `{ "enabled": true | false }` — required. An empty body is a `400`
  rather than being read as "off".
- **Response**: `{ "saved": true, "enabled": false, "rescheduled": null }`

`rescheduled` reports the queued posts moved back inside their publish window by
the OFF→ON transition — `{ "moved": 2, "skipped": [{ "id": "…", "reason": "claimed" }] }`,
or `null` when no realignment ran (switching OFF, or publishing was already
running) or one failed. Only the QUEUE half is reported: a draft that moves has
no consequence the user needs to hear about, while a scheduled send that could
**not** be moved is a real exception to what they just asked for. See
[When the alignment runs](#when-the-alignment-runs).

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

- **Response**: `{ "saved": true, "scheduled": <schedule result> | null, "rescheduled": <realign result> | null }`

`rescheduled` carries the same shape as on the master-switch endpoint above.
Unlike there it runs on **every** save, because a window edit is exactly when a
realignment is due — and since both passes only touch posts that are outside
their window, a save that changed nothing relevant moves nothing.

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

The rule is the same everywhere it runs: if a `DRAFT` post's platform resolves to
a window and its `publishDate` falls outside that window (in the window's
timezone), a **new random instant inside the window** replaces it — re-picked,
never clamped to the nearest boundary, since the materialized time was only ever
the plan's generated default. A post already **inside** its window is never
touched. Applies group-wide: a thread's segments share one publish time.

A malformed project window is **dropped** and the admin tier stands, rather than
the window being cleared — a bad edit must never widen publishing past what an
admin allowed.

**Bounds are anchored to the wall clock, not to midnight-plus-N-minutes.** The
two are the same on 363 days a year and different on the two a DST zone is 23 or
25 hours long: midnight + 9h is `10:00` on a spring-forward day, and a window the
transition falls *inside* — say `01:00`–`05:00` — is three real hours that day and
five on the fall-back day, not the four its bounds suggest. Each occurrence
therefore resolves its own opening instant and its own real duration, so
`09:00`–`18:00` means those hours every day of the year, which is the entire
point of expressing a window in local time. (Before this, a post could be placed
at `05:59` local in a window that closed at `05:00`.)

#### When the alignment runs

Three times, and all three are needed — none of them subsumes another:

| When | Scope | Why it cannot be dropped |
| --- | --- | --- |
| **Plan generation** (`POST /projects/:projectId/operation-plans`) | that plan's DRAFTs | Without it the calendar shows the generator's own times, which then silently change at commit. What the user sees should be when the post goes out. Generation never touches QUEUE — committing a post is a decision it has no business revisiting. |
| **Saving publishing settings** (this endpoint) and the master switch going **OFF→ON** | the project's DRAFTs, then its QUEUE | The window that matters is the one that exists *now*; a window edited after generation has to reach the posts already scheduled. DRAFTs first, because the QUEUE pass measures its gap against them — spacing against a draft that is itself about to move is spacing against a slot nobody uses. |
| **Commit** (`commit: true`) | the committed slice | Last line of defence — the window may have changed since the save, and this is the point of no return. |

Running it more than once is safe **because only out-of-window posts move**: the
second pass finds everything already compliant and does nothing. That same
property is why a user who dragged a post to a different time inside the window
keeps that time.

The generation and settings passes are **best-effort** — neither generating a
plan nor saving settings fails because the schedule could not be tidied — and
both are gated on the same `enabled && publishing.enabled` chain as the commit.

Both passes read `DRAFT` **and** `QUEUE` even though each moves only one of
them: a post the other pass owns still occupies a slot in the same window, and a
placement blind to it would drop a post right on top of one. The posts a pass
does not own are pinned — they hold their slot and the minimum gap is measured
against them.

**A post is never moved backwards across the clock.** The window is anchored to
the post's own local day, so committing at 19:00 a post dated 22:00 tonight
against a `09:00`–`18:00` window offers a time *this morning* — and a `QUEUE`
post dated in the past publishes on the spot, which is the opposite of what a
window is for. Such a post keeps its own time (out-of-window is bad;
published-right-now is worse) and the alignment passes report it as
`window-passed`. All three passes apply this, the commit included, so they cannot
disagree about it.

#### Rescheduling posts that are already queued

Moving a `QUEUE` post is a different operation, not a different filter, and it
has its own method (`rescheduleQueuedPlanPosts`).

A queued post's publish time is not a column you can move. An API post's Temporal
workflow read its `publishDate` when it started, sleeps until then, and
**returns** on waking to find the date changed — so a bare `UPDATE` strands it in
`QUEUE` until the stale sweep turns it into an unexplained `ERROR`. Moving one
means writing the date **and** terminating + restarting its workflow, behind the
same two gates [`changeDate`](../libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts)
uses:

| Gate | Skipped as | Why |
| --- | --- | --- |
| `releaseId` starts with `claim_` | `claimed` | A workflow may already be inside `postSocial`, and terminating it cannot cancel an in-flight HTTP call — a new workflow would publish a **second copy**. |
| less than 30s to `publishDate` | `imminent` | The workflow may no longer be sleeping, which is what makes `terminate()` clean. A past-due post falls here too. |
| the new time would be in the past | `window-passed` | See above. |
| the workflow restart threw | `workflow-failed` | The date is written and the old timer is gone, so the post has **no timer** and must be rescheduled. Not reverted — a revert can fail too — but named loudly and sent to Sentry. |

Both gates **skip** rather than fail: this runs as a follow-up to saving
settings, where "one of eleven posts is publishing right now" is a normal state
of the world, not an error the save should surface as a failure. Every skip is
returned so the caller can say what was left alone — the two write endpoints
carry it back as `rescheduled`.

Moves are applied **serially**, because each one terminates and restarts a
Temporal workflow and a burst of those is the load pattern that makes
`terminate()` race the timer it is trying to beat.

Extension-published posts take the same path: `startWorkflow` recognises them and
returns without touching Temporal, and the extension's publish-due query is
`publishDate <= now`, so the row change is all they need. The gates still apply —
a post inside its lockout is one the extension may already be publishing.

#### Minimum gap between posts

`extension_publish.min_gap` — `{ default: 30, platforms: { <platform>: 45 } }`,
in minutes, resolved platform override → global default → built-in **30**.

The window says *when* a project may publish; this says how close together two of
its posts may land. Without it the window pass was per-post and blind: two posts
re-picked independently could land in the same minute, which on a narrow window
was likely rather than unlucky. Posts are therefore allocated per **window
instance** (one platform, one occurrence of the window) so each placement can see
its siblings.

The default is deliberately generous. It is a **target, not a constraint** — see
the degradation below — so a wide window is the only place it has any effect, and
that is exactly where a small value would let three posts pile into five minutes
of a nine-hour window with nothing to pull them apart. For reference the engage
reply driver's own gap is 25 minutes, and an original post is a higher-risk action
than a reply.

Two things it does **not** do:

- **It never widens the window.** When the window cannot hold its posts at the
  configured gap, the gap degrades — full gap → an even `span/(n+1)` share → none
  — and the shortfall is logged with the window and the gap actually applied.
  Overflowing the window is the precise thing this mechanism exists to prevent,
  so it is never traded for spacing. A window too narrow for its posts is a
  configuration problem, and saying so beats quietly producing a schedule nobody
  asked for.
- **It does not retrofit onto compliant posts.** The gap is enforced against the
  posts being *placed*. Two posts already sitting one minute apart *inside* the
  window stay one minute apart — moving them would mean re-rolling in-window
  times, which is what makes every save shuffle a schedule that was fine.

Not to be confused with `extension_publish.segment_gap`, which is the
**seconds**-scale pause between the segments of one thread. That is what a real
thread looks like; different posts are not a thread.

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
  // The managed-reply switch, and the ONLY switch this endpoint accepts. Sent
  // as `true` it also turns Engage's post scanning on.
  "autoReplyEnabled": true,

  // Merged key-by-key over what is stored, per platform.
  "policies": {
    "x": { "autoReplyEnabled": true, "length": "short", "mentionTags": ["@acme"] }
  }
}
```

Two switches deliberately have **no field** here, and a body carrying either is
ignored as an unrecognised property:

- **`scanEnabled`** — Engage's scan switch is the Engage page's. This endpoint
  turns it on implicitly when replying goes on, never off when replying goes off.
- **`autoReplyMode`** — retired entirely. Managed replying has one behaviour, so
  the switch above is the whole answer. See
  [There is no reply MODE](#there-is-no-reply-mode).

`autoReplyEnabled` and `policies[p].autoReplyEnabled` are two levels of the same
chain, not two names for one switch — see
[the switch chain](#the-switch-chain). A save changes only the levels it names;
turning replying off never rewrites the per-platform selection, or turning it
back on would restore an empty form instead of the configuration that was there.

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

Config flags **do** go through `EngageService.saveConfig`, so switching replying
on — which switches scanning on with it — also starts Engage's workflows and
triggers an immediate scan, exactly as `POST /engage/config` does. That is the
point: the opportunities a newly enabled reply config needs start arriving at
once rather than at the next scheduled scan.

`POST /engage/config` takes the same switch under the name `autoReplyEnabled`,
and still refuses it without a `projectId` — the driver only reads project-scoped
configs, so a switch set on the legacy null-project row would be inert.
