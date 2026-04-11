import { SessionEvaluation } from '../../domain/quality/types.js';

export interface SessionEvaluationRepository {
  findByCaseId(caseId: string): Promise<SessionEvaluation | null>;
  upsert(evaluation: SessionEvaluation): Promise<void>;
  listAll(): Promise<SessionEvaluation[]>;
}
