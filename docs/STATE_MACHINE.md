# State Machine

## Session states
- `CREATED`
- `INVITED`
- `BOTH_JOINED`
- `CONSENT_PENDING`
- `CONSENTED`
- `SIDE_A_INTAKE`
- `SIDE_B_INTAKE`
- `READY_FOR_SYNTHESIS`
- `SYNTHESIS_COMPLETED`
- `READY_FOR_PROPOSAL`
- `PROPOSALS_GENERATED`
- `NEGOTIATION_IN_PROGRESS`
- `AGREEMENT_REACHED`
- `PARTIAL_AGREEMENT`
- `DEADLOCK`
- `ABANDONED`

Legacy reserved enum values still present for compatibility:
- `PROPOSAL_READY`
- `NEGOTIATION`
- `AGREEMENT`

## Participant intake states
- `NOT_STARTED`
- `IN_PROGRESS`
- `SUMMARY_PENDING_CONFIRMATION`
- `COMPLETED`

## Core transitions
1. `create_session`
- from: none
- to: `INVITED`

2. `join_by_invite`
- from: `INVITED`
- to: `CONSENT_PENDING`
- rejects: invalid/expired token, duplicate join, invalid state

3. `grant_consent`
- from: `CONSENT_PENDING`
- to: `CONSENT_PENDING` (first consent) or `CONSENTED` (both consented)

4. `resume_intake`
- session from: `CONSENTED`, `SIDE_A_INTAKE`, `SIDE_B_INTAKE`
- intake from: `NOT_STARTED`/`IN_PROGRESS`
- intake to: `IN_PROGRESS`

5. `submit_intake_field`
- intake from: `IN_PROGRESS` or `SUMMARY_PENDING_CONFIRMATION` (edit before confirmation)
- intake to: `IN_PROGRESS` or `SUMMARY_PENDING_CONFIRMATION`

6. `confirm_summary`
- intake from: `SUMMARY_PENDING_CONFIRMATION`
- intake to: `COMPLETED`
- guard: exact generated summary match

7. `reopen_intake`
- intake from: `COMPLETED`
- intake to: `IN_PROGRESS`

8. intake completion impact
- only A complete -> session `SIDE_B_INTAKE`
- only B complete -> session `SIDE_A_INTAKE`
- both complete -> session `READY_FOR_SYNTHESIS`

9. `run_synthesis`
- from: `READY_FOR_SYNTHESIS`
- to: `SYNTHESIS_COMPLETED` then `READY_FOR_PROPOSAL`
- guard: both participant intakes completed + summaries confirmed

10. `generate_proposals`
- from: `READY_FOR_PROPOSAL`
- to: `PROPOSALS_GENERATED`
- writes versioned `ProposalSet`

11. `submit_negotiation_actions`
- from: `PROPOSALS_GENERATED` or `NEGOTIATION_IN_PROGRESS`
- to: `NEGOTIATION_IN_PROGRESS` or terminal states
- allowed actions only: `ACCEPT`, `REJECT`, `SELECT_PREFERRED`, `SUGGEST_EDIT`

12. terminal outcomes
- `AGREEMENT_REACHED`: both accept same variant
- `PARTIAL_AGREEMENT`: subset convergence with unresolved clauses
- `DEADLOCK`: full rejection or repeated conflicting edit rounds
- `ABANDONED`: inactivity timeout

## Transport-level protocol rules (Phase 6)
- Telegram and HTTP do not mutate state directly; they call application services only.
- Every transport action is wrapped in idempotent execution.
- Duplicate transport submissions resolve to `NO_OP` with stable response.
- Unauthorized participant actions are rejected before state transition checks.
- Every transport-triggered action is persisted as `ProtocolEvent` with outcome and version metadata when available.

## Invariants
- Invalid transitions return typed errors and do not mutate state.
- No cross-session or cross-participant transport access.
- Raw intake artifacts stay private to owning participant.
- Synthesis/proposal/negotiation layers do not consume raw intake text.
