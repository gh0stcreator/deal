import { NegotiationRound } from '../../domain/negotiation/types.js';

export interface NegotiationRoundRepository {
  findLatestByCaseId(caseId: string): Promise<NegotiationRound | null>;
  findOpenByCaseId(caseId: string): Promise<NegotiationRound | null>;
  listByCaseId(caseId: string): Promise<NegotiationRound[]>;
  save(round: NegotiationRound): Promise<void>;
}
