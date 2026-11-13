# Multi-node Sending API Responsibilities and Documentation Ownership

Updated: 2026-10-20. This index supports integration across the backend, extension, and platform administration app. It distinguishes APIs that aisee-app must integrate from other implemented APIs. It does not change any interface or permission.

## Documentation Locations

| Document | Audience and maintained content |
| --- | --- |
| [Single-node and multi-node sending upgrade overview](multi-node-sending-before-after.md) | Before-and-after comparisons across the three repositories, cross-repository calls, flowcharts, sequence diagrams, and deployment order |
| [aisee-app frontend integration guide](../../aisee-app/docs/aisee-app-multi-node-integration.md) | Page changes, call order, code entry points, and acceptance criteria |
| [aisee-app frontend API reference](../../aisee-app/docs/aisee-app-multi-node-integration-reference.md) | Actual frontend business calls, field sources, and response handling; not the complete backend protocol |
| [Organization sending modes](organization-sending-modes.md) | System capability, organization state machine, transition safeguards, platform-write receipts, and exception handling |
| [Account and node design](project-account-extension-node-binding-design.md) | Account binding, node and execution protocols, concurrency, permits, quotas, and storage design |
| [Optional account selection policy](project-account-optional-identity-implementation.md) | REQUIRED/OPTIONAL, first-claim binding, and server-side safeguards |
| [Administration page](../../aisee-manage/app/pages/post/config/sending/index.tsx) | Display and modification of the system capability switch and account selection policy |

The two frontend integration documents remain in `aisee-app/docs` and focus on frontend delivery. Backend design stays in its owning repository; frontend developers should not have to infer the current call order from historical protocols.

## Integration Responsibilities

| API or capability | Primary caller in this release | Additional aisee-app integration required? |
| --- | --- | --- |
| Project sending-context | aisee-app | Yes. Unified initialization already aggregates the mode, preselection policy, accounts, reported nodes, and defaults |
| Project sending-accounts/save | aisee-app | Yes. Saves Project defaults without requiring a client-supplied revision field |
| Existing Post / Engage business APIs, saved-content enqueue, business status, and retry | aisee-app | Adapt existing entry points while preserving the original record identity; see the frontend reference |
| GET/POST /sending/mode | aisee-app organization settings and extension Options | Required for organization settings. This is not a platform super-admin API, and each editor does not need to query it separately |
| GET/POST/PUT /admin/settings/sending.account_bound_enabled | aisee-manage | No. System capability switch requiring platform super-admin permissions |
| GET/POST/PUT /admin/settings/sending.account_selection_policy | aisee-manage | No. System REQUIRED/OPTIONAL policy, separate from the organization's autonomous/controlled mode |
| /extension/send-protocol | Extension | Not required for new frontend initialization; no longer a prerequisite before sending-context |
| /user/send-preferences | Existing personal-policy clients and backend aggregation | No new personal-settings UI in this release. Project context already returns the effective preselection requirement |
| GET /projects/:id/sending-accounts and organization sending-accounts | Compatibility clients and standalone default-configuration clients | Project pages use context in this release; organization-wide default-account UI remains deferred |
| GET /integrations/list, Project account lists, and reply-accounts queries | Existing account-management and compatibility clients | Preserve their existing uses; new selectors do not need to assemble these GET responses again |
| Project account association and reply-permission updates | Existing authorization flows | Preserve explicit user authorization; selectors do not grant permissions automatically |
| /extension/nodes registration, credential verification, and node-session reporting | Extension and its diagnostic/node-management clients | Not part of this frontend integration. Account lists use context terminals; the Web app does not generate node identities or transmit node credentials |
| /extension/send-attempts claim/renew/draft-exposure/preflight/start/outcome and related operations | Extension executor | No. Enqueuing business content from the Web app does not grant permission to write to a platform |
| General /sending/executions queries and reconciliation | Operations tools with the required permissions | General execution inspection remains privileged. The scoped attended post-review exception below exposes no execution credentials |
| /sending/mode/autonomous-effects and resolve | Organization-admin exception-handling tools | Outside the current frontend scope; mode settings do not implicitly add a manual reconciliation UI |

“Not part of this integration” does not remove existing functionality or change permissions. The table classifies integration responsibilities; controllers and services remain authoritative for authorization.

## Safety Information Retained by the Frontend

Requirements differ by API. Enqueuing a saved Reply needs only `sentReplyId` and optional `integrationId`. The backend prevents duplicates using the original draft/task and uses the content currently stored on the server for the first enqueue; the frontend does not supply a revision or request identifier. Post creation, Project default saves, and mode saves still carry identifiers or revisions automatically according to their own contracts. Do not remove those fields globally or add them indiscriminately to every request. The frontend preserves original record IDs and business `allowedActions`, distinguishes request retries from another send attempt, and never creates new content to bypass an outcome awaiting confirmation.

## Documentation Corrections

- Replace the old frontend flow of “read the extension protocol, then query accounts, policy, and defaults separately” with Project context as the unified entry point.
- Keep page-level tasks in the frontend guide and actual business requests with field-by-field explanations in the API reference.
- Keep system configuration, node registration, execution, and reconciliation outside aisee-app development responsibilities.
- Preserve organization-admin mode settings and existing account authorization, manual-send confirmation, automation, and autonomous sending. Consolidating documentation does not change functionality.
- Treat legacy `planId` adaptation in existing plan submissions as business compatibility, not as a dependency of the new multi-node protocol.


## Attended recovery of an unsent post

The standalone extension can offer **Review result** for an original uncertain single-post attempt. `GET /sending/executions/:id/posts/:rootPostId/review` returns only eligibility, the current resolution revision, and the target account. `POST /sending/executions/:id/posts/:rootPostId/review-not-sent` accepts an `eventId`, that revision, and explicit `reviewedNotSent: true` and `draftsClosed: true` acknowledgments. The reviewer must inspect the target account and close all original platform drafts before confirming non-submission. A filled composer or an expired lease alone is not proof of non-submission.

This is a narrow attended exception to general execution reconciliation. Only an active organization member who originally owned the intent policy or registered its executor node may use it, with project ownership checked. Both endpoints require the original EXTENSION POST, exactly one matching root payload and segment, matching intent/execution/content/route/fencing scope, no confirmed segment in the intent history, an expired execution lease and either expired submit permission or a persisted pre-permit exposed/unknown draft with no permit fields, and no newer account writer. Unsupported threads and partial publications retain administrator review. The general execution inspection and reconciliation endpoints retain their superadministrator requirement.

The write rechecks all conditions in the existing serializable send transaction, records an audited `definitely_not_submitted` outcome in the original ledger, settles held quota, and increments the resolution revision. Stable event receipts make acknowledgment retries idempotent while preventing them from resetting a later retry. No platform write or requeue occurs. Only the existing, separately checked `POST /posts/:rootPostId/retry` queues another attempt.

Design scope: this addresses a user who verified that an older filled composer was never submitted. It reuses SendOutcomeEvent, the existing quota/account settlement, and the existing retry endpoint, with bounded single-attempt reads and an indexed confirmed-history count. It adds no schema, independent recovery queue, expiry-based permission, or change to existing API contracts. Existing clients remain compatible; the new optional extension flow requires a backend with these routes. A future change to thread recovery requires separate evidence for each segment.


## Explicit Post now on an idle controlled queue

`POST /posts/schedule` accepts an explicit per-post `date` together with `expectedRouteRevision` and `expectedContentRevision` when an original controlled EXTENSION POST is already QUEUED. This updates the original root/thread schedule under the existing serializable send transaction. It does not edit content, replace the intent, claim work, allocate quota, or bypass pacing. Only an idle QUEUED intent with no active writer, uncertain or confirmed history, or legacy occupancy can be rescheduled. Reserved, sending, reconciling, or published work is rejected. The business summary exposes `allowedActions.reschedule` only for that idle queue; plain enqueue replays continue to retain their original date.

After a successful explicit Post now or retry, the aisee-app page wakes the standalone extension with the existing `aisee:post-publish` event and optional accepted `postIds`. These identifiers allow the extension to display the backend queue before an execution receipt exists. They provide no content or sending authority; claims still use the backend's original frozen task, target, schedule, and normal authorization.


## Durable X draft exposure

For older clients without NATIVE_FLOW_V1, before opening a controlled X post or reply composer the executor records local draft exposure and obtains
`POST /extension/send-attempts/:id/segments/:index/draft-exposure`. The authenticated
original node and lease are required. The acknowledgment persists the existing
PENDING segment result as `draft_exposed`, keeps the execution and intent SENDING,
and retains account occupancy without allocating a submit permit or quota. An
expired exposed draft cannot be reclaimed or renewed into another sender for the
same content. Account occupancy is separate: after lease, the existing 30-minute
preparation deadline and all permits expire, a fenced release retains the original
content as UNKNOWN/RECONCILING while independent tasks wait through account pacing.
The preparation gap is captured by the existing policy read at exposure. A missing
acknowledgment prevents the browser from opening the draft. Content/media validation
and downloads run before exposure; opening X is already an exposure boundary because
it can restore a draft before injection. Deploy this backend endpoint before loading
a new executor that requires it. No new HTTP field or database migration is needed.

An older client renews the original execution before exposing a later X thread draft. NATIVE_FLOW_V1 instead checks and authorizes each segment before native work, with no renewal during that segment. Retained ownership, prior confirmation, account spacing, and the original
thirty-minute preparation cap remain enforced. An already exposed draft with an
expired lease requires attended review instead of renewal. Original-node
pre-permit UNKNOWN reports retain reconciliation; stale-owner reports preserve
their evidence and quarantine competing owners. Single original posts can use
attended absence review after the lease expires, including a browser crash before
any outcome report. Replies and partial threads retain administrator resolution.


## Explicit owner-requested retry of an uncertain post

The extension can offer one-click **Retry** for an expired original Post
attempt, including a thread with zero confirmed segments. The scoped `GET /sending/executions/:id/posts/:rootPostId/review` adds
`canRetryUnconfirmed` alongside `expectedResolutionRevision`. This admission flag
requires controlled sending, an active project, a ready account, the original
owner scope, settled execution and submit deadlines, and no confirmed or newer
writer. It does not assert that the first attempt was unsent.

This is an automatic eligibility decision, not a human approval or confirmation
stage in the backend. The user initiates Retry in the extension. Medium is not
excluded: the extension checks its live account and any matching publication,
then uses this same endpoint if no confirmed publication was found. A positive
local Medium receipt blocks requeue even if its report never reaches the backend;
the extension requests result synchronization instead of trusting stale eligibility.

The service validates every ordered post and segment against the frozen payload,
content hashes, integration and route/content revisions. Any current or historical
confirmed segment, release evidence, live permit, changed chain or competing
writer blocks a whole-post retry. Untouched trailing PENDING segments are allowed
only without authorization or result evidence; at least one stopped uncertain or
exposed segment must remain. Reply retry and legacy absence review remain
single-segment operations. The old absence-review response reports
`canReviewNotSent:false` for threads, without blocking `canRetryUnconfirmed`.

`POST /sending/executions/:id/posts/:rootPostId/retry` accepts only a stable
`requestId` and `expectedResolutionRevision`. It returns
`{sendIntentId,status:"QUEUED"}`. The serializable transaction retains the original
segment evidence and any HELD quota, archives its executor as `RETRY_REQUESTED`,
advances fencing and resolution revisions, releases only its account ownership,
and queues the same original intent. A SendMutationReceipt audits the requesting
member and makes transport retries idempotent, including after a newer claim.
No absence acknowledgments, negative outcome, content copy, or quota release are
implied. A later Medium claim uses the existing authenticated executor-status
read to observe the original RETRY_REQUESTED status before native operation,
and checks a higher fence and the same frozen account/content scope. It preserves
the original local UNKNOWN journal. No new request field or schema is needed.
Deploy this backend change before the extension; older servers retain their
single-post eligibility limits and cannot admit uncertain thread retries.
New authorization still enforces all ordinary account and quota checks.

Business status follows the current attempt; explicitly superseded uncertainty
remains in history and quota accounting. Any new late positive or uncertain
receipt from the superseded executor preserves its evidence and quarantines the
old and current writers. A confirmed late receipt commits the original held
quota. A stale negative receipt cannot reset a newer intent. Existing general
administrator reconciliation permissions remain unchanged.

Backend fencing blocks further automated authorization for the old executor.
It cannot disable a submit button already rendered by X or prevent a human from
submitting an old draft on another device. The extension should close original
local compose tabs before requesting another attempt when they are available;
late evidence remains a reconciliation event rather than proof of non-submission.


## Shared account pacing admission

Controlled claim discovery, X draft exposure, queued business timing, and final
submit authorization use the same account lower bound: the later of persisted
`nextWriteNotBefore` and `lastConfirmedAt + current operation gap`. The existing
POST minimum from `extension_publish.min_gap` and platform write floor remain
unchanged. The backend resolves deterministic minimums; it does not redraw a
random gap at authorization.

For example, a previous REPLY can persist a three-minute interval while the
following POST requires thirty minutes. Expiry of the previous three-minute
clock alone does not make that POST eligible. Claim stays queued and the public
timing projection reports the thirty-minute bound before a composer opens. A
policy increase after reservation is rechecked at draft exposure, and the final
permit still rechecks policy, quotas, identity, account ownership, and deadlines
atomically. Timing projections allocate no quota and are not send permits.


## Seven-platform browser parity and diagnosis (2026-11-11)

The native baseline comparison and per-platform corrections are documented in
[`aisee-browser-extension/docs/account-bound-send-protocol.md`](../../aisee-browser-extension/docs/account-bound-send-protocol.md#seven-platform-native-flow-comparison-with-1209-2026-11-11).
LinkedIn comment-scope and stable profile-photo handling are browser-side fixes;
they add no API request or sending step. Final account, content, cookie, permit
and one-shot checks remain authoritative. A true local input rejection before any
tab or write settles NOT_SUBMITTED; missing or ambiguous post-dispatch evidence
continues to require reconciliation. These browser compatibility fixes do not
change CONTROLLED account binding or AUTONOMOUS current-session handover.

The existing read-only diagnosis script now accepts explicit platform and action
selectors. For example, run in the deployed backend checkout:

```sh
pnpm exec ts-node --project scripts/tsconfig.json scripts/diagnose-send-attempts.ts --user USER_ID --platform linkedin --action REPLY --details --limit 100
```

Use `--platform all --action all` to inspect both actions across all seven
platforms. For compatibility, a user scan without those selectors still defaults
to Dev.to replies. `--reply` always retains reply scope; `--organization`,
`--attempt`, pagination and output limits remain available. Output summarizes
stored stage/error codes rather than tokens, content or raw platform evidence.
The script does not repair or resend anything. Its help and mocked-query tests do
not connect to a database; an operator must verify the deployment database before
running a live diagnosis. A manually submitted comment needs positive verification
against its original record, not another send.


## Front-loaded native execution contract: NATIVE_FLOW_V1 (2026-11-12)

This user-approved contract supersedes the earlier controlled ordering of filling
first, then calling backend preflight/start. Implementation and the permitted joint regression suites are complete; live platform publication acceptance remains outstanding. The reference native flow is the actual 1.20.9 sibling checkout.

1. Before the native operation, recover old receipts, check the original business
   identity, negotiate ownership, and atomically claim the original task. Validate
   content/media and fetch assets before authorization where possible. Prepare an
   empty native composer, select its intended persona and identify its own author
   without filling or attaching content. X authorizes before opening a composer
   because opening it can restore an existing human-sendable draft.
2. Complete fresh backend preflight and actor reporting, then call the existing
   segment start route with `authorizationMode: NATIVE_FLOW_V1`. Existing frozen
   actor, project/organization membership, revision, fencing, pacing and quota
   checks remain. LinkedIn company sends still require live COMPOSER evidence for
   the organization identity; a controlling personal account is not sufficient.
3. The acknowledged grant must echo `authorizationMode: NATIVE_FLOW_V1` and
   `executionDeadline`, equal to `submitBefore`. Its deadline is bounded by ten
   minutes from authorization, the original thirty-minute preparation cap and the
   applicable quota-window ends. The execution lease covers that same native
   window without renewal. An absent or mismatched echo must stop the new client
   before any native content mutation; it must not silently fall back to the old
   after-fill backend round trip. Old clients and API executors retain their
   existing short-permit behavior when the mode is omitted.
4. Persist and verify the grant in the local journal before allowing native work.
   `beforePrepare` performs the front-loaded server exchanges. After it returns,
   all backend interaction by the send path is deferred until the native operation
   returns a result or stops. In particular, there is no AIsee preflight, identity
   report, start, lease renewal or auth-token refresh between fill and submission.
   For the new mode an AUTHORIZED segment already protects possible draft
   exposure, so no separate X draft-exposure backend request is sent after start.
5. The legacy-named `beforeSubmit` callback is local admission before native
   filling/upload. It checks the cached owner/browser identity and durably
   consumes the existing one-shot command. The original page writer checks its
   bounded capability synchronously at its native click, without a separate
   after-fill coordinator, backend request or identity-discovery request. Verified
   Medium preview/Quora no-composer navigation may bind only the remaining budget
   to the same-origin/session document, never renew it. Reddit retains its native
   platform request after consumption. This client correction changes no backend
   API, mode/account rules, quota, frequency limit or database schema.
6. After the native operation completes, persist its result and any platform ID/URL
   before reporting the original execution outcome. Lost report acknowledgments
   replay only the same report/event; never replay the platform submission. Missing
   URLs or ambiguous outcomes remain uncertain instead of being invented as failed.
7. Worker loss, lost grant acknowledgments and expired native windows never
   recreate a usable permit. Retain the original content and ledger, apply existing
   fenced reconciliation/account cooldown rules, and preserve late receipts without
   stealing newer occupancy. Authorization is not permission to repeat a send.
8. Each thread segment is an individual platform write. Backend checks may occur
   between completed segments, before the next native operation; none may interrupt
   a segment already executing. Website status/history shapes and original IDs are
   unchanged. AUTONOMOUS retains current-browser identity, pre-work admission and
   post-work outcome reporting; its in-work owner checks must not refresh AIsee auth.

Required regressions include zero AIsee calls/renewals/auth refresh during native
work, denied/unsupported authorization before fill, preserved old-client defaults,
long native preparation within the actual deadline, local owner/session/persona
changes and expired-command rejection, restart without replay, idempotent outcome
replay, account pacing/quota boundaries, and all seven platforms' Post/Reply paths.

### Native media, worker lifetime and user-facing errors

File attachments are downloaded before content mutation and before authorization where the platform permits it. Native URL embeds, such as non-cover Dev.to Markdown images, retain their original URLs and do not introduce a separate file-upload step. Native uploads and platform-side processing remain inside the platform operation. Requested media must reach the platform's completed-upload/readiness condition before publication; a local preview is insufficient. X, LinkedIn and Dev.to stop when their attachment preparation fails instead of continuing with missing images. A stop after a page can contain a draft is not proof of non-submission and must not set `neverSent` or trigger automatic replay.

LinkedIn prepares the empty own-author scope before authorization. The original author snapshot is retained through filling and image-driven editor remounts; read-only marker restoration on the new editor does not authorize a different persona. Non-author media toolbar links do not change that identity proof.

The extension uses `chrome.runtime.getPlatformInfo()` every twenty seconds only during active native work, stopping in `finally` or after ten minutes. This makes no network request and is not a backend lease renewal. Chrome documents that extension API calls reset the worker idle timer; bounded local activity reduces idle suspension but cannot guarantee survival across browser shutdown, OS sleep or every worker execution limit. See [Chrome service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) and [service-worker migration guidance](https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers). The journal remains authoritative after worker loss.

History, publish activity and compose results map internal sending codes to actionable English at presentation boundaries. Raw stored errors, evidence, allowedActions and state decisions remain unchanged. Unsupported server authorization asks the user to update the backend/extension before retrying; unknown results ask for status review rather than claiming that nothing was sent.

### Cross-mode maintenance and crash context

Native activity is shared by CONTROLLED and AUTONOMOUS so automatic recovery, queue polling, scan/reply maintenance and scheduled session/auth maintenance defer while native work is active. Deferral must preserve one-shot alarms and recurring cadence rather than dropping pending work. Explicit user sign-in/sign-out remains available, and local owner/session checks still reject changed identities. A scheduler alarm must not refresh the AIsee token or negotiate another sending mode before checking this boundary.

X opens its composer after front-loaded authorization and immediately binds the new tab to the existing authorized journal using local storage only, before filling. The stored tab identity survives worker restart; failure to persist it stops native filling. This is not another start request or proof of non-submission. Existing original-record retry/reconciliation rules remain unchanged; this change does not add automatic replay or redesign explicit reply retry cleanup.

### Joint verification and rollout

Fresh final verification on 2026-11-12:

| Repository | Passed | Failed | Skipped | Scope |
| --- | ---: | ---: | ---: | --- |
| Standalone extension | 4096 | 0 | 0 | Full suite, 214 test files |
| Backend | 5478 | 0 | 15 | Full permitted suite, 329 test files |
| Website | 482 | 0 | 5 | All existing Node, PM2 startup and Python tests, run serially |

Type checks passed for all three repositories. Backend excludes the frozen `apps/extension/**`, `billing-records.query.sql.spec.ts` and `engage-normalize-sql-parity.spec.ts`; no database operation was performed. Website serial execution avoids the previously observed fixed-delay Bing test contention; it does not omit that collection. Backend and website skips are existing test declarations.

Acceptance evidence includes `native-prepare-boundary.spec.ts` for all fourteen Post/Reply entry points, `runtime.spec.ts` for the no-backend native interval and per-thread-segment ordering, `runtime-platforms.spec.ts` for durable one-shot consumption, `native-alarms.spec.ts` and `scheduler-native-boundary.spec.ts` for maintenance deferral, and `native-worker-lifetime.spec.ts` for bounded local-only keepalive. The backend `send-execution.service.spec.ts` verifies old-client defaults, native deadline bounds, company evidence, expiry/late ownership fencing, and successful 180-second Post/Reply work across actual CONTROLLED-to-AUTONOMOUS handover with exactly-once quota settlement. Media regression cases reject incomplete uploads; Dev.to also rejects a failed requested cover download before opening a page.

Deploy the backend before repacking/reloading the extension. Older clients that omit native opt-in retain their old short-permit behavior. A new extension against an old or inconsistent server stops before filling instead of silently reverting to after-fill authorization. This change needs no schema migration and keeps original business IDs and outcome events. It does not automatically repair historical UNKNOWN records or claim that a closed page proves non-submission. No real social post/reply was submitted during this verification.


## Direct local database diagnosis (2026-11-12)

`diagnose-send-attempts.ts` runs locally against the configured PostgreSQL connection; it does not call the backend HTTP API. After validating `DATABASE_URL`, the script passes that exact URL as the Prisma datasource override. A generated client may contain an embedded test datasource, so its implicit default is not proof that the operator-selected remote database is used. The script performs bounded ORM reads only and never repairs, requeues or submits content. Initialization and query failures print safe Prisma error categories, including `errorCode` on initialization errors, without printing connection URLs, credentials or raw queries. Local TCP reachability and a client initialization failure can therefore describe different targets until this explicit override is applied. Verification: the repaired CLI completed a scoped read against the explicitly verified remote `aisee_postiz_dev` database. The focused diagnostic suite passed 36 tests; the full permitted backend suite passed 5483 tests with 0 failures and 15 existing skips. Frozen `apps/extension/**` and the two documented database-dependent test files remain excluded. The diagnostic script and tests passed their isolated TypeScript check. No business records were changed.

The extension's [Chrome verification record](../../aisee-browser-extension/docs/native-browser-verification-2026-11-12.md)
distinguishes a verified new LinkedIn Post from DOM-only checks and Medium's CDN
403 failure. Medium now waits for its empty article editor before requesting
backend preparation or consuming local permission; an absent editor settles via
the existing PREPARED/NOT_SUBMITTED stop-proof path. No backend source, endpoint,
quota or journal state contract changes are required for that readiness fix.
Historical UNKNOWN records remain subject to their existing recovery rules.


## Historical missing-receipt Engage writer

The existing privileged Post quarantine resource and local maintenance service
can retire one captured, claimed, nonrecurring Engage root with no related
receipts and a matching saved reply/project/platform. Their request contract is
unchanged: revision, original-executor stop, no pending submit and actual evidence
are required. The ordinary reply absence-recovery endpoint is not broadened.
Review includes credential-free Post fingerprints so a prepared plan cannot
silently adopt changed content or a changed private claim.

The operation preserves old evidence and marks the old Post soft-deleted
DRAFT/LEGACY_QUARANTINED; it does not mark it unsent, grant replay or modify quota.
Only its captured ownership is removed. Live legacy write predicates fence late
publication, failure, target and enrichment callbacks and draft edits; failed
publication updates stop before opportunity/billing side effects. Manual URL
backfill remains available for a live PUBLISHED ACCOUNT_BOUND reply whose same
organization/project/root REPLY intent is SUCCEEDED, has confirmed segments and
has no active execution. That metadata-only operation updates releaseURL without
changing platform ID, account/author, settings, state, intent, quota or permissions;
it cannot confirm, revive or resend content. Both modes retain old-content fencing
and normal new-content account/pacing/permit rules.
Backend deployment/restart must precede applying recovery; no migration is needed.
See `organization-sending-modes.md` for the scoped prepare/apply CLI.

## Account-only Post Now before sending authorization (2026-11-12)

An explicit website account choice is expected on a saved queued Post. The
previous zero-execution-only rule is replaced by evidence-based preauthorization
revocation. No two-minute timeout proves that content was not submitted.
`allowedActions.selectAccount` permits a safe account change; ordinary
`reschedule` remains false for RESERVED work. A RESERVED record exposes account
mutation only after selecting a different single account. Content/settings
changes and date-only edits retain their existing guards.

The existing `POST /posts/schedule` item accepts `type: "now"`, original `id`,
`expectedRouteRevision`, `expectedContentRevision`, selected `integrationId` and
stable `requestId`. The shared summary/mutation predicate requires the same
EXTENSION POST chain and matching revisions, no publication/claim markers or
confirmed/UNKNOWN/authorized/exposed segment. No-execution queues remain valid.
A RESERVED/EXPIRED extension preparation is revocable only if its original claim
persisted `authorizationMode: "NATIVE_FLOW_V1"`, never started, and retains its
complete matching PENDING segment set with no permit, authorization timestamp,
confirmation or result/exposure marker. Earlier safely canceled account-change
attempts remain auditable and do not prevent another preauthorization edit.
Other execution history retains its immutable account/recovery rules.

The serializable transaction rechecks membership, mode, active project, complete
chain/content, legacy protection and zero quota reservations for revoked work.
It validates the new account through the existing binding resolver, marks old
executions CANCELLED and pending segments NOT_SUBMITTED with an audited
`account_change_before_native` marker, clears only matching account occupancy,
and advances fencing plus route/intent revisions. Old account/target/payload,
lease authentication, preflight evidence, pacing clocks and quota history remain.
The same Post chain/SendIntent becomes QUEUED with the new target. There is no
new Post, intent, platform submission, quota refund or pacing reset. Mutation
receipts preserve prior routes and revoked IDs; lost-response replay does not
repeat the edit.

Targeted `/extension/send-attempts/claim` and both existing due adapters accept
optional claim `authorizationMode: "NATIVE_FLOW_V1"`. The execution stores that
contract at claim time. The standalone extension adds it only to newly persisted
pending requests; old durable requests retain their exact body/fingerprint.
Opted-in starts must use the same native mode and cannot call the old
preauthorization draft-exposure endpoint. Revoked claims cannot renew, preflight,
start or replay a claim into usable authority. Historical status/receipt access
remains authenticated by the original lease. Stale stop cannot fail the new
route. Late positive/UNKNOWN evidence is retained against the original actor
and quarantines the original business content/new owner for reconciliation.

The accepted schedule item echoes `integrationId` and `routeRevision`; the website
requires that acknowledgment before waking the extension or closing the editor.
Deploy all backend instances before updating the extension and website. Old
clients/old durable claims omit the contract and remain immutable after claim;
existing records are never retroactively opted in. No schema migration or
historical reset is required. CONTROLLED account verification, pacing, quota,
permits and journal rules remain; AUTONOMOUS current-browser identity, Reply
account immutability and mode handover semantics are unchanged. Tests do not
prove live publication.


### Reviewed preauthorization stop recovery (2026-11-12)

A native opted-in preparation can become FAILED_FINAL with Post ERROR after an
authenticated structured stop receipt before any authorization. The shared
summary/mutation predicate allows account selection only with complete matching
payload/segments, no execution start or permit/authorization/exposure/confirmation,
and validated no-pending-submit/no-permit stop evidence. The same proven stop
history remains eligible after explicit retry returns the intent to QUEUED or
creates a new native RESERVED preparation; every historical attempt is rechecked.
Generic failure, old
clients, ever-authorized history and UNKNOWN remain immutable. The transaction
preserves the original NOT_SUBMITTED stop result, cancels the old execution,
fences it, and restores the same chain/intent to QUEUED with the new account.
Pending continuation segments receive the ordinary account-change cancellation
marker; prior proof is never overwritten. Pacing, occupancy ownership and quota
checks remain unchanged. No new business record or automatic unknown replay.

Extension receipt recovery authenticates the old execution first. A settled
no-permit PREPARED journal may be acknowledged locally against authoritative
NOT_SUBMITTED/terminal-no-permit state. Manual actions skip only conclusively
obsolete canceled/expired manifests without unresolved local submission evidence.
After exact replay returns REPLAYED_EXECUTION_UNAVAILABLE for CANCELLED/EXPIRED,
an explicit action can persist at most one fresh claim for the current route;
other failure/UNKNOWN/authorization states do not grant replay. Website requires
the exact account/revision acknowledgment and distinguishes account selection
from frozen content/draft saving. Deploy backend before extension and website;
no schema migration or historical opt-in is introduced.
