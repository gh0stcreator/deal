import { MediationSummary } from '../../domain/synthesis/types.js';

export interface MediationSummaryRepository {
  findLatestByCaseId(caseId: string): Promise<MediationSummary | null>;
  save(summary: MediationSummary): Promise<void>;
}
