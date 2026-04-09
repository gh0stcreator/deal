# State Machine

## States
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

## Future transitions (scaffold only)
- intake progression to `SIDE_A_INTAKE` / `SIDE_B_INTAKE`
- synthesis to `READY_FOR_SYNTHESIS`
- proposal readiness and negotiation
- terminal outcome transitions

## Invalid transition rule
Any unsupported transition must return a typed domain error and keep session unchanged.
