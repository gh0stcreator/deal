# Product Requirements (MVP)

## Goal
Help two parties resolve conflicts through private structured intake, neutral synthesis, and mediated proposal options.

## Actors
- Party A
- Party B
- System mediator (Ladno)

## Core principles
- Private by default.
- Structured mediation over free-form chat.
- Neutral framing and de-escalation.
- Deterministic state machine controls progression.

## Implemented now
- Session creation
- Invite/join
- Explicit consent capture
- Deterministic resumable private intake engine per participant
- Mandatory summary confirmation gate before intake completion
- Deterministic synthesis layer using only confirmed normalized models
- Deterministic proposal generation layer consuming only versioned `MediationSummary`
- Deterministic negotiation protocol layer on top of `ProposalSet`
- Structured synthesis output:
  - shared_goals
  - overlapping_interests
  - conflicting_points
  - constraints_matrix
  - non_negotiables_conflicts
  - potential_agreement_zones
  - risk_areas
- Structured proposal output per variant:
  - title
  - summary
  - clauses[] (`clause_id`, `topic`, `clause_text`, `rationale`, `tradeoff_notes`)
  - unresolved_points[]
  - risk_notes[]
  - review_window
  - fallback_if_broken
- Exactly three variants:
  - BALANCED
  - A_LEANING
  - B_LEANING
- Negotiation action protocol (strict set):
  - ACCEPT (variant-level)
  - REJECT (variant-level)
  - SELECT_PREFERRED (variant-level)
  - SUGGEST_EDIT (clause-level structured edit only)
- Deterministic resolution outcomes:
  - AGREEMENT_REACHED (both accept same variant)
  - PARTIAL_AGREEMENT (subset converges, unresolved points remain)
  - DEADLOCK (full rejection or repeated conflicting edits)
  - ABANDONED (inactivity timeout)

## Current intake fields
- facts
- interpretations
- interests
- constraints
- boundaries
- desired_outcome
- acceptable_concessions
- non_negotiables

## Deferred
- Telegram command handlers for negotiation actions
- reminder/notification delivery
