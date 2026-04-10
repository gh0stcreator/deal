# Ops Notes

## Runtime safety checks
- Use `x-correlation-id` on HTTP requests to trace actions.
- Use `x-idempotency-key` for retried POST actions.
- Monitor protocol outcomes through `ProtocolEvent` records.

## Failure handling model
- Protocol mutation and outbound Telegram delivery are decoupled.
- If Telegram send fails after mutation, replay of the same action is safe and idempotent.
- Duplicate/replayed actions are recorded as `NO_OP` protocol events.

## Suggested incident triage
1. Find action by `idempotencyKey` in `ProtocolEvent`.
2. Check whether outcome is `ACCEPTED`, `NO_OP`, or `ERROR`.
3. Confirm session state and proposal/round versions in the same event row.
4. If transport failed, replay with same idempotency key.

## Postgres verification checklist
1. `corepack pnpm prisma:deploy`
2. `corepack pnpm prisma:status`
3. `TEST_DATABASE_URL=... corepack pnpm test:postgres`
