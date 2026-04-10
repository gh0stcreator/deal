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
- `PROPOSAL_READY` (legacy reserved state, not used in current orchestration)
- `NEGOTIATION` (legacy reserved state, not used in current orchestration)
- `AGREEMENT` (legacy reserved state, not used in current orchestration)

## Participant intake states (implemented)
- `NOT_STARTED`
- `IN_PROGRESS`
- `SUMMARY_PENDING_CONFIRMATION`
- `COMPLETED`

## Implemented transitions
1. `create_session` by Party A
- from: none
- to: `INVITED`
- failure: n/a

2. `join_by_invite` by Party B
- from: `INVITED`
- to: `CONSENT_PENDING`
- failures: invalid token, expired token, duplicate participant, invalid state

3. `grant_consent` by each participant
- from: `CONSENT_PENDING`
- to: `CONSENT_PENDING` (first consent) or `CONSENTED` (second consent)
- failures: participant missing, duplicate consent, invalid state

4. `start_or_resume_intake` by participant
- from session: `CONSENTED`, `SIDE_A_INTAKE`, `SIDE_B_INTAKE`
- participant intake: `NOT_STARTED` -> `IN_PROGRESS` or `IN_PROGRESS` -> `IN_PROGRESS`
- failure: participant not in session, invalid session state

5. `submit_intake_field`
- from participant intake: `IN_PROGRESS` (or edit while `SUMMARY_PENDING_CONFIRMATION`)
- to participant intake: `IN_PROGRESS` or `SUMMARY_PENDING_CONFIRMATION`
- failures: field order violation, empty content, stale version conflict, invalid state

6. `generate_or_regenerate_summary`
- from participant intake: `IN_PROGRESS` or `SUMMARY_PENDING_CONFIRMATION`
- to: `SUMMARY_PENDING_CONFIRMATION`
- guard: all required fields must be present

7. `confirm_summary`
- from participant intake: `SUMMARY_PENDING_CONFIRMATION`
- to: `COMPLETED`
- guard: exact summary match
- failures: summary mismatch, invalid state

8. `reopen_intake`
- from participant intake: `COMPLETED`
- to: `IN_PROGRESS`
- purpose: allow post-confirmation edits only via explicit action

9. Session intake progression
- when only Party A completed -> `SIDE_B_INTAKE`
- when only Party B completed -> `SIDE_A_INTAKE`
- when both completed -> `READY_FOR_SYNTHESIS`

10. `run_synthesis`
- from session: `READY_FOR_SYNTHESIS`
- preconditions:
  - both participant intakes are `COMPLETED`
  - both confirmed summaries exist
  - both confirmed normalized models include all required fields
- output: versioned `MediationSummary`
- control-flow note: synthesis orchestration is deterministic; LLM (or mapper) is used only for structured mapping, not branching

11. `mark_synthesis_completed`
- from session: `READY_FOR_SYNTHESIS`
- to: `SYNTHESIS_COMPLETED`
- failure: invalid state transition

12. `mark_ready_for_proposal`
- from session: `SYNTHESIS_COMPLETED`
- to: `READY_FOR_PROPOSAL`
- failure: invalid state transition

13. `generate_proposals`
- from session: `READY_FOR_PROPOSAL`
- preconditions:
  - latest `MediationSummary` exists
  - summary contains all required structured fields
- output: versioned `ProposalSet` with exactly 3 variants
- to: `PROPOSALS_GENERATED`
- failures:
  - summary missing/incomplete
  - invalid proposal schema
  - invalid state transition

14. `submit_negotiation_actions`
- from session: `PROPOSALS_GENERATED` or `NEGOTIATION_IN_PROGRESS`
- first submission in a session moves state to `NEGOTIATION_IN_PROGRESS`
- strict allowed actions:
  - `ACCEPT` (variant-level)
  - `REJECT` (variant-level)
  - `SELECT_PREFERRED` (variant-level)
  - `SUGGEST_EDIT` (clause-level structured operations only)
- each finalized round creates a new `ProposalSet` version unless a terminal outcome is reached by direct accept/reject rule

15. `round_resolution_rules` (deterministic)
- `AGREEMENT_REACHED`:
  - both participants submit `ACCEPT` for the same variant
- `PARTIAL_AGREEMENT`:
  - both align on preferred variant and subset clause convergence is detected while unresolved clauses remain
- `DEADLOCK`:
  - both reject all variants in the same round
  - or conflicting structured edit rounds hit threshold (`3`)
- `ABANDONED`:
  - inactivity timeout over open protocol window

16. `version_lineage`
- every non-terminal negotiation iteration persists a new `ProposalSet` version
- lineage fields:
  - `parentProposalSetVersion`
  - `derivedFromRoundNumber`
- no in-place mutation of proposal payloads

## Invariants
- Invalid transitions return typed domain errors and do not mutate state.
- Participant intake is isolated by `(sessionId, participantId)`.
- Raw participant messages never leave participant scope in intake service APIs.
- Synthesis service consumes only confirmed normalized models and never reads raw intake messages.
- Proposal service consumes only `MediationSummary` and never reads raw messages, assistant prompts, or participant intake artifacts.
- Negotiation service consumes only proposal-layer data (`ProposalSet` + structured actions) and never accesses intake/raw artifacts.
