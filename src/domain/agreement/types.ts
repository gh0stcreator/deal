export const DraftAgreementOutcomeTypes = {
  AGREEMENT: 'AGREEMENT',
  PARTIAL_AGREEMENT: 'PARTIAL_AGREEMENT',
  DEADLOCK: 'DEADLOCK'
} as const;

export type DraftAgreementOutcomeType =
  (typeof DraftAgreementOutcomeTypes)[keyof typeof DraftAgreementOutcomeTypes];

export const DraftAgreementResponseTypes = {
  CONFIRM: 'CONFIRM',
  REQUEST_CHANGE: 'REQUEST_CHANGE',
  REJECT: 'REJECT'
} as const;

export type DraftAgreementResponseType =
  (typeof DraftAgreementResponseTypes)[keyof typeof DraftAgreementResponseTypes];

export interface DraftAgreement {
  id: string;
  caseId: string;
  version: number;
  loopVersion: number;
  sourceOptionId: string;
  agreementTitle: string;
  agreedActions: string[];
  boundaries: string[];
  conditions: string[];
  fallbackRule: string;
  reviewPoint: string;
  createdAt: Date;
}

export interface DraftAgreementResponse {
  id: string;
  caseId: string;
  draftVersion: number;
  participantId: string;
  responseType: DraftAgreementResponseType;
  changeRequest: string | null;
  createdAt: Date;
}

export interface DraftAgreementOutcome {
  id: string;
  caseId: string;
  draftVersion: number;
  outcome: DraftAgreementOutcomeType;
  createdAt: Date;
}
