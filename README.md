# Ladno / Deal

Telegram-first AI mediation backend for deterministic two-party conflict resolution.

## Product scope
- Not a generic chatbot.
- Structured protocol: session -> consent -> private intake -> synthesis -> proposal variants -> negotiation rounds -> terminal outcome.
- Strict privacy boundary: no raw private participant messages are exposed cross-party.

## Stack
- TypeScript / Node.js
- Fastify (HTTP adapter)
- grammY (Telegram adapter)
- PostgreSQL + Prisma
- pnpm
- Vitest (unit + integration)

## Implemented (through Phase 6)
- Explicit session and participant state machines.
- Session create/invite/join flow.
- Dual explicit consent flow.
- Deterministic private intake workflow with summary confirmation gate and reopen support.
- Privacy-preserving synthesis from confirmed normalized models only.
- Deterministic proposal generation (exactly 3 variants).
- Deterministic negotiation protocol (accept/reject/select/suggest-edit, versioned rounds/sets, terminal outcomes).
- Thin transport wiring for Telegram + HTTP over the same application services.
- Transport idempotency and protocol audit events.

## Not implemented yet
- Reminder/notification strategy.
- Rich conversational UX.
- Advanced analytics/dashboard.

## Local setup
1. Copy env:
   - `cp .env.example .env`
2. Install dependencies:
   - `corepack pnpm install`
3. Start DB:
   - `docker compose up -d postgres`
4. Generate Prisma client:
   - `corepack pnpm prisma generate`
5. Run migrations:
   - `corepack pnpm prisma migrate deploy`
6. Start app:
   - `corepack pnpm dev`

## Commands
- Run tests: `corepack pnpm test`
- Build: `corepack pnpm build`
- Prisma Studio: `corepack pnpm prisma studio`

## Transport usage
### Telegram commands
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

### HTTP
- `GET /health`
- Session/intake/proposal/negotiation endpoints documented in [`docs/API_SPEC.md`](./docs/API_SPEC.md).

## Documentation
- [`docs/PRD.md`](./docs/PRD.md)
- [`docs/STATE_MACHINE.md`](./docs/STATE_MACHINE.md)
- [`docs/DATA_MODEL.md`](./docs/DATA_MODEL.md)
- [`docs/TRANSPORT_SPEC.md`](./docs/TRANSPORT_SPEC.md)
- [`docs/API_SPEC.md`](./docs/API_SPEC.md)
