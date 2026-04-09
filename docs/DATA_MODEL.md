# Data Model

## Implemented session tables
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

## Implemented intake tables (Phase 2)
### `ParticipantIntake`
- `id`
- `sessionId`
- `participantId` (unique)
- `state` (`NOT_STARTED` / `IN_PROGRESS` / `SUMMARY_PENDING_CONFIRMATION` / `COMPLETED`)
- `currentField`
- `normalizedPositionJson` (confirmed downstream source)
- `generatedSummary`
- `summaryVersion`
- `version` (optimistic concurrency)
- `completedAt`
- timestamps

### `IntakeFieldAnswer`
- `intakeId`
- `field`
- `rawValue`
- `normalizedValue`
- `updatedAt`
- unique key: (`intakeId`, `field`)

### `IntakeRawMessage`
- append-only raw participant messages
- scoped by `intakeId` + `participantId`

### `IntakeAssistantQuestion`
- append-only asked questions
- scoped by `intakeId` + `participantId`

### `IntakeConfirmedSummary`
- user-confirmed summary text
- one-to-one with intake

## Separation guarantees
- Raw messages are persisted separately from normalized model.
- Only confirmed normalized model + confirmed summary are allowed for downstream synthesis.
- Repository queries for raw messages require both intake and participant identifiers.

## Deferred schema extensions
- Proposal rounds / proposal decisions
- Event/audit stream for all domain commands
