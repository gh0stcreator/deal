export interface SessionEvaluation {
  caseId: string;
  synthesisConfirmed: boolean;
  synthesisClarified: boolean;
  optionAcceptRate: number;
  agreementReached: boolean;
  agreementAfterEdit: boolean;
  deadlock: boolean;
  qualityFlags: string[];
  updatedAt: Date;
  createdAt: Date;
}
