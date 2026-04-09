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
- `PROPOSAL_READY`
- `NEGOTIATION`
- `AGREEMENT`
- `PARTIAL_AGREEMENT`
- `DEADLOCK`
- `ABANDONED`

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

## Invariants
- Invalid transitions return typed domain errors and do not mutate state.
- Participant intake is isolated by `(sessionId, participantId)`.
- Raw participant messages never leave participant scope in intake service APIs.
