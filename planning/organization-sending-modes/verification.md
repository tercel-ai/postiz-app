# Verification and Acceptance Evidence

## Historical legacy writer isolation: 2026-10-23

The account-occupancy guard now distinguishes a quarantined historical reply
from a live browser writer. It leaves the old Post, claim, captured drain and
receipt records untouched. Complete current-claim-compatible `NOT_SUBMITTED`
proof permits independent controlled sends, not resubmission of the old reply.

Fresh regression evidence:

| Acceptance boundary | Executed regression |
| --- | --- |
| Unbound historical LinkedIn proof stops holding the platform but preserves the original content quarantine and denies fresh autonomous admission | `send-mode-legacy-writer-isolation.spec.ts`: quarantines a historical unsent LinkedIn reply without retaining a platform writer |
| Reservation and final authorization admit independent work without clearing the old lease | Same file: admits and authorizes an independent controlled send through the same historical guard |
| Timer polling and explicit root claims both reach a fresh one-shot submission permit | `send-claim.regression.spec.ts`: claims and starts independent work past a settled historical browser reply (poll / direct) |
| AUTHORIZED, UNKNOWN, CONFIRMED, absent/stale/mismatched/foreign proof, newer claims, API work, threads, recurrence and publication evidence retain protection | Negative cases in `send-mode-legacy-writer-isolation.spec.ts`; existing immediate-mode and historical recovery suites |

Test-first verification reproduced three failures against the previous source:
the LinkedIn platform remained blocked, independent reservation returned
`LEGACY_ACCOUNT_DRAIN_REQUIRED`, and exact-bound proof still retained occupancy.
All three passed after the fix. The final new isolation file has 24 passing
cases, and the claim regression file has 27 passing cases including two new
poll/direct cases.

Final Node 22.22.0 non-frozen workspace run: **4,692 passed, 0 failed,
97 skipped**; 294 passed files and 5 skipped files; exit 0. The 97 skips comprise
96 existing gated infrastructure/provider cases and the explicitly excluded
test name `reports reachability of each candidate endpoint` from the one-off
Reddit `probe-flairs.spec.ts` diagnostic. Initial unrestricted runs were stopped
while waiting on that external probe; they are not counted as completed runs.

Command: `env DATABASE_URL= REDIS_URL= pnpm exec vitest run --exclude 'apps/extension/**' --testNamePattern '^(?!.*reports reachability of each candidate endpoint)' --silent --reporter=dot --reporter=json --outputFile.json=/tmp/postiz-legacy-writer-node22-tests.json`

The Node 22 PATH was selected explicitly. Final output:
`/tmp/postiz-legacy-writer-node22-tests.log`; machine-readable per-test evidence:
`/tmp/postiz-legacy-writer-node22-tests.json`. The modified service and its
production dependency graph also passed TypeScript `--noEmit` using
`/tmp/postiz-legacy-writer-typecheck.json`, with no diagnostics in
`/tmp/postiz-legacy-writer-node22-types.log`. Whitespace checks passed.

No database mutation, schema migration, deployment, browser extension rebuild,
or live social-platform write was performed for this fix. Frozen
`postiz-app/apps/extension/` remains excluded. This is application-level memory
transaction evidence, not deployed PostgreSQL concurrency or live LinkedIn
acceptance. Build and restart consumers of the backend shared service before
checking the previously queued independent reply.

Scope: current backend, orchestrator, shared libraries and standalone browser extension. Frozen `postiz-app/apps/extension/` is excluded. No database connections, migration execution or live social writes were performed.

## Safety Criteria

| Criterion | Named regression source |
| --- | --- |
| Default autonomous, explicit controlled, typed system setting and emergency override | `extension/__tests__/send-mode.service.spec.ts` |
| Active membership, organization/user ownership, expected revision and idempotent replay | `send-mode.service.spec.ts`, `send-mode-api.spec.ts`, extension `send-mode-control.spec.ts` |
| Enqueue racing downgrade cannot produce incompatible successful admissions | `send-mode-safety.spec.ts`: serializes an enqueue racing downgrade |
| Re-enabling controlled mode counts autonomous publications, unattributed same-platform usage and old controlled segments without resetting allowance | `send-quota.service.spec.ts` |
| Late paused outcome settles held quota once, duplicate callback does not charge twice | `send-mode-safety.spec.ts`: keeps authorized late outcome settlement available; `send-quota.service.spec.ts` |
| Settled controlled content never becomes autonomous-retryable | `send-mode-safety.spec.ts`: retains root protocol; `send-mode-routing.spec.ts` |
| Claim and permit continue to require controlled mode inside transactions | `send-mode-routing.spec.ts`, `send-execution.service.spec.ts`, existing coordination/claim suites |
| Autonomous server platform invocation is outside retryable transactions, crash and retry cannot invoke twice | `send-mode-effects.spec.ts`, `autonomous-effect-wiring.spec.ts` |
| Unknown autonomous effects block enrollment; manual resolution grants no resend | `send-mode-effects.spec.ts` |
| Old Temporal snapshots cannot bypass current Post protocol/intent state | `send-mode-effects.spec.ts`, `autonomous-effect-wiring.spec.ts` |
| Explicit autonomous negotiation preserves unresolved local journals/manifests | extension `session.spec.ts`, `runtime.spec.ts` |
| Options mode writes retain identity scope and refresh current state after historical receipt replay | extension `send-mode-control.spec.ts`, `sending-mode-panel.spec.tsx` |

## Verification Commands

Use Node 22. Backend full Vitest run uses coverage, excludes the frozen extension, and sets DATABASE_URL/REDIS_URL empty. Infrastructure and real-provider cases remain skipped by their existing gates. Backend and orchestrator production TypeScript are checked with scoped temporary configs excluding tests, React libraries and the frozen directory.

Standalone extension: full Vitest suite, TypeScript `--noEmit`, Chrome/Firefox Vite builds into `/tmp/aisee-org-mode-build/`.

## Results

Final source verification on 2026-10-20:

- Backend full non-frozen Vitest suite with coverage: **4,356 passed, 0 failed, 96 skipped**, 279 passed files and 4 skipped files; exit 0. JUnit contains 4,452 cases, zero failures/errors. Logs `/tmp/postiz-mode-review-final-full.log`, `/tmp/postiz-mode-review-final-junit.xml`.
- Standalone extension full suite: **2,703 passed, 0 failed, 0 skipped**, 181 passed files; exit 0. Unique final log `/tmp/aisee-review-extension-postfix-full.log`.
- Backend and orchestrator scoped production TypeScript: both exit 0 with empty diagnostics; `/tmp/postiz-review-backend-final-types.log`, `/tmp/postiz-review-orchestrator-final-types.log`.
- Extension TypeScript and Chrome/Firefox temporary builds: exit 0; build outputs `/tmp/aisee-review-extension-postfix-build/chrome` and `/tmp/aisee-review-extension-postfix-build/firefox`.
- Changed-file whitespace checks in backend, standalone extension and frontend documentation: exit 0.
- Plan structure verification: 0 errors, 0 warnings.

The 96 skipped backend cases require infrastructure or real-provider credentials and were not executed. No live database/social-platform acceptance is implied.

## Limits

Memory transaction tests verify application interleavings and invariants; they do not demonstrate PostgreSQL SSI or unique-index behavior against a deployed database. No production keys, node enrollment, migrations or social-platform acceptance were exercised. Autonomous extension sending retains its existing queue/lease guarantees; controlled V1 is the mode providing shared account/permit/quota protection. Uncertain legacy OAuth failures now require evidence-based operator review instead of automatic external retries.

## Independent Review Corrections

The changed configuration/admission, sending/quota and standalone-extension chains were reviewed separately and then checked across module boundaries. Four concrete issues were reproduced and corrected:

1. Autonomous COMMENT admission previously selected an arbitrary same-group root, which could select a recurring clone. It now follows the persisted parent chain and rejects a remote parent from another root. Ordinary and recurring nested-comment regressions pass.
2. Autonomous thread finishers and plug actions without separate Post rows were missing from controlled quota reseeding. Confirmed standalone receipts now contribute actor-matched write/reply units, while POST/COMMENT facts are counted only through their published rows. Trusted provider methods supply precise attribution; unknown quantities or confirmation times deny new authority. No nonexistent receipt timestamp column or admission-time inference is used. Manual confirmation stamps completion provenance and never grants a second platform call.
3. Options registration checks previously accepted a locally cached token as proof of current registration. The new authenticated read-only current-node endpoint verifies active credentials and returns only public owner/node fields; it does not replay expired initial registration receipts or rotate credentials.
4. A login change between Options owner precheck and registration could target another owner. Expected backend organization/user are now verified before registration, on cached sessions, and on the returned session; original credentials and settlement journal remain intact on rejection.

Additional negative coverage checks malformed organization Settings and actual controlled claim/start calls after a Settings pause. Neither creates new reservations or permits. Cross-module review found no further verified defect in the reviewed changes.

Review artifacts: `/tmp/review-mode-guard.md`, `/tmp/review-send-quota.md`, `/tmp/review-extension-modes.md`, `/tmp/review-mode-cross.md`, `/tmp/review-mode-acceptance.md`. Final executed backend test names/statuses: `/tmp/postiz-review-final-executed-tests.json`.

Acceptance reconciliation against the final executed test inventory: **51/51 P0/P1 sub-behaviors covered**, zero uncovered P0/P1 behaviors. Skipped infrastructure cases provide no acceptance evidence.

## 2026-10-27 automation continuity regression verification

- RED: missing-owner continuity and reallocation regressions produced 15 failures; owner-status and extension-display regressions failed before their implementations.
- Focused GREEN: 147 backend tests passed.
- Full backend suite: 4,931 passed, 0 failed, 15 skipped; frozen `apps/extension/**` excluded per repository instructions. Command: `pnpm exec vitest run --exclude 'apps/extension/**' --testTimeout=30000 --reporter=default --reporter=json --outputFile=/private/tmp/aisee-backend-full-final.json`. The first run had one existing remote-PostgreSQL billing parity test exceed the default five-second timeout; the complete rerun passed with a thirty-second limit and no skipped-test changes.
- Independent extension suite: 3,151 passed, 0 failed, 0 skipped.
- Backend production TypeScript and extension TypeScript checks passed.
- Initialization preserves owner identity, settings, inactive switches, original schedules and accounts. It performs no platform send. Recovery uses durable administrator provenance and rejects missing/stale provenance and revoked membership. Tests cover idempotence, round trips, transaction rollback, old transition upgrade, project-error isolation and safe error-code filtering.
- Source changes are local and require deployment. Live platform success is separate from automated tests; a normal existing-configuration save restored the affected reply owner's record and subsequent background execution published a reply without a forced send.


### Inactive-project cancellation follow-up

The live stored summary identified the blocked legacy schedule as `PROJECT_INACTIVE`. The old Move to Drafts action reused the select-account/send permission check and could not withdraw the schedule. The user explicitly requested cancellation with content retained as a draft.

The original draft-save flow now validates membership, the full legacy thread and every claim/submission marker inside the shared mode lock. It saves requested draft edits, clears recurrence and never grants sending authority. The formerly introduced dedicated command has been removed. Repository/service and controller regressions cover preservation, idempotence, inactive-project independence, quarantine, membership/org isolation, coordinated/unknown protocols, partial submission and rollback on a concurrent guarded-write conflict. Frontend regressions exercise the real existing payload builder, normal POST /posts request, acknowledgements, identity changes and exclusion of coordinated/reconciling/succeeded/unknown summaries.

Fresh complete results after the additional source changes:

- Backend: **4,950 passed, 0 failed, 15 skipped**, 302 passed files and 3 skipped files; exit 0. `/private/tmp/aisee-backend-cancellation-full.json` and `.log`. Frozen extension excluded, thirty-second per-test timeout retained.
- Standalone browser extension: **3,151 passed, 0 failed, 0 skipped**; source unchanged since the previously recorded full run.
- Frontend complete test chain: **313 Node tests, 4 shell scenarios, 20 Python tests passed; 0 failed; 5 Python tests skipped**. `/private/tmp/aisee-frontend-full-serial.log`. The first parallel run stalled in existing Bing timeout tests under concurrent load and was stopped; the complete sequential rerun passed without changing those tests.
- Backend production, frontend and standalone extension TypeScript: passed with no diagnostics. Relevant whitespace checks passed. No build, service restart, schema migration or deployment was performed.

Deployment is still required for the draft-save safeguards and durable owner recovery. The live schedule remains queued until the normal deployed business command acknowledges DRAFT; source tests do not prove live cancellation. The normal Managed replies configuration save separately restored current reply automation and a new X reply was confirmed published. No old unconfirmed reply was resubmitted.


### Original draft-save integration (2026-10-27)

The extra cancellation route, service/coordinator wrappers and dedicated-route tests have been removed. All callers now use the existing POST /posts draft payload and acknowledgement. Activation enforcement moved into the post service so inactive projects can withdraw existing unclaimed legacy threads while new content and sends still require activation. Ownership failures and validation outages fail closed.

The draft repository validates active organization membership, stored root/project/group and the exact complete ordered legacy thread under the existing mode lock. Per-segment guarded writes reject claimed/submitted/intent-bound/unknown/quarantined work; any child conflict rolls back the whole thread. Withdrawal saves requested content edits and clears recurrence, preserving independent sibling roots. An unchanged inherited account is preserved rather than treated as a route clear. Existing mutation receipts protect repeated requests and matching withdrawals from different dialogs/members; stale content or route revisions reject replay.

TDD evidence: the first integration regression run had 15 failing cases; review then reproduced two inherited-route/idempotency failures and two cross-dialog/member failures before their fixes. The final focused backend run passed 55 tests, including 37 repository/service withdrawal regressions. Independent final review reported no remaining actionable finding in this flow.

Frontend full verification: 330 Node tests, 4 shell scenarios and 20 Python tests passed; 0 failed, 5 Python cases skipped. Frontend TypeScript passed with no diagnostics. Logs: /private/tmp/aisee-merge-draft-frontend-check.log, /private/tmp/aisee-merge-draft-frontend-shell.log, /private/tmp/aisee-merge-draft-frontend-python.log, /private/tmp/aisee-merge-draft-frontend-types.log.

The standalone extension is unchanged by this integration. No build, deployment, service restart or live database/social mutation was performed.

Final complete backend verification after the last source edit: **4,894 passed, 0 failed, 96 skipped**; DATABASE_URL/REDIS_URL empty, frozen extension excluded. JSON: /private/tmp/aisee-merge-draft-backend-verified.json; full output: /private/tmp/aisee-merge-draft-backend-verified.log. Backend production TypeScript passed with no diagnostics (/private/tmp/aisee-merge-draft-types-verified.log). Infrastructure skips do not supply live PostgreSQL or provider acceptance evidence.
