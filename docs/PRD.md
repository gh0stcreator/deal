# Product Requirements (MVP)

## Goal
Help two participants resolve conflict through private structured intake, neutral synthesis, deterministic proposal variants, and deterministic negotiation rounds.

## Core constraints
- Two parties only.
- Telegram-first.
- No raw cross-party message exposure.
- State machine driven progression.
- Deterministic control flow; LLM usage limited to mapping/normalization tasks.

## Implemented now (through Phase 6)
- Session/invite/join flow.
- Dual explicit consent.
- Resumable private intake with mandatory summary confirmation.
- Deterministic synthesis from confirmed normalized models only.
- Deterministic proposal generation from versioned `MediationSummary` only.
- Deterministic negotiation protocol with strict action set and terminal outcomes.
- Telegram command transport mapped 1:1 to application services.
- HTTP adapter parity for same protocol actions.
- Transport idempotency and protocol audit event persistence.
- Phase 7 hardening:
  - rate limiting and abuse protection in transport
  - correlation ID propagation through transport and protocol execution
  - outbound Telegram retry/backoff for transient send failures
  - concurrency and replay-focused transport tests
  - Postgres runtime integration test suite (env-gated)
- Minimal post-consent shared picture step:
  - built only from both confirmed participant problem statements
  - shared neutral 3-block synthesis text for both sides
  - private clarification capture (`Нет, нужно уточнить`) without auto re-synthesis
  - persisted synthesis review signals (`CONFIRM` / `CLARIFY`) for dogfood validation
  - debug synthesis review summary (`both_confirmed`, `one_confirmed_one_clarified`, `both_clarified`)

## Intake UX (current guided flow)
- Private intake is collected one focused question at a time.
- Each participant confirms every answer before moving to the next question.
- Guided mediation prompts collect:
  - what is happening now
  - main tension point
  - important need/interest
  - hard constraint
  - acceptable outcome
  - acceptable flexibility
- Answers remain private and are never shown raw to the other participant.

## Structured data fields
### Intake fields
- facts
- interpretations
- interests
- constraints
- boundaries
- desired_outcome
- acceptable_concessions
- non_negotiables

### Synthesis fields
- shared_goals
- overlapping_interests
- conflicting_points
- constraints_matrix
- non_negotiables_conflicts
- potential_agreement_zones
- risk_areas

### Proposal variant fields
- title
- summary
- clauses (`clause_id`, `topic`, `clause_text`, `rationale`, `tradeoff_notes`)
- unresolved_points
- risk_notes
- review_window
- fallback_if_broken

## Deferred
- Reminder/notification strategy.
- Rich conversational UX.
- Advanced analytics/admin tooling.
