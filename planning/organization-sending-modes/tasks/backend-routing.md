# Backend Routing

## Goal

Enforce organization mode in all sending paths without weakening existing root ownership, duplicate prevention, retry or quota settlement.

## Files Involved

- Existing coordinator, Post service/repository, Engage service/repository, extension protocol/nodes/send controllers.
- Existing sending context and binding/preferences controllers.
- Existing coordinator/claim/outcome fixtures and new mode routing tests.

## Steps

1. Trace current autonomous and controlled producers, claim/retry/permit and callback paths; add failing integration-shaped regression tests.
2. Consume the centralized mode service rather than duplicate Settings parsing.
3. Assert the selected mode inside the same Serializable transaction as new work/claim/authorization, sharing Settings locks with switches.
4. Keep outcome reporting, recovery and quota settlement available after capability pauses; keep controlled roots excluded from autonomous callbacks and resubmissions.
5. Project organization mode to protocol and sending context without treating PAUSED or read failures as autonomous.
6. Update deterministic fixtures with explicit mode configuration; run focused tests and full backend suite/type checks.

## Acceptance

Concurrent switch versus claim/enqueue/permit has no cross-mode authorization. Controlled roots, unknown outcomes, held quota and receipts remain immutable. Autonomous mode works for unconfigured organizations using current plugin routes. Paused outcomes settle once.

Historical browser replies with complete, current-claim-compatible
`NOT_SUBMITTED` proof remain content-quarantined but do not retain platform
writer occupancy in controlled mode. Independent polling and direct claims,
reservation and final authorization must proceed; the same old content must
remain non-enqueueable. Missing/stale proof, newer claims, uncertain or confirmed
receipts, API work and threads retain their guards.

## Dependencies

[Mode configuration](mode-configuration.md).

## Estimated Time

One implementation/review session plus integrated safety regression verification.

## Design Decisions Reference

See [plan.md](../plan.md) § Design Decisions: State Machine and Extension Protocol.


## Additional Admission Boundary

Wrap legacy server post/comment/plug/finisher platform writes with existing receipt-backed autonomousEffect admission. Persist AUTHORIZED before invoking the platform outside retryable transactions. Preserve UNKNOWN on errors/crash; immutable business keys, live Post provenance and unresolved-root checks prevent stale workflow snapshots or rescheduling from creating another send right. Administrators may audit pending receipts through the typed list/resolve API; NOT_SUBMITTED never automatically retries. Verify callbacks run once under concurrent retries and mode changes.
