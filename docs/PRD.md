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
- Structured synthesis output:
  - shared_goals
  - overlapping_interests
  - conflicting_points
  - constraints_matrix
  - non_negotiables_conflicts
  - potential_agreement_zones
  - risk_areas

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
- proposal generation
- negotiation loop and final outcomes automation
