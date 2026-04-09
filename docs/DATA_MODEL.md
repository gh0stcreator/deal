# Data Model

## Implemented tables
### `MediationSession`
- `id`
- `state`
- `inviteTokenHash`
- `inviteTokenExpiresAt`
- `createdAt`
- `updatedAt`

### `SessionParticipant`
- `id`
- `sessionId`
- `role` (`PARTY_A`/`PARTY_B`)
- `telegramUserId`
- `consentGrantedAt`
- timestamps

## Enumerations
- `SessionState`
- `ParticipantRole`

## Deferred schema extensions
- `InviteToken` history table (for multi-invite lifecycle)
- `ConsentRecord` audit entries
- `IntakeResponse` raw entries (private)
- `IntakeNormalized` structured form
- `ProposalRound` and `ProposalDecision`
- `SessionEvent` audit log
