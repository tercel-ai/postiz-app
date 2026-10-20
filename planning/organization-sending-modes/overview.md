# Organization Sending Modes

## Overview

Organization administrators explicitly choose autonomous plugin sending or controlled multi-node sending under the system capability. Existing controlled obligations prevent unsafe downgrade.

## Scope

Backend routing/configuration, current standalone extension, API and frontend integration documentation. No aisee-app UI implementation, frozen extension, DB writes, migrations, or live sends.

## Technology Stack

TypeScript, NestJS, Prisma/PostgreSQL, browser extension React, Vitest.

## Task Execution Order

| # | Task File | Description | Status |
| --- | --- | --- | --- |
| 1 | [Mode configuration](tasks/mode-configuration.md) | Typed settings, safety locks and receipts | Completed |
| 2 | [Backend routing](tasks/backend-routing.md) | Producers, claims, authorization and settlement | Completed |
| 3 | [Extension negotiation](tasks/extension-negotiation.md) | Mode, journal and Options diagnostics | Completed |
| 4 | [Documentation and verification](tasks/documentation-verification.md) | Guides, regression and production checks | Completed |

## Progress

4 total, 4 completed, 0 in progress, 0 pending. See state.json for authoritative status.

## Reference Documents

[Specification and API](../../docs/organization-sending-modes.md), [Implementation plan](plan.md), [verification evidence](verification.md).
