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

After an eligible Post Now enters the queue, aisee-app can wake the local
extension using the existing `aisee:post-publish` event with accepted `postIds`.
For CONTROLLED, it checks the Automation Post default, the accepted root route
and the cached local actor. AUTONOMOUS keeps its eligible current-session path.
Other eligible nodes discover the task normally. The event can display the
original while it waits. The existing claim provides the frozen task, target,
schedule and sending authorization.


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

The initiating action is the user's Retry in the extension or Post Now on the
website. The extension checks the live Medium account and any matching publication,
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

`POST /sending/executions/:id/posts/:rootPostId/retry` accepts a stable
`requestId` and `expectedResolutionRevision`, with optional `type: "now"` for
website Post Now. The optional type writes the existing root dispatch priority
and manual Post Now admission context in the same transaction. The idempotency
fingerprint includes this option when supplied. Older extension and Reply
callers retain their prior request handling. The Post endpoint returns
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
   empty native composer and select any intended company persona
   without filling or attaching content. Personal sender identity comes from the
   verified account-management cache. X authorizes before opening a composer
   because opening it can restore an existing human-sendable draft.
2. Complete fresh backend preflight and actor reporting, then call the existing
   segment start route with `authorizationMode: NATIVE_FLOW_V1`. Existing frozen
   actor, project/organization membership, revision, fencing, pacing and quota
   checks remain. LinkedIn company sends require established company authority and explicit native
   company selection; a controlling personal account alone is not sufficient.
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


## Full original Post editing before sending authority (2026-11-13)

This replaces the earlier account-only editor restriction. Existing `POST /posts`
accepts the complete normal editor payload (body, media, settings, thread and
root tags/schedule/account), retaining the original root/group and SendIntent.
An existing coordinated Post requires one original root, a stable top-level
`requestId`, and per-Post `expectedRouteRevision` and `expectedContentRevision`.
Both expected revisions accept nonnegative integers, including zero: the stored
Post content revision starts at zero, and enqueue copies the saved Post revision
into its SendIntent. The full editor, scheduling and optional versioned saved
Reply inputs must retain that exact value; clients must not clamp it to one or
omit it to bypass conflicts. The transaction still compares current revisions,
checks send evidence and advances versions only on an accepted edit. This input
validation correction requires a backend deployment only, without a schema change.

`allowedActions.edit` is the explicit full-editor permission; `selectAccount`
remains for older account-only consumers. Unclaimed API originals are editable;
any API execution remains immutable. Existing recurring controlled admission
restrictions remain; safe Reply editing follows the versioned preauthorization policy below.

The serializable coordinator transaction uses the shared evidence predicate and
shared preparation revocation helper, then invokes the existing repository editor
mapping in the same transaction. Native opted-in preparations may be revoked only
with complete never-authorized/no-exposure evidence, including validated no-permit
stop history after retry. Old clients, UNKNOWN, authorization or confirmed history
remain blocked. Removed children are soft-deleted, preserving execution references.
Audited revoked old payload/segment hashes remain self-consistent; they need not
match subsequently edited current content. Unrevoked payloads must still match the
current full chain before revocation. Original lease/receipt evidence, quota and
account/platform pacing are preserved; late contradictory receipts quarantine the
original intent/current owner rather than silently replaying content.

Each accepted full-editor submission advances both contentRevision and
routeRevision by one; exact request replay returns its durable transaction
acknowledgement without another edit. The response includes original `postId`,
`integration`, `state`, `publishMethod` and a transaction-snapshot `sending` summary
with the same intent/root and accepted revisions. New claims hash the edited
current payload; old execution payloads are never rewritten.

`type:draft` retains the same Post as DRAFT and intent as existing CANCELLED with
an audited `context.editableDraft:true`. Public status is DRAFT and edit remains
available. It cannot dispatch or block active controlled drain. Only another
explicit editor submission can resume the same intent as QUEUED; no new status,
schema migration, business row replacement or automatic retry is introduced.
Deploy backend support before the website full-editor client. No test is proof
of browser rendering or live platform publication.

AUTONOMOUS full editor submissions with stable request ID and both expected
revisions use the existing repository mapper in a mode-locked transaction. Only
complete live unclaimed legacy chains are editable; captured/claimed/result
evidence remains blocked. Thread removal soft-deletes old rows and preserves
independent roots. Old client scheduling requests keep their previous contract.
Controlled API originals may be saved as drafts without changing method; an
unsupported API dispatch is rejected before mutation unless an explicit valid
extension choice is supplied. Full editor saves never silently change methods.

Editor idempotency hashes the original request before short-link transformation;
receipt replay returns the accepted snapshot without generating new links or
advancing revisions again. Changed request bodies cannot reuse the same ID.


### Unified Post discovery cursor and Post Now priority (2026-11-13)

Post Now is a priority change on the original Post, not another action or queue.
The existing dispatch.mode=now/requestedAt marker expresses that choice. Backend
claim discovery persists only one POST cursor per node and the existing separate
REPLY cursor; no POST_NOW cursor action, schema change or database migration is
required. SendIntent and SendExecution actions also remain POST/REPLY.

An authenticated POST poll first tries up to 100 marked immediate-work
candidates from one snapshot; the snapshot query itself has no row-count limit.
This priority prepass has no durable cursor and does not advance or rewind
the POST cursor after a grant. If it cannot grant work, the normal POST keyset
scan continues over all eligible due Posts, including marked ones. Its durable
progress therefore reaches tasks beyond a blocked priority prefix across bounded
polls. Priority and ordinary scans have independent finite budgets. This gives
immediate work bounded priority while preserving eventual discovery beyond
blocked prefixes. All candidates still pass current mode/project/actor,
account occupancy, pacing, quota and permit decisions; a priority flag bypasses
none of them. Original mutation receipts remain authoritative for exact replay.
Direct root claims and Reply retain their existing semantics.

An earlier backend version attempted to store POST_NOW in SendClaimCursor.action,
which violates the existing POST/REPLY CHECK (PostgreSQL 23514), even on an empty
POST poll. This correction removes that write; retain the original database
constraint. The proposed constraint-widening migration is withdrawn. Deploy the
corrected backend and let existing pending claim requests recover normally. No
cursor/history/business-record reset, SQL application, db push or schema migration
is needed. If an earlier expanded database already contains POST_NOW rows, the
corrected code ignores them and never deletes or uses them automatically.

## Original Post and Reply recovery corrections (2026-11-13)

An exact retry of first CONTROLLED enqueue from an existing Post draft checks its
original `send-create` receipt before classifying the request as a later full edit.
It retains the original root/thread group and intent; changed payloads cannot reuse
the request ID. Full-editor acknowledgements retain their separate edit receipts.
An edited unbound OPTIONAL queued Post keeps the existing `CURRENT_SESSION` and
`AWAITING_CURRENT_ACTOR` admission semantics; a saved draft remains non-dispatchable.

CONTROLLED saved Reply editing now uses the existing `PATCH /engage/sent/:id`.
It accepts existing content/generation-input/date fields plus `requestId`,
`expectedRouteRevision`, `expectedContentRevision`, and optional `integrationId`.
The stable request and both expected revisions are required for an existing intent.
Omitting account selection retains the original account and selection provenance;
`null` requests inheritance/default resolution. An unresolved OPTIONAL account uses
`CURRENT_SESSION` and `AWAITING_CURRENT_ACTOR` until verified first-claim binding.
Omitting `scheduledAt` retains the schedule; a future ISO value schedules, and
`scheduledAt:null` requests server-now only on this versioned controlled edit.
Legacy null-date requests remain invalid. Exact acknowledged future-date retries
still return their receipt after that scheduled time passes.

Reply `allowedActions.edit` and `selectAccount` use the same complete native
preauthorization evidence as Post. The transaction preserves the original
sentReplyId, root, intent, opportunity and external reply target; it revokes safe
preparations through the existing cancellation marker, advances both revisions,
and stores a durable `{id,postId,post,sending}` acknowledgement. Old clients,
authorization/exposure, UNKNOWN, confirmation, incomplete history and existing quota
reservations remain protected. Existing origin, policy, quota and pacing are not
reset. Changed accounts still require fresh actual browser identity verification.
The accepted Reply is already queued; clients wake the existing bridge after
checking the acknowledgement rather than creating another content record.

Legacy AUTONOMOUS queued Reply edits now recheck claim, admission, captured,
quarantined and deleted evidence under the same mode lock as browser admission.
Content, generation inputs and date commit together; rejected edits do not partially
reschedule a protected reply. The existing original-schedule lockout remains.
Safe API/bound legacy schedule changes restart the existing Temporal workflow;
explicit extension work retains browser routing. Legacy browser discovery and its
atomic claim both require due time and a null/EXTENSION method, preserving old
null-method automatic replies while excluding manually scheduled API work.

Both existing due responses retain safe optional `reason`, `executionId` and
`status` from controlled claims alongside `due`, pacing and protocol. They expose
no lease credentials or raw evidence. Empty discovery, temporary waiting and
uncertain publication remain distinct; expired occupancy never proves non-submission
and never automatically replays UNKNOWN or confirmed content.

Deploy the backend before clients use versioned Reply edits or null-date immediate
submission. No schema migration, new status, endpoint, queue or cursor is required.
Older saved-Reply enqueue requests retain their original idempotent contract.
Tests verify coordination and request handling, not live platform publication.


## Quota-aware controlled claim (2026-11-13)

Controlled POST and REPLY discovery now checks the next root write's applicable
quota before creating a new execution. The existing candidate transaction resolves
the current operation policy and reads its existing quota buckets, or the same
historical baseline used by reservation when no bucket exists. The precheck creates
no bucket or reservation, does not consume quota, and does not bind an exhausted
OPTIONAL original to the candidate browser account. The verified candidate's canonical
account is used for this read before first-claim binding.

Exhausted candidates retain their original business and preparation state and are
skipped while discovery continues for other eligible accounts. Existing claim/due
responses carry `reason: SEND_QUOTA_EXHAUSTED` through their current reason field;
no new response field or endpoint is required. A later normal poll uses a new request
ID and rechecks the current policy/window/ledger. Replaying an already accepted empty
claim keeps its original empty result; replaying a live old claim remains credential
recovery and does not authorize a platform write. Existing requested activity/history
may remain visible in the extension; this change prevents new execution admission.

This preserves the existing budget dimensions and scopes. Automation's project
reply allowance remains enforced only where the existing policy requires it; manual
operations retain their existing exceptions and account safety limits. Post is not
charged against a Reply-only allowance. UNKNOWN/HELD usage remains counted, and
expiry does not release it. No quota setting, daily limit or timezone is reinterpreted.

Thread continuation segments retain their existing per-segment authorization
and quota checks; claim does not reserve capacity for an entire thread.

Availability is not a reservation: another sender or a policy change can consume
the remaining capacity after claim. Final `/start` still performs the original
atomic quota reservation and rejects an exhausted allowance before granting a permit.
AUTONOMOUS legacy discovery retains its existing project/transport gates and current
browser account behavior. Deploy the backend to enable this earlier CONTROLLED gate;
no client upgrade, schema migration, new status, cursor or queue is required.


## Existing-API cached account preflight (2026-11-13)

`GET /extension/send-protocol` adds the optional capability `cachedActorPreflight: true`. The standalone extension uses the existing `POST /integrations/extension-session` observation fields (`SESSION_BOUND_ACTOR`, `sessionBinding`, actor identity, fresh `probeId`, `preflightChallenge`, and observed time). No endpoint, website contract or database column is added.

Before updating the session, the backend validates cached continuity against the previous verified session: exact integration, namespace, actor, scope binding and company controller/context. This is required again when confirming the challenge. The challenge-bound report advances `probeId` but preserves the original live verification timestamp and `lastVerifiedIdentity`. Start still requires the exact session/segment probe, revisions, frozen target, node credential, policy, fencing and timing. Cached continuity cannot register/recover an account or bypass expired live proof. LIVE observations remain supported for account-management refresh and older clients.

The extension alone owns cache refresh, switch invalidation and native company selection. CONTROLLED send preparation consumes that cache; personal composer/avatar/profile-link identification is removed. AUTONOMOUS does not validate social identity and uses CURRENT_SESSION; original Aisee owner checks, admission, journal, pacing and uncertain-content safeguards remain. Publication-returned identity may be recorded as an outcome without introducing a pre-send probe.

Deploy the backend first; new clients stop before native work if the capability is absent. No migration or website update is required. Live platform acceptance is separate from code verification.


## Account continuity correction (2026-11-16)

Seven-platform verified accounts no longer expire on the backend after five
minutes. Historical `verificationExpiresAt` values are ignored and the compatible
field returns null. Logout, actor/session changes and revocation still invalidate
account evidence; sending permits, quotas and uncertain-result protection remain.
Cookie checks/heartbeats use five-minute pacing and node-online tolerance is
fifteen minutes. Ordinary maintenance remains passive unless renewal, recovery,
account changes or an explicit check require live verification. CONTROLLED sends
reuse unchanged acknowledged session bindings; AUTONOMOUS keeps the current
browser account. Legacy STALE display text means verification is needed, not
platform cookie expiry. Deploy the backend before the extension; no migration,
new business state or API is needed. See the [complete contract](../../aisee-browser-extension/docs/account-bound-send-protocol.md#browser-login-continuity-without-a-verification-ttl-2026-11-16).


Review clarification: raw `GET /extension/nodes` session rows also return
`verificationExpiresAt: null`, matching sending-context/account projections for
historical records. Node connection labels are advisory, not claim/start gates;
backend account-evidence, authorization and idempotency checks remain mandatory.

### Expired uncertainty does not reserve queue capacity (2026-11-16)

Quota availability/reservation settles eligible expired UNKNOWN holds as RELEASED
using the existing writer-expiry proof, without changing business records,
SendIntent, execution or segment outcomes. `/status` and `allowedActions` still
require original-content reconciliation; no retry eligibility changes. Account
occupancy, pacing and concurrent authorization remain enforced. Confirmation
settles previously returned capacity as actual usage exactly once, including
across mode-revision buckets. See `organization-sending-modes.md` for the updated
quota policy and deployment order. No request/response fields or schema change.

### Medium/Quora empty preparation before native authorization (2026-11-17)

The extension now prepares Quora Post/Reply composers and checks Medium Reply
restored drafts before requesting the existing segment preflight/start. Failed
empty preparation retains PREPARED and uses the original stop-confirmation API;
post-dispatch uncertainty still reports UNKNOWN. No endpoint, request/response
field, authorization policy or allowedActions changes. Existing Medium response
matches stop before sending and require the current saved-reply verification
path; they are not reported as a successful new execution. Rebuild/reload the
extension; no backend migration or historical auto-retry is needed.

## Confirmed-success-only daily quota (2026-11-17)

The confirmed-success-only policy in postiz-app's `organization-sending-modes.md`
supersedes the earlier HELD/expiry-based quota admission notes above. Only
`confirmedUnits + requestedUnits` is checked against the daily limit; held/failed/
UNKNOWN attempts do not consume successful quota. Existing account occupancy,
pacing and content replay protection remain separate. Late successes are counted
once, including released historical reservations. No API, client capability or
schema changes; deploy the backend. Already-dispatched/late outcomes are recorded
truthfully and can exceed the limit before subsequent authorizations stop.


## Signal Feed saved draft reads (2026-11-17)

`GET /engage/opportunities` adds optional `draftReplyId` for the latest non-removed
saved DRAFT working copy in the same organization/project. Existing `sentReplyId`
and `replyLink` continue to identify the latest non-draft reply independently, even
when a newer working copy exists. The draft marker grants no editing or sending
authority and does not change opportunity status or counts. Removed/deleted
working copies are excluded from draft recovery only; non-draft publication IDs
and links retain their previous selection semantics, including platform removal.

The existing `GET /engage/opportunities/:id` route now combines its original flat
card read with the existing detail reader, returning the saved working copy for NEW
opportunities as `sentReply`, including its original Post content and inputData;
no draft yields null. SCHEDULED/REPLIED detail selects the latest non-draft reply,
so another working copy cannot replace queued/published content. Other states
retain the original empty editor response. The authenticated user is forwarded
from the controller and the existing attachSentReplySending helper supplies
`sending` and `post.sending`, including authoritative allowedActions. Detail
selects executionProtocol/sendIntentId so historical controlled work retains its
summary after mode handover; failed summary reads fail the request rather than
falling back to an editable draft.
The frontend must load detail before opening the editor and check save-draft
acknowledgements. Existing save-draft remains DRAFT-only, uses the original scoped
working copy, and never grants a lease, permit, claim or send intent. No schema
migration is required; older frontends ignore the additive list field.

### Existing Reply drafts beside another claimed reply

An opportunity can have multiple EngageSentReply/Post records. Its SCHEDULED
status is a reply-claim marker, not an assertion that every linked Post is QUEUE
or that a timer remains active. A terminal failed coordinated attempt retains its
claim/audit context; a separate pre-existing human DRAFT can still be present.
Do not reset the opportunity or cancel/retry the sibling just to edit that draft.

The existing `GET /engage/sent/:id` is the exact-record editor read. Opportunity
detail can legitimately select another reply and must not supply the clicked
draft's content, strategy, mentions or sending permissions. The existing
`PATCH /engage/sent/:id` accepts content/settings edits to an original unclaimed
legacy DRAFT as well as its existing QUEUE editing behavior. It uses the same
mode lock and conditional Post update; DRAFT remains DRAFT, and the opportunity,
sibling records, intents and executions are unchanged. DRAFT scheduling through
this route is rejected; normal enqueue/claim is still required for publication.
Deleted/removed, claimed/admitted, quarantined and intent-owned originals retain
their protections; coordinated originals still use the versioned coordinator
editor. Generation/new-draft `save-draft` keeps its existing actionable-status
gate, including rejecting SCHEDULED. No new endpoint, field or migration.

### Latest saved working copy and nullable legacy origins (2026-11-17)

Human legacy DRAFT lookup accepts both NULL sendOrigin and non-AUTOMATION origins.
SQL nullable NOT alone excluded the NULL origin written by ordinary draft creation,
so each opportunity-level save could insert another Post/Reply. The explicit NULL
branch now shares the existing legacy/protected protocol predicates and the same
Serializable lookup/write transaction with bounded conflict retry. Coordinated
automatic drafts retain their separate ACCOUNT_BOUND_V1/AUTOMATION scope; QUEUE,
claim, quota, confirmation and UNKNOWN semantics are unchanged.

Existing human copies are selected by server-owned inputData._draftSavedAt, then
createdAt and ID, through the same latestDraft selector. Missing/invalid legacy
save provenance falls back to createdAt, never either general updatedAt clock.
NEW opportunity detail and human draft upsert use this ordering; Feed
draftReplyId selects the most recently saved copy while non-draft publication IDs
and links retain their original creation-order contract. Existing explicit-ID
draft PATCH updates the selected original, without generation or another row.
Regeneration remains version history, not implicit sending authority. Historical
duplicate records are neither deleted nor repurposed. No schema change is needed.
Deploy the backend for nullable upsert and latest-save ordering; the website can
use the already-deployed exact-ID DRAFT PATCH independently.

Context-review correction: Post.updatedAt and Reply.updatedAt are general metadata
clocks and cannot identify the last content save. Failure annotations and author
enrichment must not promote old content. Only human DRAFT upsert/create and safe
exact-ID human DRAFT PATCH write _draftSavedAt inside the same transaction as the
content. Partial PATCH preserves omitted saved settings. This is an optional,
server-owned key in the existing inputData JSON, not a request DTO field, state,
column or migration. Existing clients ignore it and continue sending ordinary
content/strategy/brandStrength/mentions. All human read selectors use one complete
save/creation/ID comparison, including timestamp ties. Automatic QUEUE and
coordinated automatic DRAFT producers retain their original findFirst lookup,
payload and mode/claim semantics; they neither sort by the human save marker nor
write it. Legacy automatic DRAFT input is also not restamped as a human save.

The existing general timestamps, per-record revisions and best-effort per-
opportunity generationHistory cannot supply atomic per-original content-save
provenance; the narrowly scoped JSON key avoids changing their existing meanings.
Unmarked historical duplicates are preserved, with no guessed rewrite or cleanup.
Deploy all manual-draft read/write API instances together for the new save clock;
there is no DDL or migration command. Deployment is performed only by the user.

## Segment preflight serialization conflicts (2026-11-17)

Normal mode guards now use compatible `FOR SHARE` Settings row locks instead
of no-op updates. Organization configuration mutations take system SHARE then
organization UPDATE locks; the system capability writer takes system UPDATE.
Normal CONTROLLED authorization reads only locked mode/transition metadata,
not organization-wide blocker statistics. Full status projections and historical
handover checks retain their existing readers. Repeated unchanged maintenance
markers no longer update the organization Settings row. PostgreSQL raw-query
40001/40P01 conflicts are normalized into the existing P2034 retry path.

Segment preflight now opts into the existing `sendTransaction` exponential
backoff with jitter for residual Prisma P2034 conflicts.
The same database transaction is retried at most four times in total, with fresh
mode, node, lease, execution and segment checks on each attempt. A successful
retry only issues the existing identity challenge; it does not grant a submit
permit or perform a platform write. Persistent conflicts still fail closed.

This applies to the shared CONTROLLED Post/Reply preflight endpoint on every
supported platform, including retained controlled work during mode handover.
AUTONOMOUS execution, request/response fields, allowedActions, pacing, quota,
outcome settlement and original-content retry eligibility are unchanged. Deploy
every backend/orchestrator process using these guards; no client update,
migration or historical resend is required. Old processes still perform no-op
writes, so a mixed rollout retains the old contention source until they stop.

### Policy and draft writers use the same coordination boundary

Account-preselection policy readers now share the existing Settings row rather
than rewriting its original JSON/timestamp. Policy saves acquire exclusive write
intent before checking expectedRevision. Absent-policy REQUIRED defaults and the
lastRequiredRevision barrier are preserved. Bind/edit callers still perform their
existing account, version, ownership and pacing checks.

Plan materialization and Post/Reply content operations read a locked narrow mode
context via `lockModeIn`, avoiding dashboard blocker aggregates for configured
CONTROLLED organizations. System disable still yields PAUSED. Autonomous and
historical eligibility fall back to complete state checks; configuration writers
and administrative status APIs retain their full projections. Existing API fields,
allowedActions, quotas and unknown/confirmed-content replay rules do not change.
No frontend/extension update or migration is required; update backend/orchestrator.

The internal `lockModeIn` return contract is explicitly `SendModeContext`, limited
to mode/revision fields and common transition metadata. It does not expose the
dashboard's blocker/reallocation/count projection; persisted reallocation data
is still validated. This is a TypeScript contract clarification, not an HTTP
response change. Disposable PostgreSQL tests now also verify same-receipt browser
settlement versus administrator recovery in both commit orders, starting from
AUTHORIZED and UNKNOWN: a real serialization conflict retries against current
evidence and cannot overwrite the winning terminal decision or duplicate its
recovery receipt. Existing ownership, quota provenance and replay rules remain.

### Original reply receipt evidence

The authenticated extension execution status exposes the segment's existing
`authorizedAt` so readback can exclude comments known to predate authorization.
`submitBefore` limits the original click, and does not limit subsequent
recovery. Unique exact matches can confirm without a timestamp. The controlled
owner retry API continues to distinguish active work, duplicate-risk review,
confirmed publication and accepted requeue. Platform reading does not change
admission.

Autonomous reply adapters in the extension identify the comment's own ID and
optional permalink. They report `commentId` on the confirmed browser-write
outcome. The publish-reply callback references that outcome with
`browserWriteId`. The backend verifies the original saved Post, organization,
user, platform and optional link, then copies the verified ID into `releaseId`
and uses the existing Engage publish and billing workflow. Legacy outcomes
can confirm publication. Their `platformPostId` may point to the parent item,
so only an explicitly recorded comment ID is used as a reply ID. The existing
X URL-derived ID and link-only callbacks still work. Deploy the backend before
the extension.

A URL-less publication requires a confirmed browser write for the same reply,
organization, user and platform, even when the extension could not read a
comment ID. Older callbacks without a write ID can use their scoped confirmed
ledger entry. The extension can resubmit a confirmed receipt through
**Check status** after a callback failure. Manual links still use the existing
published-reply metadata endpoint. A concurrent receipt replay preserves a link
saved by another request.

## Browser publication receipts

An authenticated original browser can settle a single-segment Publish or
Reply with a verified HTTPS permalink when the platform exposed no native
ID. The outcome still requires either the opaque platform ID or that link.
Native IDs and URLs are independent strings, each up to 2,048 characters.
API attempts and multi-segment threads continue to require a native ID.
The result URL becomes `releaseURL`; `releaseId` stays null for a URL-only
receipt. An authenticated follow-up receipt for the same publication can
add the missing field to both the saved Post and the segment without
rewriting its original event or settling quota again. Outcome event
deduplication, original ownership, and retry eligibility apply as before. Legacy URL-as-ID events remain readable and accepted. Deploy this
backend before the extension that emits URL-only receipts. No migration is
required.

### Attended recovery of an unbound legacy failed Post

`GET /posts/:id` and group detail expose `legacyRetryRevision` and
`allowedActions.retry.reason = LEGACY_POST_RETRY_REVIEW_REQUIRED` for eligible
unbound legacy calendar extension failures while controlled sending is active.
The revision binds the reviewed original content, error, and claim snapshot.
Post Now uses the existing `projectId` query scope and opt-in `readOnly=true`
to load that detail without persisting media normalization. Ordinary detail
requests retain their existing normalization behavior.
`POST /posts/:id/retry` accepts `type: "now"` and an optional `legacyReview` with
`requestId`, `expectedRecoveryRevision`, `integrationId`, `reviewedNotSent: true`,
and `draftsClosed: true`. The user reviews the original platform attempt and
confirms the account for the new send. Stored error text or a cleared claim
alone cannot establish non-submission.

Recovery is scoped to an active project and organization member, one legacy
calendar root with no thread, recurrence, integration, intent or publication
evidence, and no protected legacy writer or unresolved autonomous receipt.
A recent browser claim remains protected through the existing lease window even
if an old failure callback already cleared its release ID.
The coordinator rechecks eligibility, resolves the account and queues the same
Post via ordinary controlled admission. One existing SendMutationReceipt
retains the failure, historical claim, review, account and request identity.
Accepted recovery returns `accepted: true` with the same Post and SendIntent
IDs and its current state. A replay can therefore acknowledge a retry that has
already moved beyond QUEUE.
Normal claims, platform pacing, quotas, author verification and callback fencing
apply. The ordinary retry request is compatible with existing clients. There is
no schema change, backfill or automatic historical replay. The website reads the
original Post detail for send decisions. Calendar and table list contracts are
unchanged. Full content edits still use `POST /posts`; scheduling an existing
eligible Post uses `POST /posts/schedule`.

### Website Post Now after an unconfirmed controlled attempt

The website loads `GET /posts/:id?projectId=…&readOnly=true` on an explicit
Post Now click. For an unconfirmed original it posts the exact execution's
resolution revision to the owner retry route above with `type: "now"`.
The existing transaction checks known publication, live permits, ownership
and newer writers before accepting. The change is backward compatible for
existing clients. Deploy this backend contract before the updated website.
The matching-browser wake uses the existing message. No database migration is needed.


### Current-account Post Now on an original Post

`POST /posts` with `type: "now"` can apply the editor payload and send the same
original using the current project's selected account. `POST /posts/schedule`
with `type: "now"` and `integrationId` applies the same account decision to the
saved content. Both commit the new binding and priority on the original Post
and SendIntent, using the submitting member's current send policy. An explicit
Post Now permits a new account for a terminal failed original without requiring
the old preparation to qualify for ordinary account editing. An unconfirmed
original uses the existing stopped-attempt checks for the old execution,
including authorization expiry and confirmed history. Live or confirmed work
cannot enter that recovery. Existing execution and outcome evidence stays in
place. Account selection, current permissions, pacing, quotas, and activation
remain in force. No new Post, API route or database migration is needed.
