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

Before opening any controlled X post or reply composer, the standalone executor
records local draft exposure and obtains
`POST /extension/send-attempts/:id/segments/:index/draft-exposure`. The authenticated
original node and lease are required. The acknowledgment persists the existing
PENDING segment result as `draft_exposed`, keeps the execution and intent SENDING,
and retains account occupancy without allocating a submit permit or quota. An
expired exposed draft cannot be reclaimed or renewed into another sender. A
missing acknowledgment prevents the browser from opening the draft. Deploy this
backend endpoint before loading a new executor that requires it.

A later X thread segment renews the original execution before exposing its next
draft. Retained ownership, prior confirmation, account spacing, and the original
thirty-minute preparation cap remain enforced. An already exposed draft with an
expired lease requires attended review instead of renewal. Original-node
pre-permit UNKNOWN reports retain reconciliation; stale-owner reports preserve
their evidence and quarantine competing owners. Single original posts can use
attended absence review after the lease expires, including a browser crash before
any outcome report. Replies and partial threads retain administrator resolution.


## Explicit owner-requested retry of an uncertain post

The extension can offer one-click **Retry** for an expired original single-post
attempt. The scoped `GET /sending/executions/:id/posts/:rootPostId/review` adds
`canRetryUnconfirmed` alongside `expectedResolutionRevision`. This admission flag
requires controlled sending, an active project, a ready account, the original
owner scope, settled execution and submit deadlines, and no confirmed or newer
writer. It does not assert that the first attempt was unsent.

`POST /sending/executions/:id/posts/:rootPostId/retry` accepts only a stable
`requestId` and `expectedResolutionRevision`. It returns
`{sendIntentId,status:"QUEUED"}`. The serializable transaction retains the original
segment evidence and any HELD quota, archives its executor as `RETRY_REQUESTED`,
advances fencing and resolution revisions, releases only its account ownership,
and queues the same original intent. A SendMutationReceipt audits the requesting
member and makes transport retries idempotent, including after a newer claim.
No absence acknowledgments, negative outcome, content copy, or quota release are
implied. New authorization still enforces all ordinary account and quota checks.

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
