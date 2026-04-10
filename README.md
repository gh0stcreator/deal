# Ladno / Deal

Telegram-first AI mediation backend for structured two-party conflict resolution.

## What this is
- Not a generic chatbot.
- A deterministic mediation workflow engine with Telegram transport adapters.
- Current implementation covers Foundation + Session/Invite/Join/Consent + deterministic private intake + structured synthesis + deterministic proposal generation (Phase 4 baseline).

## Stack
- TypeScript (Node.js)
- Fastify (HTTP)
- grammY (Telegram bot)
- PostgreSQL + Prisma
- pnpm
- Vitest (unit + integration)

## Implemented now
- Project skeleton with domain/application/infrastructure boundaries.
- Explicit domain state machine scaffold with MVP and future states.
- Session creation flow.
- Invite token generation (hashed + expiry).
- Party B join flow.
- Explicit consent flow for both parties.
- Participant-level deterministic intake state machine.
- Resumable intake with strict field order and optimistic-concurrency protection.
- Summary generation + explicit confirmation gate.
- Privacy-preserving synthesis service using only confirmed normalized models.
- Versioned `MediationSummary` persistence with fixed structured schema.
- Deterministic proposal generation from `MediationSummary` only.
- Versioned `ProposalSet` with exactly 3 variants (`BALANCED`, `A_LEANING`, `B_LEANING`).
- Proposal validation checks (schema completeness, contradiction guardrails, fallback requirements).
- Prisma schema + initial SQL migration.
- Fastify health + session create endpoint.
- grammY command bootstrap (`/start_mediation`, `/join`, `/consent`).
- Unit + integration tests for critical Phase 1-4 paths.

## Not implemented yet
- Participant accept/reject/edit proposal loop.
- Negotiation rounds and terminal outcome automation.

## Local setup
1. Copy env file:
   - `cp .env.example .env`
2. Install dependencies:
   - `corepack pnpm install`
3. Start Postgres:
   - `docker compose up -d postgres`
4. Generate Prisma client:
   - `corepack pnpm prisma generate`
5. Apply migrations:
   - `corepack pnpm prisma migrate deploy`
6. Start service:
   - `corepack pnpm dev`

HTTP health:
- `GET http://localhost:3000/health`

## Useful commands
- Build: `corepack pnpm build`
- Test: `corepack pnpm test`
- Prisma studio: `corepack pnpm prisma studio`

## Telegram commands (MVP)
- `/start_mediation` — create session and receive invite token.
- `/join <invite_token>` — join as second party.
- `/consent <session_id>` — provide explicit consent.

## Assumptions
- Invite tokens expire after 72 hours.
- Session creator is always Party A.
- Each session supports exactly two participants in MVP.
- Bot text is intentionally minimal and neutral; content templates will evolve later.

## Repository docs
See [docs/PRD.md](./docs/PRD.md), [docs/STATE_MACHINE.md](./docs/STATE_MACHINE.md), and [docs/DATA_MODEL.md](./docs/DATA_MODEL.md).
