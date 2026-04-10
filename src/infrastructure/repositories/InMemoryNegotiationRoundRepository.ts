import { NegotiationRoundRepository } from '../../application/ports/NegotiationRoundRepository.js';
import {
  NegotiationRound,
  NegotiationRoundStatuses
} from '../../domain/negotiation/types.js';

export class InMemoryNegotiationRoundRepository implements NegotiationRoundRepository {
  private readonly rounds = new Map<string, NegotiationRound[]>();

  async findLatestByCaseId(caseId: string): Promise<NegotiationRound | null> {
    const values = this.rounds.get(caseId) ?? [];
    if (values.length === 0) {
      return null;
    }

    return structuredClone(values[values.length - 1]);
  }

  async findOpenByCaseId(caseId: string): Promise<NegotiationRound | null> {
    const values = this.rounds.get(caseId) ?? [];
    const open = values.find((value) => value.status === NegotiationRoundStatuses.OPEN);
    return open ? structuredClone(open) : null;
  }

  async listByCaseId(caseId: string): Promise<NegotiationRound[]> {
    const values = this.rounds.get(caseId) ?? [];
    return structuredClone(values).sort((a, b) => a.round_number - b.round_number);
  }

  async save(round: NegotiationRound): Promise<void> {
    const values = this.rounds.get(round.case_id) ?? [];
    const idx = values.findIndex((value) => value.id === round.id);
    const clone = structuredClone(round);

    if (idx >= 0) {
      values[idx] = clone;
    } else {
      values.push(clone);
    }

    values.sort((a, b) => a.round_number - b.round_number);
    this.rounds.set(round.case_id, values);
  }
}
