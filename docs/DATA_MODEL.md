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
- `parentProposalSetVersion` (version lineage)
- `derivedFromRoundNumber` (traceability)
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

## Implemented negotiation tables (Phase 5)
### `NegotiationRound`
- `id`
- `caseId`
- `roundNumber` (unique per case)
- `proposalSetVersion` (round snapshot input)
- `participantActionsJson` (structured action bundles by participant)
- `status` (`OPEN` / `FINALIZED`)
- `outcome`
  - `PENDING`
  - `CONTINUE_WITH_NEW_VERSION`
  - `CONFLICTING_EDITS`
  - `AGREEMENT_REACHED`
  - `PARTIAL_AGREEMENT`
  - `DEADLOCK`
  - `ABANDONED`
- `nextProposalSetVersion`
- `createdAt`
- `finalizedAt`

## Negotiation protocol constraints
- action set is closed:
  - `ACCEPT`
  - `REJECT`
  - `SELECT_PREFERRED`
  - `SUGGEST_EDIT`
- `SUGGEST_EDIT` must reference existing `clause_id` and use a structured operation.
- no free-form rewrite payloads.
- no mutation of existing `ProposalSet`; each iteration writes a new version.

## Deferred schema extensions
- Event/audit stream for all domain commands
