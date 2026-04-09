# Scenarios

## Implemented phase scenarios
1. Party A starts mediation and receives invite token.
2. Party B joins with valid token.
3. Party B fails to join with invalid token.
4. Party B fails to re-join after already joining.
5. Both parties provide consent; session becomes `CONSENTED`.
6. Consent command fails for unknown session.

## Deferred scenarios
1. Resumable private intake per participant.
2. Synthesis after both intakes complete.
3. Proposal round accept/reject/edit loop.
4. Terminal outcomes (`AGREEMENT`, `PARTIAL_AGREEMENT`, `DEADLOCK`, `ABANDONED`).
