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
| /extension/send-attempts claim/renew/preflight/start/outcome and related operations | Extension executor | No. Enqueuing business content from the Web app does not grant permission to write to a platform |
| /sending/executions queries and reconciliation | Operations tools with the required permissions | Not used by ordinary Post/Reply pages; those pages read business summaries without execution credentials |
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
