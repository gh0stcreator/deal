import { MediationSummaryRepository } from '../../application/ports/MediationSummaryRepository.js';
import { MediationSummary } from '../../domain/synthesis/types.js';

export class InMemoryMediationSummaryRepository implements MediationSummaryRepository {
  private readonly summaries = new Map<string, MediationSummary[]>();

  async findLatestByCaseId(caseId: string): Promise<MediationSummary | null> {
    const entries = this.summaries.get(caseId) ?? [];
    if (entries.length === 0) {
      return null;
    }

    return structuredClone(entries[entries.length - 1]);
  }

  async save(summary: MediationSummary): Promise<void> {
    const entries = this.summaries.get(summary.caseId) ?? [];
    entries.push(structuredClone(summary));
    entries.sort((a, b) => a.version - b.version);
    this.summaries.set(summary.caseId, entries);
  }
}
