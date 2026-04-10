import { ProposalSetRepository } from '../../application/ports/ProposalSetRepository.js';
import { ProposalSet } from '../../domain/proposal/types.js';

export class InMemoryProposalSetRepository implements ProposalSetRepository {
  private readonly sets = new Map<string, ProposalSet[]>();

  async findLatestByCaseId(caseId: string): Promise<ProposalSet | null> {
    const values = this.sets.get(caseId) ?? [];
    if (values.length === 0) {
      return null;
    }

    return structuredClone(values[values.length - 1]);
  }

  async listByCaseId(caseId: string): Promise<ProposalSet[]> {
    const values = this.sets.get(caseId) ?? [];
    return structuredClone(values).sort((a, b) => a.version - b.version);
  }

  async save(proposalSet: ProposalSet): Promise<void> {
    const values = this.sets.get(proposalSet.case_id) ?? [];
    values.push(structuredClone(proposalSet));
    values.sort((a, b) => a.version - b.version);
    this.sets.set(proposalSet.case_id, values);
  }
}
