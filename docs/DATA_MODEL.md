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
- guided-intake mapping note:
  - `situation_facts` -> `facts`
  - `tension_point` -> `interpretations`
  - `important_need_or_interest` -> `interests`
  - `hard_constraint` -> `constraints`, `boundaries`
  - `desired_outcome` -> `desired_outcome`
  - `acceptable_flexibility` -> `acceptable_concessions`
  - `non_negotiables` is currently mirrored from `hard_constraint` in Telegram guided UX.

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
- `focus` (mapped from `shared_goal`)
- `sharedPoints` (mapped from `agreement_points`)
- `divergence` (mapped from `primary_tension_point`)
- `createdAt`

Structured synthesis payload (application-level shape):
- `shared_goal`
- `agreement_points`
- `tension_points`
- `primary_tension_point`
- `side_a_interest`
- `side_b_interest`
- `side_a_constraint`
- `side_b_constraint`
- `possible_zone_of_agreement`

### `SynthesisReviewSignal`
- `id`
- `caseId`
- `participantId`
- `synthesisVersion`
- `reactionType` (`CONFIRM`, `CLARIFY`)
- `createdAt`
- unique (`caseId`, `participantId`, `synthesisVersion`)

## Issue resolution entities (Phase 3)
### `IssueResolutionLoop`
- `id`
- `caseId`
- `version` (unique per case)
- `synthesisVersion`
- `issueTitle`
- `sideAPriority`
- `sideBPriority`
- `issueConstraintsJson`
- `optionsJson`
- `optionTradeoffsJson`
- `createdAt`

### `IssueResolutionReaction`
- `id`
- `caseId`
- `loopVersion`
- `participantId`
- `optionId`
- `reactionType` (`ACCEPT`, `REJECT`, `REQUEST_CHANGE`)
- `changeRequest` (nullable; private participant note)
- `createdAt`
- unique (`caseId`, `loopVersion`, `participantId`, `optionId`)

## Draft agreement entities (Phase 4)
### `DraftAgreement`
- `id`
- `caseId`
- `version` (unique per case)
- `loopVersion`
- `sourceOptionId`
- `agreementTitle`
- `agreedActionsJson`
- `boundariesJson`
- `conditionsJson`
- `fallbackRule`
- `reviewPoint`
- `createdAt`

### `DraftAgreementResponse`
- `id`
- `caseId`
- `draftVersion`
- `participantId`
- `responseType` (`CONFIRM`, `REQUEST_CHANGE`, `REJECT`)
- `changeRequest` (nullable, private)
- `createdAt`
- unique (`caseId`, `draftVersion`, `participantId`)

### `DraftAgreementOutcome`
- `id`
- `caseId`
- `draftVersion`
- `outcome` (`AGREEMENT`, `PARTIAL_AGREEMENT`, `DEADLOCK`)
- `createdAt`
- unique (`caseId`, `draftVersion`)

## Dogfood quality entities (Phase 5)
### `SessionEvaluation`
- `caseId` (PK, FK -> `MediationSession.id`)
- `synthesisConfirmed` (both participants confirmed synthesis)
- `synthesisClarified` (at least one clarification on synthesis)
- `optionAcceptRate` (accept / (accept + reject))
- `agreementReached`
- `agreementAfterEdit`
- `deadlock`
- `qualityFlagsJson` (`low_recognition`, `over_generalization`, `full_option_rejection`, `repeated_edits_without_convergence`)
- `createdAt`
- `updatedAt`

`SessionEvaluation` is derived/observable metadata for dogfood analysis. It does not alter protocol state.

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
- Issue-resolution loop consumes confirmed structured intake + latest reviewed synthesis only.
- Issue change requests stay private and are not exposed as raw text in shared summaries.
- Draft agreements are generated only from converged issue-loop signals and confirmed intake constraints/outcomes.
- Draft change requests are private and not surfaced as cross-party raw text.
- Session full-export returns only structured fields for each side and hides raw private text artifacts.
- Proposal generation consumes `MediationSummary` only.
- Negotiation consumes proposal-layer entities only.
- Transport views do not expose private raw intake artifacts.
