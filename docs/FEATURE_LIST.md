# Feature List

## Implemented
- [x] Session creation
- [x] Invite token generation + expiry
- [x] Second-party join by token
- [x] Invalid token / expired token handling
- [x] Duplicate join handling
- [x] Explicit dual consent
- [x] Deterministic participant intake state machine
- [x] Summary confirmation gate + resumable intake
- [x] Deterministic synthesis from confirmed normalized models only
- [x] Versioned mediation summaries
- [x] Deterministic proposal generation from mediation summary only
- [x] Versioned proposal sets with 3 variants
- [x] Deterministic negotiation rounds + outcomes
- [x] Clause-level structured edit protocol
- [x] Telegram command transport for protocol actions
- [x] HTTP parity endpoints for protocol actions
- [x] Transport idempotency handling
- [x] Protocol audit/event persistence
- [x] Unit + integration tests including transport idempotency/privacy wiring
- [x] Concurrency/race-condition transport tests
- [x] Telegram outbound retry/backoff guardrails
- [x] Transport rate limiting
- [x] Correlation ID propagation and tracing support
- [x] Real Postgres runtime integration test suite (env-gated)
- [x] Visibility matrix documentation

## Deferred
- [ ] Reminder/notification workflow
- [ ] Rich conversational UX
- [ ] Analytics/admin dashboard
