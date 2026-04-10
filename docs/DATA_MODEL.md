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

## Implemented synthesis tables (Phase 3)
### `MediationSummary`
- `id`
- `caseId` (session id)
- `version` (unique per case)
- `sharedGoalsJson`
- `overlappingInterestsJson`
- `conflictingPointsJson`
- `constraintsMatrixJson`
- `nonNegotiablesConflictsJson`
- `potentialAgreementZonesJson`
- `riskAreasJson`
- `neutralRepresentationJson`
- `createdAt`

## Synthesis input constraints (enforced in code)
- allowed inputs:
  - confirmed normalized position model (A)
  - confirmed normalized position model (B)
- forbidden inputs:
  - raw messages
  - assistant question history
  - unconfirmed/partial intake data

## Implemented proposal tables (Phase 4)
### `ProposalSet`
- `id`
- `caseId` (session id)
- `version` (unique per case)
- `mediationSummaryVersion` (input summary version)
- `createdAt`

### `ProposalVariant`
- `id`
- `proposalSetId`
- `variantType` (`BALANCED` / `A_LEANING` / `B_LEANING`)
- `payloadJson` (validated structured payload)

## Proposal input constraints (enforced in code)
- allowed inputs:
  - latest persisted `MediationSummary`
  - session metadata for orchestration/state checks
- forbidden inputs:
  - intake raw messages
  - assistant question history
  - participant-level normalized model objects
  - any unconfirmed private artifacts

## Deferred schema extensions
- Proposal rounds / participant decisions
- Event/audit stream for all domain commands
