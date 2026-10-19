# Node identity and backend API review — 2026-10-19

Scope: postiz-app extension node register/list/save APIs, session reporting, scoped execution authentication, and the standalone `../aisee-browser-extension` identity/pairing/native persistence integration. The frozen `apps/extension/` directory was excluded. The requested code-forge:review skill was unavailable, so this was a manual review of security, naming, tests, dead code, documentation and cross-repository contracts.

## Findings reproduced and fixed

| Severity | Finding before this review | Fix and regression evidence |
| --- | --- | --- |
| P2 | The native state was written as UTF-8 but read with the OS default encoding. A non-UTF-8 Windows locale could corrupt or fail to decode a Chinese profile path, preventing identity resolution/recovery. | Explicit UTF-8 for native state/config reads and installer text I/O. A temporary Chinese profile survives a simulated cp1252 default reader. No real machine identifier is read in this test. |
| P2 | Idempotent redemption of an old pairing code returned its receipt token even after a later `--replace` had revoked that token. Options could report successful pairing with an unusable credential. | Receipt replay must still match the current binding's token hash; a superseded receipt is rejected. The machine/profile is also revalidated before replay. Lost-acknowledgement replay of the current pairing remains supported. |
| P2 | Native writeState protected requestId/nodeToken/sequence but allowed an already persisted full registrationRequest to change or disappear. A subsequent retry could change the backend registration fingerprint. | Once present, the registration snapshot is immutable. Initial snapshot creation and first credential attachment remain allowed. A test rejects changed version/removed snapshot and verifies successful token attachment. |
| P2 | Empty-platform heartbeats returned before the backend receipt and out-of-order checks. A replay could refresh lastSeenAt, conflicting payloads could reuse a sequence, and a heartbeat without metadata did not advance lastReportSequence. | Empty and non-empty reports share the same receipt, sequence check, CAS and transaction. Identical replay returns its original result without refreshing online time; altered replay and unseen lower sequences fail. Empty reports still do not modify platform sessions or extend identity verification. |

Each regression failed against the pre-fix implementation, then passed after the fix. Removed the unused native host `io` import. No new public API, schema change or migration was necessary.

## Contract checks

- Public nodeId is one lowercase 64-character SHA-256 digest across plugin registration, backend DTO/service, headers, list/save projections and claim responses. Random UUIDs remain request IDs/internal keys, not the public node identity. Its exact material is the app domain, machine source/value, explicit browser family and canonical profile path.
- The backend unique key and authentication scope remain `(organizationId, registeredByUserId, nodeId)`. Aisee JWT/membership and the scoped nodeToken are required; knowing nodeId is insufficient. Sessions, receipts and SendExecution link the internal scoped row ID. A different account with the same public digest and an execution lease cannot take over another account's execution.
- register/save use POST; list uses GET. Existing session POST and PATCH share one implementation. Requests without node/protocol/sequence fields retain legacy handling. Unmanaged default-off LEGACY sending needs no native host or pairing. An enrolled scope does not fall back to legacy.
- Local writes retain native-first persistence, exact sequence acknowledgement, local readback, independent account scopes and the registration response owner/organization check. Backend registration does not recover credentials from a public digest, and the short original-request replay window remains in force.
- Pairing messages are accepted only from the extension's own Options page, excluding incognito. UI responses do not expose bindingToken/nodeToken. Raw machine IDs and profile paths do not go to node registration/session APIs. The native RPC allowlist does not expose arbitrary shell or filesystem operations.
- Reinstall recovery restores the same digest and current scope's original credential/sequence only if the private native backup remains. It does not reconstruct a deleted submit journal, clear UNKNOWN/account locks/quota holds or grant another content submission.

## Verification

Final checks on Node 22.22.0:

| Check | Result |
| --- | --- |
| Full backend workspace Vitest, frozen directory excluded | 4,115 passed, 0 failed, 96 existing skipped; 268 files passed, 4 skipped |
| Full standalone extension Vitest | 2,635 passed, 0 failed, 0 skipped; 179 files passed |
| Full native Python unittest suite | 37 passed, 0 failed, 0 skipped |
| Backend, orchestrator and extension TypeScript | Passed |
| Chrome and Firefox builds | Passed into temporary directories; nativeMessaging remains optional |
| Backend node service focused V8 coverage | Lines 97%, branches 82.48%, functions 100% |
| Native Python branch-inclusive coverage, test files excluded | Host 91%, installer 93%; combined 92% |
| Both repository diff whitespace checks | Passed |

Logs are under `/tmp/aisee-node-review-20261019/`. Test fixtures use temporary local files, mocked registry/machine probes, browser/DOM doubles and in-memory database transactions. Tests do not prove actual browser/OS installation or PostgreSQL concurrency semantics.

## Remaining deployment acceptance

The profile path is user-confirmed configuration, not automatic proof of the caller's browser profile. Wrong but valid manual profile selection cannot always be detected. Arc requires an explicitly verified native-host discovery location. Windows native communication/ACLs, real multi-browser upgrade/reinstall behavior and database concurrency remain target-environment acceptance work. A profile-directory move or machine-anchor change can change nodeId; Linux machine-id is an OS-installation anchor. Cloned machine identifiers and identical paths can duplicate a digest.

The source-only local helper still requires Python and manual user-level installation/pairing. Missing all credential backups or exceeding the initial registration replay window requires review rather than rotating a token from nodeId alone. These existing limits are not claimed as resolved by this review.

No database connection, SQL/migration execution, real host installation or social-platform mutation was performed.
