import { SessionEvaluationRepository } from '../../application/ports/SessionEvaluationRepository.js';
import { SessionEvaluation } from '../../domain/quality/types.js';

export class InMemorySessionEvaluationRepository implements SessionEvaluationRepository {
  private readonly store = new Map<string, SessionEvaluation>();

  async findByCaseId(caseId: string): Promise<SessionEvaluation | null> {
    const found = this.store.get(caseId);
    return found ? structuredClone(found) : null;
  }

  async upsert(evaluation: SessionEvaluation): Promise<void> {
    this.store.set(evaluation.caseId, structuredClone(evaluation));
  }

  async listAll(): Promise<SessionEvaluation[]> {
    return Array.from(this.store.values()).map((entry) => structuredClone(entry));
  }
}
