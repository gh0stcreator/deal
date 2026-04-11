import { DraftAgreementRepository } from '../../application/ports/DraftAgreementRepository.js';
import {
  DraftAgreement,
  DraftAgreementOutcome,
  DraftAgreementResponse
} from '../../domain/agreement/types.js';

export class InMemoryDraftAgreementRepository implements DraftAgreementRepository {
  private readonly drafts = new Map<string, DraftAgreement[]>();
  private readonly responses = new Map<string, DraftAgreementResponse[]>();
  private readonly outcomes = new Map<string, DraftAgreementOutcome>();

  async findLatestByCaseId(caseId: string): Promise<DraftAgreement | null> {
    const records = this.drafts.get(caseId) ?? [];
    return records.at(-1) ?? null;
  }

  async saveDraft(draft: DraftAgreement): Promise<void> {
    const current = this.drafts.get(draft.caseId) ?? [];
    this.drafts.set(draft.caseId, [...current, draft]);
  }

  async listByCaseId(caseId: string): Promise<DraftAgreement[]> {
    return [...(this.drafts.get(caseId) ?? [])];
  }

  async saveOrUpdateResponse(response: DraftAgreementResponse): Promise<void> {
    const key = `${response.caseId}:${response.draftVersion}`;
    const current = this.responses.get(key) ?? [];
    const index = current.findIndex((entry) => entry.participantId === response.participantId);
    if (index >= 0) {
      current[index] = response;
      this.responses.set(key, [...current]);
      return;
    }
    this.responses.set(key, [...current, response]);
  }

  async listResponses(caseId: string, draftVersion: number): Promise<DraftAgreementResponse[]> {
    return [...(this.responses.get(`${caseId}:${draftVersion}`) ?? [])];
  }

  async upsertOutcome(outcome: DraftAgreementOutcome): Promise<void> {
    this.outcomes.set(`${outcome.caseId}:${outcome.draftVersion}`, outcome);
  }

  async findOutcome(caseId: string, draftVersion: number): Promise<DraftAgreementOutcome | null> {
    return this.outcomes.get(`${caseId}:${draftVersion}`) ?? null;
  }
}
