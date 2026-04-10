# Ladno / Deal

Telegram-first backend for deterministic two-party mediation.

## What this is
- Structured protocol, not a generic chatbot.
- State-machine driven: session -> consent -> private intake -> synthesis -> proposals -> negotiation.
- Strict privacy boundaries: no cross-party raw intake message exposure.

## Stack
- TypeScript / Node.js
- Fastify (HTTP adapter)
- grammY (Telegram adapter)
- PostgreSQL + Prisma
- pnpm
- Vitest

## Implemented (through Phase 7)
- Deterministic domain protocol for session, intake, synthesis, proposal, negotiation.
- Thin Telegram/HTTP transports wired 1:1 to application services.
- Transport idempotency + audit trail (`IdempotencyRecord`, `ProtocolEvent`).
- Transport hardening:
  - action rate limiting (join brute-force + action spam + invalid command spam)
  - outbound Telegram retry/backoff for transient delivery failures
  - correlation ID propagation (`x-correlation-id` / Telegram update correlation)
  - structured protocol and transport logging without private raw text
- Concurrency and replay-focused integration tests.
- Real Postgres integration suite (enabled when `TEST_DATABASE_URL` is set).

## Local setup
1. Copy env:
   - `cp .env.example .env`
2. Install dependencies:
   - `corepack pnpm install`
3. Start Postgres:
   - `docker compose up -d postgres`
4. Generate Prisma client:
   - `corepack pnpm prisma generate`
5. Apply migrations:
   - `corepack pnpm prisma:deploy`
6. Start app:
   - `corepack pnpm dev`

## Migration verification workflow
Fresh bootstrap verification:
1. `docker compose up -d postgres`
2. `corepack pnpm prisma:deploy`
3. `corepack pnpm prisma:status`

Predictable reset workflow (local/dev DB):
1. `corepack pnpm prisma migrate reset --force --skip-generate --skip-seed`
2. `corepack pnpm prisma:deploy`

## Testing
- Full suite:
  - `corepack pnpm test`
- Build check:
  - `corepack pnpm build`
- Postgres runtime suite:
  - `TEST_DATABASE_URL=postgresql://deal:deal@localhost:5432/deal?schema=public corepack pnpm test:postgres`

## Runtime protections (current thresholds)
- Join/invite brute-force: `8 requests / 60s` per participant.
- General protocol actions: `30 requests / 60s` per participant/session.
- Invalid Telegram command spam: `10 commands / 60s` per participant.

## Telegram UX (default)
- `/start` opens guided flow with buttons:
  - `Создать договорённость`
  - `Присоединиться по приглашению`
  - `Посмотреть мой статус`
- Invite supports deep links: `https://t.me/<bot>?start=join_<token>`
- Consent supports button flow (`Подтвердить участие`) without manual `session_id` typing.

## Telegram debug commands
- `/start`
- `/create_session`
- `/join_session <invite_token>`
- `/give_consent <session_id>`
- `/resume_intake <session_id>`
- `/confirm_summary <session_id>`
- `/reopen_intake <session_id>`
- `/generate_proposals <session_id>`
- `/select_preferred <session_id> <BALANCED|A_LEANING|B_LEANING>`
- `/accept_proposal <session_id> <BALANCED|A_LEANING|B_LEANING>`
- `/reject_proposal <session_id> <BALANCED|A_LEANING|B_LEANING>`
- `/suggest_edit <session_id> <variant> <clause_id> <operation> [proposed_value]`

## Docs
- [`docs/PRD.md`](./docs/PRD.md)
- [`docs/STATE_MACHINE.md`](./docs/STATE_MACHINE.md)
- [`docs/DATA_MODEL.md`](./docs/DATA_MODEL.md)
- [`docs/TRANSPORT_SPEC.md`](./docs/TRANSPORT_SPEC.md)
- [`docs/API_SPEC.md`](./docs/API_SPEC.md)
- [`docs/VISIBILITY_MATRIX.md`](./docs/VISIBILITY_MATRIX.md)
- [`docs/OPS_NOTES.md`](./docs/OPS_NOTES.md)
- [`docs/LOCAL_RUNTIME_RUNBOOK.md`](./docs/LOCAL_RUNTIME_RUNBOOK.md)
