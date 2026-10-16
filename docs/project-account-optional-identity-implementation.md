# OPTIONAL First Binding and Social Account Identity Unification — Implementation Notes

Date: 2026-10-16. Corresponds to [design doc §14.7](project-account-extension-node-binding-design.md#147-optional-first-binding-and-identity-unification-phase-2026-10-16).

The initial phase connected OPTIONAL first binding, X/Reddit same-namespace identity reuse, and protected verification of historical OAuth identities; subsequently extension-controlled publishing/replying was completed for seven platforms, with the latest scope in design doc §14.9. **New controlled sends go through the extension only; OAuth API posting is currently unsupported.** The deployment master switch ACCOUNT_BOUND_SENDING_ENABLED and the actor rolloutReady flag remain off by default; no database migration was executed and no real social send occurred.

## First Binding Rules

Account precedence is preserved: a single explicit account → Project default → Organization default. Only when none of the three levels is configured and the task owner's policy snapshot allows OPTIONAL is a CURRENT_SESSION task created; a stale default or an explicitly specified but missing account is never turned into the current session.

Enqueue saves empty integrationId/canonicalAccountKey/target, with Post as QUEUE, accountSelectionMode=CURRENT_SESSION, accountResolution=AWAITING_CURRENT_ACTOR. Tasks that already specify an account are still frozen at enqueue and do not ignore the default because of OPTIONAL.

The first claim completes inside a single Serializable transaction:

1. Acquires the same policy coordination lock as system-policy updates, and checks the task owner snapshot and lastRequiredRevision. A system tightening followed by a relaxation still prevents older unbound tasks from claiming first; personal preferences are snapshotted at enqueue and do not change with the poller.
2. Verifies the owner is still a valid organization member, that terminal authentication is valid and supports the corresponding operation, and that the current NodeSession is verified and unexpired; the session ID must match the Integration's stable ID.
3. Verifies the Integration belongs to the current organization, is available, and is assigned to that project; replies additionally require engageEnabled. The account must have completed deployment audit with rolloutReady=true, and have no other active write or cooldown blocking it.
4. CAS-pins the same account snapshot for the SendIntent and the entire Post chain, increments routeRevision, and then creates the execution reservation. A failed reservation or media preparation rolls back the first binding; claim does not pre-reserve send count — start does.

After a successful binding accountResolution=RESOLVED and bindingSource=CURRENT_SESSION, and the target will not be re-selected when the terminal switches accounts, the claim lease expires, or the default configuration changes. First binding happens on the first qualifying terminal, which is not guaranteed to be the browser the user opened the web page in.

When blocked by the system policy barrier, the account remains empty, accountResolution=PRESELECTION_REQUIRED, and it does not proceed into first-binding candidates. The UI for explicitly rebinding/rescheduling an already-enqueued task is not yet implemented; existing SendIntents cannot be bypassed via the old edit, by rebuilding the Post, or with a new request ID.

## How Existing Business APIs Remain Compatible

The paths below omit the existing public API prefix; the original URL, method aliases and response wrapping are preserved.

| Endpoint | Behavior in this phase |
| --- | --- |
| POST `/posts` | The original integration.id still means an explicit choice; in controlled mode the account may be omitted, saving/enqueuing by platform and content. The old publishMethod parameter is still accepted, while new controlled enqueues are fixed to EXTENSION; new content keeps the requestId/itemKey idempotency requirements |
| POST `/sending/intents` | Still enqueues saved content by rootPostId; the optional publishMethod field is preserved. An existing Intent does not change account, route or send eligibility |
| POST `/sending/intents/reply` | Still restores the server-side saved reply target by sentReplyId; may enter OPTIONAL first binding |
| Original single Reply send-now/schedule endpoint | In controlled mode integrationId may be omitted; a valid default wins, otherwise OPTIONAL waits for the first qualifying actor. The LEGACY path still requires integrationId; supplying an error type/empty value is still rejected |
| POST `/posts/publish-due`, `/engage/reply-due` | V1 performs first binding server-side, then returns an execution manifest with the account already pinned; the extension does not rewrite the target on its own. Legacy requests without a node keep their original wrapping/pooling |
| GET/POST `/user/send-preferences` | Keeps expectedRevision/requestId; users may raise the requirement to mandatory preselection, but cannot lower a system REQUIRED requirement |
| GET/POST `/admin/settings/sending.account_selection_policy` | Keeps the system policy resource; only the system super admin may modify it, preserving the revision and lastRequiredRevision barrier |

Draft saving now records the EXPLICIT/INHERIT source, and an edit that omits the account does not clear an existing selection. A historical draft that has an integrationId but no selection source returns SEND_BINDING_RECONFIRMATION_REQUIRED, requiring an explicit re-selection through the original save/send request carrying integration.id; it does not guess whether the field came from a user choice or from historical default materialization.

Legacy API Intents keep their original account and route. startWorkflow explicitly returns API_PUBLISHING_UNSUPPORTED_USE_EXTENSION; Temporal activity names are retained for historical replay, but no new API execution is created and no platform provider write is invoked. Existing CONFIRMED/UNKNOWN, account locks, quota reservations and result receipts are all retained and cannot be automatically converted into an extension task for a second send. The underlying legacy coordination model and its tests are retained, but that does not mean a new OAuth send entry point is open.

## X/Reddit Identity Unification

Shared resolution lives in [SocialAccountIdentityService](../libraries/nestjs-libraries/src/extension/social-account-identity.service.ts).

| Identity | Rules |
| --- | --- |
| X | x.rest_id; a decimal string not starting with zero, kept at string precision, not merged by handle |
| Reddit | reddit.user_id; strips the case-insensitive t2_ prefix, platform ID normalized to lowercase |
| Different organization/provider/namespace | cannot be auto-merged after comparing bare IDs; the same handle is not evidence |
| legacy or multi-row conflict | keeps the original row and references, returns an explicit blockCode; does not delete, rebuild or randomly pick a row |

Given a known trusted identity, OAuth-connecting-first, extension-discovering-first, and multiple terminals discovering simultaneously all reuse one Integration ID. The extension only updates the permitted profile/identity observations, and does not overwrite the OAuth token, refreshToken, disabled, user name, custom metadata or project assignment. A new extension account saves empty token/refreshToken, empty tokenExpiration, and metadata.credentialSource=SESSION_ONLY, and is not disguised as a sendable OAuth credential.

OAuth connect and refresh share the resolution, credential writes remain in the same transaction, and the original ID with its Post/IntegrationProject references is preserved; concurrent discovery retries the whole transaction. Registering an existing account via the extension no longer consumes account quantity quota; a new account reads the count and creates within the transaction, preventing multiple browsers each seeing one remaining slot. The limit comes from the existing user plan or Stripe entitlement snapshot; it conservatively counts all non-deleted accounts and does not use refreshNeeded exclusion to evade it. When there is no reliable quota snapshot, new creations stop while existing accounts can still report.

New accounts are not automatically added to a project and are not automatically set to rolloutReady. Account creation, project authorization and execution audit are three independent steps.

## Read-Only Verification Entry Point for Historical OAuth Accounts

Added **POST `/integrations/:id/identity/verify`**, which does not require the client to submit a platform ID or proof.

Only a valid ADMIN/SUPERADMIN of the current organization is allowed. The backend reads the Integration's original OAuth credentials and calls the platform's own read-only actor endpoint; after comparing the platform-returned stable ID with the original record, and re-checking permissions in-transaction, the credential digest and the identity snapshot, it upgrades the original row's namespace/normalized ID and saves metadata.identityAudit, including the verification method, operator, time and actor. Example response:

```json
{
  "integrationId": "existing_integration_id",
  "platform": "x",
  "identityNamespace": "x.rest_id",
  "internalId": "123"
}
```

No token is returned and no send permission is granted. A subsequent fresh extension report can then associate with that Integration. If the OAuth is invalid, the platform does not allow read-only access, the original ID is actually a handle, coordinated references already exist, duplicate rows exist, or another namespace conflicts, the original record is kept and the reason is returned; it requires later manual audit and does not auto-migrate. Even if a legacy field looks numeric, it is not upgraded directly.

The main machine reasons include ACCOUNT_IDENTITY_UNRESOLVED, ACCOUNT_IDENTITY_CONFLICT, ACCOUNT_IDENTITY_MISMATCH, ACCOUNT_IDENTITY_IN_USE, ACCOUNT_IDENTITY_CHANGED, ACCOUNT_IDENTITY_VERIFICATION_FAILED. Node reports may also return ACCOUNT_CHANNEL_LIMIT, ACCOUNT_CREATION_NOT_ALLOWED or ACCOUNT_LEGACY_KEY_CONFLICT; observations and per-platform result receipts are still saved.

A duplicate OAuth connect for a known identity no longer consumes account quantity quota again. For X/Reddit the connect URL/callback identifies the actor first and checks quota within the actual creation transaction, avoiding the case where credentials cannot be attached to the same extension account because the account count is already full; other providers keep the original create-permission check. This compatibility does not restore OAuth API posting.

## Extension Wiring

The separate repository's [src/utils/coordinated/session.ts](../../aisee-browser-extension/src/utils/coordinated/session.ts) checks the session report result: it must obtain a non-empty integrationId and VERIFIED status for the corresponding platform before continuing the controlled flow; server-known blockCodes are returned as diagnosable reasons. An unresolvable identity is not treated as a registered account.

The extension continues to receive the target and routeRevision returned by claim, and even if the local request did not preselect an account, it does not infer on its own, save another account binding, or switch accounts. The actual submit still re-preflights, acquires one short permit, verifies the current actor, and writes the SUBMITTING log; first binding does not relax these requirements.

## Migration and Release Order Preparation

The original eight expand migrations must still first be reviewed and applied by the user/deployment pipeline, and only then can code using the new tables be deployed. The new [add-stable-social-identity-checks.sql](../libraries/nestjs-libraries/src/database/prisma/migrations/add-stable-social-identity-checks.sql) only prepares two NOT VALID CHECKs that protect newly created/updated known X/Reddit identities; it does not infer historical namespaces, merge data or rewrite references. Validating the existing constraints must be scheduled separately after audit.

[contract-integration-identity.sql](../libraries/nestjs-libraries/src/database/prisma/migrations/contract-integration-identity.sql) is still not part of the initial expand. The INTEGRATION_IDENTITY_CONTRACTED manual marker has been removed; when code needs to handle identity key conflicts/changes it only reads the current schema's actual unique indexes to decide whether to keep the old organization/bare-ID collision check. Only when the old key has actually been removed and the new scoped key exists is a different provider allowed to use the same bare ID. The pre-contract audit and legacy-writer exit are still guaranteed by the release process; the program does not execute DDL automatically.

All database operations are performed by the user or the deployment pipeline; the target must be confirmed to be aisee_postiz_dev. **This round did not connect to a database, execute SQL, apply migrations or db push.** All sending feature flags and the rolloutReady launch gate remain; passing simulation tests cannot be used to enable real sending directly.

## Verification and Remaining Scope

Final verification on Node 22.22.0:

| Check | Result |
| --- | --- |
| Main repo full non-frozen Vitest suite | 4035 passed, 0 failed, 96 skipped; 262 files passed, 4 files skipped |
| Standalone extension full Vitest suite | 2509 passed, 0 failed, 0 skipped; 169 files passed |
| Backend / orchestrator / extension TypeScript | all passed |
| Chrome / Firefox builds | both passed, output to /tmp, not installed or published |
| Diff whitespace check in both repos | passed |

Targeted V8 coverage for the identity unification service: lines 99.49%, branches 95.83%, functions 100%; for the extension's four coordination modules: lines 96.21%, branches 82.67%, functions 100%. This is not whole-repo or platform-poster coverage. Versus the previous review, the main repo's passing count is a net +70 and the extension +6; some legacy API adaptation tests were adjusted to the current disabled contract, while historical fact-read/freeze tests were kept.

Main-repo tests explicitly clear DATABASE_URL/REDIS_URL and use in-memory transactions, mocks and existing skip conditions; the application database was not connected in order to re-run the 96 skipped items. Identity-verification platform read requests are also mocked rather than calling real OAuth endpoints. Test logs/JSON are kept in the local temp directory at /tmp/aisee-optional-backend-full.{log,json} and /tmp/aisee-optional-plugin-full.{log,json}, with type/build/coverage logs sharing the same prefix; they are not permanent archives.

The tests cover both orderings of policy tightening and first binding, multi-terminal different-actor races, no drift on default change, owner losing access, session expiry, reply authorization, transaction-failure rollback, missing/incorrect account, legacy draft confirmation, both OAuth/extension discovery orders, concurrent quantity quota, protected verification and credential change, and the full service chain from register → bind → preflight → start → result replay → quota settlement. Platforms and databases are replaced by simulations; no real post was made.

Not yet done: the frontend's full status/re-selection UI, safe rebinding/rescheduling of enqueued tasks, cross-namespace alias and duplicate-row manual merging, audit of unverifiable historical SESSION_ONLY, providers beyond the seven platforms, full ReplySendIntent generation deduplication, settlement outbox and alerting. Real PostgreSQL Serializable/index races, multi-browser and browser-process-exit/late-receipt acceptance have not been executed. Historical OAuth records that cannot be verified remain isolated, and "identity unification complete" is not used to mask unknown facts.


## Single Deployment Switch Supplement (2026-10-16)

```env
# Default: preserve the legacy sending mechanism for unmanaged content/accounts.
ACCOUNT_BOUND_SENDING_ENABLED=false
```

Setting it to true enables in one step: account default configuration, extension terminal registration, controlled Post/Reply enqueue, the automatic producer, account binding and multi-terminal coordination. SEND_COORDINATION_ENABLED, EXTENSION_NODES_ENABLED and PROJECT_ACCOUNT_BINDINGS_ENABLED no longer need to be configured; the old variables now have no effect and will not implicitly enable the new mechanism. INTEGRATION_IDENTITY_CONTRACTED also needs no configuration, replaced by actual database index detection.

false does not mean sending is prohibited: on a first deployment that is not yet managed, legacy Post/Reply and extension flows continue, and OAuth/extension registration for ordinary legacy accounts keeps its original path. With true, REQUIRED by default requires a preselected account; OPTIONAL still must pin the account at first claim before it can submit. The product account policy is separate from the deployment master switch, and OPTIONAL cannot be used to bypass account verification.

Tasks and accounts that were once managed remain protected against duplicates and settlement after being disabled, and the extension will not degrade into re-sending unknown content. The default legacy flow and safe rollback are not about clearing SendIntents, account locks or quota reservations.

Upgrade the database first, deploy with the master switch still false to validate the legacy flow, then configure keys, complete the actor audit and explicitly enable it; this round added no table-structure migration, did not connect to a database, and did not execute SQL or apply any migration. Actual index detection is read-only code applied after deployment and is mocked in tests.

Final verification this round: main repo full non-frozen suite **4053 passed, 0 failed, 96 skipped** (265 files passed, 4 files skipped); standalone extension full suite **2509 passed, 0 failed, 0 skipped** (169 files passed). Backend and orchestrator production TypeScript passed; extension code and protocol fields were unchanged. Targeted V8 coverage for the two new modules (master switch / index detection) is 100% for lines, branches and functions, and does not represent whole-repo coverage. 18 new regressions were added, covering that retired variables cannot mistakenly enable it, unified enabling, default legacy account registration, no new alias created for an already-unified account after disabling, the protocol pause/settlement barrier, and conservative refusal when the index state is unknown/unreadable.

Tests explicitly clear DATABASE_URL/REDIS_URL and keep the existing 96 skip conditions; all database catalog queries are mocked, with no database connection or SQL execution. Final logs/JSON are in the local temp directory at /tmp/aisee-master-switch-full.{log,json} and /tmp/aisee-master-switch-plugin-full.{log,json}. Real database index reading and server upgrade acceptance still need post-deployment verification; simulation tests cannot substitute for that acceptance.


## Seven-Platform Extension Supplement (2026-10-16)

X, Reddit, LinkedIn personal/company, Medium, Quora, Hacker News and Dev.to all connect to unified extension-controlled POST/REPLY, including backend enqueue, the automatic reply producer, node capabilities, platform-specific identity, beforeSubmit, short-permit consumption, log recovery and self-resource confirmation. Medium/Quora/Dev.to keep their original single-article capability; a LinkedIn company page cannot be downgraded to a personal send. There is no requirement restriction that "implementing only X/Reddit is enough".

This round does not change the schema, does not execute migrations, and adds no business switch. ACCOUNT_BOUND_SENDING_ENABLED still defaults to false, and legacy unmanaged business keeps its original mechanism. Cross-namespace identity merging and the rolloutReady audit are still completed independently. For detailed boundaries and acceptance see [design §14.9](project-account-extension-node-binding-design.md#149-seven-platform-controlled-sending-completion-2026-10-16).

Final full test this round: main repo 4088 passed, 0 failed, 96 skipped; standalone extension 2570 passed, 0 failed. All three TypeScript checks and the Chrome/Firefox temp builds passed. Database migration and real-platform acceptance were not executed.


## LinkedIn Company Actor Supplement (2026-10-16)

Companies use the existing linkedin-page Integration, linkedin.organization_id and the numeric company ID; the transport/default binding platform remains linkedin. The node adds a derived actorKey session slot while keeping both personal and multiple companies; on-site evidence from the company admin page can be used to claim a task for a specified company, and the final preflight must be COMPOSER. An OPTIONAL without preselection will not arbitrarily pick a company. Multiple admins/terminals share the company account lock, content SendIntent and quota reservation; a personal account-switch report invalidates the current terminal's company session, and the final submit re-verifies on site.

A legacy OAuth company account is unified through the original identity verification entry point's read-only admin ACL check, and OAuth posting is not enabled. The legacy personal poster call behaves unchanged when companyId/beforeSubmit are not passed. The new session migration is prepared only; for deployment order and detailed rules see [design §14.10](project-account-extension-node-binding-design.md#1410-linkedin-company-page-sending-2026-10-16); no database upgrade was executed.


Final verification for this phase: main repo full non-frozen suite 4098 passed, 0 failed, 96 skipped; standalone extension 2596 passed, 0 failed. backend/orchestrator/extension TypeScript and Chrome/Firefox temp-directory builds all passed. Targeted line coverage for the company actor module is 100% and branches 94.33%. Only the new migration is prepared; no database was connected, no SQL executed and no real content sent.
