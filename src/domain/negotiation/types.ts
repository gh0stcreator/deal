import { ProposalVariantType } from '../proposal/types.js';

export const NegotiationActionTypes = {
  ACCEPT: 'ACCEPT',
  REJECT: 'REJECT',
  SUGGEST_EDIT: 'SUGGEST_EDIT',
  SELECT_PREFERRED: 'SELECT_PREFERRED'
} as const;

export type NegotiationActionType =
  (typeof NegotiationActionTypes)[keyof typeof NegotiationActionTypes];

export const SuggestEditOperations = {
  MODIFY_CLAUSE_TEXT: 'MODIFY_CLAUSE_TEXT',
  ADJUST_TRADEOFF_NOTES: 'ADJUST_TRADEOFF_NOTES',
  MARK_CLAUSE_UNACCEPTABLE: 'MARK_CLAUSE_UNACCEPTABLE'
} as const;

export type SuggestEditOperation =
  (typeof SuggestEditOperations)[keyof typeof SuggestEditOperations];

export const NegotiationRoundStatuses = {
  OPEN: 'OPEN',
  FINALIZED: 'FINALIZED'
} as const;

export type NegotiationRoundStatus =
  (typeof NegotiationRoundStatuses)[keyof typeof NegotiationRoundStatuses];

export const NegotiationRoundOutcomes = {
  PENDING: 'PENDING',
  CONTINUE_WITH_NEW_VERSION: 'CONTINUE_WITH_NEW_VERSION',
  CONFLICTING_EDITS: 'CONFLICTING_EDITS',
  AGREEMENT_REACHED: 'AGREEMENT_REACHED',
  PARTIAL_AGREEMENT: 'PARTIAL_AGREEMENT',
  DEADLOCK: 'DEADLOCK',
  ABANDONED: 'ABANDONED'
} as const;

export type NegotiationRoundOutcome =
  (typeof NegotiationRoundOutcomes)[keyof typeof NegotiationRoundOutcomes];

export interface AcceptAction {
  type: typeof NegotiationActionTypes.ACCEPT;
  variant_type: ProposalVariantType;
}

export interface RejectAction {
  type: typeof NegotiationActionTypes.REJECT;
  variant_type: ProposalVariantType;
}

export interface SelectPreferredAction {
  type: typeof NegotiationActionTypes.SELECT_PREFERRED;
  variant_type: ProposalVariantType;
}

export interface SuggestEditAction {
  type: typeof NegotiationActionTypes.SUGGEST_EDIT;
  variant_type: ProposalVariantType;
  clause_id: string;
  operation: SuggestEditOperation;
  proposed_value: string | null;
}

export type NegotiationAction =
  | AcceptAction
  | RejectAction
  | SelectPreferredAction
  | SuggestEditAction;

export interface ParticipantActionBundle {
  participant_id: string;
  submitted_at: Date;
  actions: NegotiationAction[];
}

export interface NegotiationRound {
  id: string;
  case_id: string;
  round_number: number;
  proposal_set_version: number;
  participant_actions: ParticipantActionBundle[];
  status: NegotiationRoundStatus;
  outcome: NegotiationRoundOutcome;
  next_proposal_set_version: number | null;
  created_at: Date;
  finalized_at: Date | null;
}
