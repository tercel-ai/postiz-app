# Documentation and Verification

## Goal

Publish an implementation-aligned detailed design and API/front-end/plugin integration instructions, and verify the completed safety boundaries freshly.

## Files Involved

- `docs/organization-sending-modes.md`
- Existing backend API, account binding/optional identity and Engage guides.
- `../aisee-app/docs/aisee-app-multi-node-integration.md` and detailed reference.
- Independent extension user/debug documentation.
- Planning overview/state and acceptance evidence.

## Steps

1. Align mode names, defaults, Settings/environment precedence, exact endpoint bodies/responses and permission rules with implemented code.
2. Document explicit safe-switch blockers, conservative legacy Engage draft handling, retained root history, no automatic resend/downgrade and manual rollout drain.
3. Update flowcharts and cross-repository links; distinguish current plugin autonomous transport from an old plugin version.
4. Run fresh full allowed test suites, scoped backend TypeScript and independent extension checks/builds; report exact pass/fail/skipped counts.
5. Reconcile every P0 acceptance criterion with a named passing regression test. Disclose absent real PostgreSQL/Redis concurrency proof.
6. Validate local links/JSON examples; preserve frozen-directory and no-direct-database restrictions. Do not deploy or send live social content.

## Acceptance

No stale claim that environment capability enrolls every organization. Docs accurately show current API, explicit opt-in and safe downgrade. Tests/checks have fresh successful evidence with skipped infrastructure limitations reported.

## Dependencies

[Backend routing](backend-routing.md), [Extension negotiation](extension-negotiation.md).

## Estimated Time

One documentation/verification session after implementation is integrated.

## Design Decisions Reference

See [plan.md](../plan.md) § Design Decisions: all records.
