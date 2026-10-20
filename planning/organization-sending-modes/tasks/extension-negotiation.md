# Extension Negotiation

## Goal

Let the latest independent browser extension use either organization mode with safe backend negotiation and visible diagnostics.

## Files Involved

- `../aisee-browser-extension/src/utils/coordinated/` protocol, session and runtime modules.
- Existing extension autonomous routing/backend calls and durable execution journal.
- Existing Options node identity/diagnostic components and related tests/docs.

## Steps

1. Read independent extension instructions and mode negotiation/session/journal paths; do not read the frozen monorepo extension directory.
2. Add failing tests for explicit autonomous permission, pause/failure denial, active journal recovery and organization mismatch.
3. Consume new protocol fields; retain existing controlled locks and journal outcome recovery. Never interpret request failure or missing fields as downgrade permission.
4. Add administrator mode controls backed by authenticated GET/POST mode API with stable request IDs and revision conflicts.
5. Surface registration HTTP status and allowlisted errors; never expose JWT/node token/keys or trigger live social sends while debugging.
6. Run full independent extension tests/type checks and requested Chrome/Firefox builds; document reload and worker drain requirements.

## Acceptance

Current plugin supports explicit AUTONOMOUS and CONTROLLED, rejects ambiguous mode, preserves pending execution journal, and displays authoritative mode/registration failures without credentials. Mode switch controls respect backend `canManage`.

## Dependencies

[Mode configuration](mode-configuration.md); coordinate protocol projection with [Backend routing](backend-routing.md).

## Estimated Time

One implementation and regression session, followed by integrated build verification.

## Design Decisions Reference

See [plan.md](../plan.md) § Design Decisions: Public API and Extension Protocol.

