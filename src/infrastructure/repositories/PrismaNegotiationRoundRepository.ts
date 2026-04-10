import {
  NegotiationRoundOutcome as PrismaNegotiationRoundOutcome,
  NegotiationRoundStatus as PrismaNegotiationRoundStatus,
  Prisma,
  PrismaClient
} from '@prisma/client';
import { NegotiationRoundRepository } from '../../application/ports/NegotiationRoundRepository.js';
import {
  NegotiationRound,
  NegotiationRoundOutcome,
  NegotiationRoundStatus,
  ParticipantActionBundle
} from '../../domain/negotiation/types.js';

const toPrismaStatus = (status: NegotiationRoundStatus): PrismaNegotiationRoundStatus =>
  status as PrismaNegotiationRoundStatus;

const toPrismaOutcome = (outcome: NegotiationRoundOutcome): PrismaNegotiationRoundOutcome =>
  outcome as PrismaNegotiationRoundOutcome;

interface NegotiationRoundRecord {
  id: string;
  caseId: string;
  roundNumber: number;
  proposalSetVersion: number;
  participantActionsJson: Prisma.JsonValue;
  status: string;
  outcome: string;
  nextProposalSetVersion: number | null;
  createdAt: Date;
  finalizedAt: Date | null;
}

const mapRound = (record: NegotiationRoundRecord): NegotiationRound => ({
  id: record.id,
  case_id: record.caseId,
  round_number: record.roundNumber,
  proposal_set_version: record.proposalSetVersion,
  participant_actions: record.participantActionsJson as unknown as ParticipantActionBundle[],
  status: record.status as NegotiationRoundStatus,
  outcome: record.outcome as NegotiationRoundOutcome,
  next_proposal_set_version: record.nextProposalSetVersion,
  created_at: record.createdAt,
  finalized_at: record.finalizedAt
});

export class PrismaNegotiationRoundRepository implements NegotiationRoundRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findLatestByCaseId(caseId: string): Promise<NegotiationRound | null> {
    const record = await this.prisma.negotiationRound.findFirst({
      where: { caseId },
      orderBy: { roundNumber: 'desc' }
    });

    return record ? mapRound(record as NegotiationRoundRecord) : null;
  }

  async findOpenByCaseId(caseId: string): Promise<NegotiationRound | null> {
    const record = await this.prisma.negotiationRound.findFirst({
      where: { caseId, status: PrismaNegotiationRoundStatus.OPEN },
      orderBy: { roundNumber: 'asc' }
    });

    return record ? mapRound(record as NegotiationRoundRecord) : null;
  }

  async listByCaseId(caseId: string): Promise<NegotiationRound[]> {
    const records = await this.prisma.negotiationRound.findMany({
      where: { caseId },
      orderBy: { roundNumber: 'asc' }
    });

    return records.map((record) => mapRound(record as NegotiationRoundRecord));
  }

  async save(round: NegotiationRound): Promise<void> {
    await this.prisma.negotiationRound.upsert({
      where: { id: round.id },
      update: {
        participantActionsJson: round.participant_actions as unknown as Prisma.InputJsonValue,
        status: toPrismaStatus(round.status),
        outcome: toPrismaOutcome(round.outcome),
        nextProposalSetVersion: round.next_proposal_set_version,
        finalizedAt: round.finalized_at
      },
      create: {
        id: round.id,
        caseId: round.case_id,
        roundNumber: round.round_number,
        proposalSetVersion: round.proposal_set_version,
        participantActionsJson: round.participant_actions as unknown as Prisma.InputJsonValue,
        status: toPrismaStatus(round.status),
        outcome: toPrismaOutcome(round.outcome),
        nextProposalSetVersion: round.next_proposal_set_version,
        createdAt: round.created_at,
        finalizedAt: round.finalized_at
      }
    });
  }
}
