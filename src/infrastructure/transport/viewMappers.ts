import { IntakeView } from '../../application/services/IntakeService.js';
import { NegotiationView } from '../../application/services/NegotiationService.js';
import { ProposalSet } from '../../domain/proposal/types.js';
import { MediationSession } from '../../domain/session/types.js';

export interface SessionStatusView {
  session_id: string;
  state: string;
  participant_count: number;
  both_joined: boolean;
  consent_count: number;
  all_consented: boolean;
}

export interface IntakeStatusView {
  intake_id: string;
  state: string;
  current_field: string | null;
  summary_version: number;
  has_generated_summary: boolean;
  has_confirmed_summary: boolean;
  completed_at: string | null;
  version: number;
}

export interface ProposalListView {
  case_id: string;
  proposal_set_version: number;
  mediation_summary_version: number;
  variants: Array<{ variant_type: string; title: string; summary: string }>;
}

export interface ProposalVariantDetailsView {
  variant_type: string;
  title: string;
  summary: string;
  clauses: ProposalSet['variants'][number]['clauses'];
  unresolved_points: string[];
  risk_notes: string[];
  review_window: string;
  fallback_if_broken: ProposalSet['variants'][number]['fallback_if_broken'];
}

export interface NegotiationRoundStatusView {
  session_id: string;
  session_state: string;
  current_round_number: number | null;
  proposal_set_version: number;
  round_status: string | null;
  variants: ProposalListView['variants'];
}

export interface TerminalOutcomeView {
  session_id: string;
  outcome: string;
}

export const mapSessionStatusView = (session: MediationSession): SessionStatusView => {
  const consentCount = session.participants.filter((participant) => Boolean(participant.consentGrantedAt)).length;

  return {
    session_id: session.id,
    state: session.state,
    participant_count: session.participants.length,
    both_joined: session.participants.length === 2,
    consent_count: consentCount,
    all_consented: session.participants.length === 2 && consentCount === 2
  };
};

export const mapIntakeStatusView = (view: IntakeView): IntakeStatusView => ({
  intake_id: view.intakeId,
  state: view.state,
  current_field: view.currentField,
  summary_version: view.summaryVersion,
  has_generated_summary: Boolean(view.generatedSummary),
  has_confirmed_summary: Boolean(view.confirmedSummary),
  completed_at: view.completedAt ? view.completedAt.toISOString() : null,
  version: view.version
});

export const mapProposalListView = (set: ProposalSet): ProposalListView => ({
  case_id: set.case_id,
  proposal_set_version: set.version,
  mediation_summary_version: set.mediation_summary_version,
  variants: set.variants.map((variant) => ({
    variant_type: variant.variant_type,
    title: variant.title,
    summary: variant.summary
  }))
});

export const mapProposalVariantDetails = (
  set: ProposalSet,
  variantType: string
): ProposalVariantDetailsView | null => {
  const variant = set.variants.find((entry) => entry.variant_type === variantType);
  if (!variant) {
    return null;
  }

  return {
    variant_type: variant.variant_type,
    title: variant.title,
    summary: variant.summary,
    clauses: variant.clauses,
    unresolved_points: variant.unresolved_points,
    risk_notes: variant.risk_notes,
    review_window: variant.review_window,
    fallback_if_broken: variant.fallback_if_broken
  };
};

export const mapNegotiationRoundStatusView = (
  view: NegotiationView
): NegotiationRoundStatusView => ({
  session_id: view.session_id,
  session_state: view.session_state,
  current_round_number: view.current_round_number,
  proposal_set_version: view.proposal_set.version,
  round_status: view.round_status,
  variants: view.proposal_set.variants.map((variant) => ({
    variant_type: variant.variant_type,
    title: variant.title,
    summary: variant.summary
  }))
});

export const mapTerminalOutcomeView = (session: MediationSession): TerminalOutcomeView => ({
  session_id: session.id,
  outcome: session.state
});
