import {
  DraftAgreement,
  DraftAgreementOutcome,
  DraftAgreementResponse
} from '../../domain/agreement/types.js';

export interface DraftAgreementRepository {
  findLatestByCaseId(caseId: string): Promise<DraftAgreement | null>;
  saveDraft(draft: DraftAgreement): Promise<void>;
  listByCaseId(caseId: string): Promise<DraftAgreement[]>;
  saveOrUpdateResponse(response: DraftAgreementResponse): Promise<void>;
  listResponses(caseId: string, draftVersion: number): Promise<DraftAgreementResponse[]>;
  upsertOutcome(outcome: DraftAgreementOutcome): Promise<void>;
  findOutcome(caseId: string, draftVersion: number): Promise<DraftAgreementOutcome | null>;
}
