## Forbidden Directories

- `apps/extension/` is frozen and no longer under development.

- Do not read, modify, or review any files under this directory.

- If a task specifically targets `apps/extension/`, inform the user that this directory is frozen and do not proceed in that directory. This restriction does not freeze backend extension APIs or the active standalone `../aisee-browser-extension` repository.

## Forbidden Operations: Direct Database Writes

- Never run `pnpm prisma-db-push` (or `prisma db push`/`prisma db execute` in any form), and never execute any SQL statement directly against a database — not even one that looks purely additive (e.g. adding a nullable column).

- This is not a style preference. `db push` reconciles the *entire* connected database to match `schema.prisma`, and with `--accept-data-loss` it does so without pausing for confirmation — any table `schema.prisma` doesn't define reads as "extra" and gets dropped. This has already happened once: a routine, seemingly-safe `db push` (adding three nullable columns to `Integration`) dropped 15 real, non-empty tables — `users`, `actions`, `tasks`, `transactions`, `credit_balances` and more, tens of thousands of rows — belonging to a completely different service.

- **The reason it reached the wrong tables: `DATABASE_URL` in `.env` pointed at another service's database.** This repo's data lives in `aisee_postiz_dev`. `aisee_dev` belongs to aisee-core (a separate Python/SQLAlchemy service, tables `users`/`actions`/`tasks`/`products`/`credit_*`/`transactions`/…). The local `.env` was pointed at `aisee_dev`, so `db push` faithfully reconciled aisee-core's database to postiz's schema: it dropped every aisee-core table and created postiz's tables there empty. Before running anything that touches a database from this repo, confirm which database the connection actually resolves to — `prisma` prints it (`Datasource "db": PostgreSQL database "…"`), and `SELECT current_database()` answers it directly. If it is not `aisee_postiz_dev`, stop and tell the user the `.env` is misconfigured.

- Schema changes may only reach the database through: (a) the user running the command themselves, or (b) the project's own deployment/migration pipeline. An agent's job stops at preparing the code — the updated `schema.prisma`, a migration SQL file under `libraries/nestjs-libraries/src/database/prisma/migrations/` documenting the change — and then explicitly telling the user what needs to be applied and how, never applying it itself.

- This applies regardless of which database the task is aimed at (dev, staging, or otherwise) and regardless of how low-risk the specific schema change looks in isolation.

## Architecture Understanding and Minimal Necessary Changes

- **Understand the existing architecture before changing any feature code.** Read the relevant architecture/flow documents, affected implementation and actual callers. Identify responsibilities, data flow, state meanings and API contracts; trace the complete flow across repositories where applicable. Names, UI symptoms, chat summaries and passing mocks are not sufficient evidence that a capability is missing.
- **Solve within the existing architecture first.** Before editing, briefly explain the current flow, root cause, reusable mechanisms and why the proposed change is the minimum necessary. Check existing entry points, scheduling rules, markers, fields, states, components and helpers before introducing another path.
- **Do not add unnecessary design when existing mechanisms reasonably solve the requirement.** This includes states/enums, database tables or fields, persistent cursors, APIs, separate queues, compatibility branches and abstraction layers. A priority difference, display difference or temporary processing phase does not by itself justify a new business state or persistent structure. For example, Post Now is priority within the existing Post queue: prefer its existing priority marker and unified discovery mechanism rather than another claim cursor.
- **Extend only after demonstrating that existing mechanisms cannot reasonably meet the current requirement.** Cite the implementation and alternatives inspected, explain why reuse is inadequate, and record the smallest extension's responsibility, callers, compatibility, migration and maintenance costs. Implementation convenience, speculative future needs and perceived completeness are not sufficient reasons. An unwired or defective existing capability is not an architectural gap.
- **Judge minimality by clear responsibilities, consistent semantics and maintainability.** Do not pile code into fewer files or add layers merely to claim reuse or decomposition. Preserve authorization, safety, idempotency, concurrency and recovery protections; bypassing them is not a valid simplification.
- **Check for unnecessary mechanisms before delivery.** Remove newly introduced code/configuration that the final solution no longer needs, including parallel implementations and unused states, fields or branches. Preserve existing functionality unless the user explicitly authorizes its removal. Explain the final reuse, any necessary additions and deployment/migration effects.

## Post and Reply State Changes

These rules are mandatory for changes affecting Post or Reply state, scheduling, Post Now, claim/admission, sending modes, account selection, retry, reconciliation, history, or status-dependent UI.

### Before changing code

- Read the relevant sections of the documents below and follow their references to API and state contracts. Read the affected implementation and its callers across all three repositories before editing; previous chat summaries, method names, UI labels, or passing mocks are not sufficient evidence of behavior.
- Explain the current flow and proposed transition before implementation: website action -> backend business record/SendIntent -> execution/segment -> extension journal -> platform result -> status/history response. Distinguish these state layers and identify which component owns each transition.
- Check both CONTROLLED and AUTONOMOUS, including mode handover, actual browser account selection, automation versus manual actions, Post versus Reply, platform pacing, and existing quota policy. Preserve CONTROLLED account verification and AUTONOMOUS current-session account behavior.
- Identify the affected APIs, request/response fields, allowedActions, timing reasons, and consumers. Trace authorization, lease/permit expiry, account occupancy, content deduplication, late outcomes, and recovery through their callees rather than changing one condition in isolation.
- Define concrete regression cases and the intended before/after behavior. If documents contradict the implementation or current user requirements, resolve and record that discrepancy before changing state semantics; do not silently invent a new business rule.

### During implementation and verification

- Keep temporary waiting/queued states distinct from failure, and distinguish an account occupancy lease from the original content's confirmation state. Expiring occupancy does not prove non-submission or authorize replay of the original content.
- Preserve the original business record and its audit evidence during recovery. Confirmed content must not be sent again; UNKNOWN must not be automatically replayed. An explicit user retry must use the documented recovery path and re-check current server decisions, account identity and pacing.
- Verify both modes and Post/Reply paths, including concurrency, restart, lost responses, expired authorization, late receipts, and mixed client/server versions when relevant. Do not bypass platform frequency limits to implement Post Now or retry.
- Add meaningful regressions for changed behavior and run the full permitted test suite after source-code changes. Report passed, failed, skipped and excluded tests, plus type-check results; do not present mocks as proof of live platform publication.

### After changing code

- Update the relevant state/flow/API documentation in every affected repository in the same change, including status meanings, timing, button behavior and deployment compatibility. Keep request/response contracts and user-facing state mappings aligned.
- Report the root cause, changed transitions, verification evidence, remaining issues or uncertainty, and any deployment or historical-record recovery steps. Clearly distinguish code/test verification from live browser or production verification.

### Required reference documents

- [Sending modes and handover](docs/organization-sending-modes.md)
- [Backend API ownership and contracts](docs/multi-node-sending-api-ownership.md)
- [Backend states and coordination flow](docs/multi-node-sending-before-after.md)
- [Extension journal, permits, results and recovery](../aisee-browser-extension/docs/account-bound-send-protocol.md)
- [Website actions and status consumers](../aisee-app/docs/multi-node-sending-before-after.md)
