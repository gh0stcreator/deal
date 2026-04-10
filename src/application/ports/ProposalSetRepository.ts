import { ProposalSet } from '../../domain/proposal/types.js';

export interface ProposalSetRepository {
  findLatestByCaseId(caseId: string): Promise<ProposalSet | null>;
  save(proposalSet: ProposalSet): Promise<void>;
}
