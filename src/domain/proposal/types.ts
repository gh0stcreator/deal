export const ProposalVariantTypes = {
  BALANCED: 'BALANCED',
  A_LEANING: 'A_LEANING',
  B_LEANING: 'B_LEANING'
} as const;

export type ProposalVariantType =
  (typeof ProposalVariantTypes)[keyof typeof ProposalVariantTypes];

export interface ProposalClause {
  clause_id: string;
  topic: string;
  clause_text: string;
  rationale: string;
  tradeoff_notes: string;
}

export interface MinimalAgreementFallback {
  agreed_now: string[];
  unresolved: string[];
  fixed_boundaries: string[];
  continue_path: string;
}

export interface ProposalVariant {
  variant_type: ProposalVariantType;
  title: string;
  summary: string;
  clauses: ProposalClause[];
  unresolved_points: string[];
  risk_notes: string[];
  review_window: string;
  fallback_if_broken: MinimalAgreementFallback;
}

export interface ProposalSet {
  id: string;
  case_id: string;
  version: number;
  mediation_summary_version: number;
  parent_proposal_set_version: number | null;
  derived_from_round_number: number | null;
  created_at: Date;
  variants: ProposalVariant[];
}
