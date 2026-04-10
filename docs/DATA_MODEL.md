# Data Model

## Core protocol entities
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
- `role` (`PARTY_A`, `PARTY_B`)
- `telegramUserId`
- `consentGrantedAt`
- timestamps

## Intake entities
### `ParticipantIntake`
- `id`
- `sessionId`
- `participantId`
- `state` (`NOT_STARTED`, `IN_PROGRESS`, `SUMMARY_PENDING_CONFIRMATION`, `COMPLETED`)
- `currentField`
- `normalizedPositionJson`
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
- unique (`intakeId`, `field`)
- naming note: in current Telegram UX layer, the participant "problem statement" step is mapped to intake field `facts` as a temporary storage alias (`problem_statement -> facts`) until dedicated field migration.

### `IntakeRawMessage`
- append-only raw participant messages
- scoped by `intakeId` and `participantId`
- includes private synthesis-clarification notes (`[problem_synthesis_clarification] ...`) used only in participant scope

### `IntakeAssistantQuestion`
- append-only assistant prompts/questions
- scoped by `intakeId` and `participantId`

### `IntakeConfirmedSummary`
- one-to-one with `ParticipantIntake`
- stores user-confirmed summary text

## Synthesis entities
### `MediationSummary`
- `id`
- `caseId`
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

### `ProblemSynthesisSnapshot` (dogfood step before proposals)
- `id`
- `caseId`
- `version` (unique per case)
- `focus`
- `sharedPoints`
- `divergence`
- `createdAt`

### `SynthesisReviewSignal`
- `id`
- `caseId`
- `participantId`
- `synthesisVersion`
- `reactionType` (`CONFIRM`, `CLARIFY`)
- `createdAt`
- unique (`caseId`, `participantId`, `synthesisVersion`)

## Proposal/negotiation entities
### `ProposalSet`
- `id`
- `caseId`
- `version` (unique per case)
- `mediationSummaryVersion`
- `parentProposalSetVersion`
- `derivedFromRoundNumber`
- `createdAt`

### `ProposalVariant`
- `id`
- `proposalSetId`
- `variantType` (`BALANCED`, `A_LEANING`, `B_LEANING`)
- `payloadJson`

### `NegotiationRound`
- `id`
- `caseId`
- `roundNumber`
- `proposalSetVersion`
- `participantActionsJson`
- `status`
- `outcome`
- `nextProposalSetVersion`
- `createdAt`
- `finalizedAt`

## Transport/audit entities (Phase 6)
### `IdempotencyRecord`
- `key`
- `channel` (`TELEGRAM`, `HTTP`)
- `caseId` (nullable)
- `participantId` (nullable)
- `actionType`
- `payloadHash`
- `responseJson`
- `createdAt`
- index on (`channel`, `caseId`, `participantId`, `actionType`, `payloadHash`, `createdAt`)
- correlation note: HTTP correlation IDs are prefixed into idempotency keys for traceability.

### `ProtocolEvent`
- `id`
- `caseId` (nullable)
- `participantId` (nullable)
- `actionType`
- `idempotencyKey`
- `channel` (`TELEGRAM`, `HTTP`)
- `outcome` (`ACCEPTED`, `NO_OP`, `ERROR`)
- `errorCode` (nullable)
- `sessionState` (nullable)
- `proposalSetVersion` (nullable)
- `roundNumber` (nullable)
- `createdAt`
- correlation note: event lookup can be correlated through `idempotencyKey` (prefixed by transport correlation ID).

## Enforced boundaries
- Synthesis consumes confirmed normalized intake models only.
- Proposal generation consumes `MediationSummary` only.
- Negotiation consumes proposal-layer entities only.
- Transport views do not expose private raw intake artifacts.
