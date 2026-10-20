# Mode Configuration

## Goal

Implement strict system capability and organization sending mode with safe switching and immutable idempotency receipts.

## Files Involved

- `libraries/nestjs-libraries/src/extension/send-mode.service.ts`
- `libraries/nestjs-libraries/src/extension/send-mode.dto.ts`
- `libraries/nestjs-libraries/src/extension/__tests__/send-mode*.spec.ts`
- `apps/backend/src/api/routes/send-mode.controller.ts`
- `apps/backend/src/admin-api/routes/admin-settings.controller.ts`
- `libraries/nestjs-libraries/src/database/prisma/settings/settings.service.ts`
- Existing database/API module provider and controller registration.

## Steps

1. Read existing policy, Settings, mutation receipts, transaction helper and sending schema; add mode/permission/blocker/replay tests before implementation.
2. Run focused tests and confirm missing behavior fails.
3. Implement strict Settings parsing, environment emergency stop, history-aware defaults, shared system/organization row locks and safe switch blockers.
4. Reuse existing receipts for organization and system mutations; preserve revision CAS and replay result.
5. Add typed authenticated routes; reject generic Settings writes/deletes for protected mode keys.
6. Run tests, refactor shared parsing/count logic, run type checks and provide exact API to routing and extension work.

## Acceptance

Named mode service/API tests cover default autonomous, controlled history pause, Settings precedence, corruption, permissions, stale/competing writes, immutable receipt replay, every downgrade blocker, conservative autonomous upgrade blockers, and protected Settings keys.

## Dependencies

None. Reuses existing Settings and receipt schema; no database operation.

## Estimated Time

One implementation and focused review session, followed by integrated verification.

## Design Decisions Reference

See [plan.md](../plan.md) § Design Decisions: Public API and State Machine.

