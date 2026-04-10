import { ProposalSet } from '../../domain/proposal/types.js';

export interface ProposalSetRepository {
  findLatestByCaseId(caseId: string): Promise<ProposalSet | null>;
  listByCaseId(caseId: string): Promise<ProposalSet[]>;
  save(proposalSet: ProposalSet): Promise<void>;
}
