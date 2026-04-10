# Proposal Specification (Phase 4)

## Purpose
Define deterministic, privacy-preserving proposal generation on top of versioned `MediationSummary`.

## Input boundary (enforced)
Allowed:
- latest persisted `MediationSummary`
- session metadata for orchestration only

Forbidden:
- raw intake messages
- assistant question history
- participant normalized model objects
- any unconfirmed participant artifacts

## Variant set
Generator must output exactly 3 variants:
- `BALANCED`
- `A_LEANING`
- `B_LEANING`

## Variant schema (fixed)
Each variant contains:
- `title`
- `summary`
- `clauses[]`
  - `clause_id`
  - `topic`
  - `clause_text`
  - `rationale`
  - `tradeoff_notes`
- `unresolved_points[]`
- `risk_notes[]`
- `review_window`
- `fallback_if_broken`
  - `agreed_now[]`
  - `unresolved[]`
  - `fixed_boundaries[]`
  - `continue_path`

## Validation invariants
- exactly 3 variants with required types
- required non-empty fields for each variant
- non-empty clause list
- unique `clause_id` inside each variant
- no obvious clause contradictions within one topic
- variants differ in framing (not identical summaries)
- conflict-heavy summaries require explicit risk signaling

## Persistence
- `ProposalSet(caseId, version, mediationSummaryVersion, createdAt)`
- `ProposalVariant(proposalSetId, variantType, payloadJson)`
- unique `(caseId, version)` and `(proposalSetId, variantType)`

## State progression
- `READY_FOR_PROPOSAL` -> generate & persist valid `ProposalSet` -> `PROPOSALS_GENERATED`
- invalid summary/state fails fast with typed domain errors
