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
