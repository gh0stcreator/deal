# AGENTS.md

## Repo purpose
Build and maintain a production-minded Telegram-first AI mediation backend for two-party conflict resolution.

## Non-negotiable product rules
- Never expose one party's raw private text to the other party.
- Keep mediation neutral and structured.
- MVP is strictly two-party.
- No legal guarantees or enforcement.

## Engineering rules
- TypeScript first.
- Domain logic must remain deterministic and testable.
- Keep state transitions explicit in domain state machine modules.
- Transport layers (Telegram/HTTP) must not contain business rules.
- Keep prompts/config separate from domain logic.

## Delivery expectations
- Work in small vertical slices.
- Group commits logically.
- Update docs for behavior/schema/state changes.
- Prefer robust, simple architecture over abstraction-heavy design.

## Testing expectations
- Add/adjust tests for each non-trivial domain change.
- Cover happy path + key failure transitions.
- Ensure invalid state transitions are explicitly asserted.

## Do-not rules
- Do not build generic chat UX.
- Do not implement multi-party support unless explicitly requested.
- Do not invent behavior beyond documented spec; add TODOs instead.

## Done criteria
- Code compiles.
- Tests pass.
- State transitions are explicit and validated.
- Docs remain consistent with implementation.
