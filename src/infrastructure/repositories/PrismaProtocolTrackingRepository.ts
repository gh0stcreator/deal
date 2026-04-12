import {
  Prisma,
  PrismaClient,
  ProtocolEventOutcome as PrismaProtocolEventOutcome,
  SessionState as PrismaSessionState,
  TransportChannel as PrismaTransportChannel
} from '@prisma/client';
import { ProtocolTrackingRepository } from '../../application/ports/ProtocolTrackingRepository.js';
import {
  IdempotencyRecord,
  ProtocolEvent,
  ProtocolEventOutcome,
  TransportChannel
} from '../../domain/protocol/types.js';
import { SessionState } from '../../domain/session/types.js';

const toPrismaChannel = (channel: TransportChannel): PrismaTransportChannel =>
  channel as PrismaTransportChannel;

const toPrismaOutcome = (outcome: ProtocolEventOutcome): PrismaProtocolEventOutcome =>
  outcome as PrismaProtocolEventOutcome;

const VALID_SESSION_STATES = new Set<string>(Object.values(PrismaSessionState));

const toPrismaSessionState = (state: SessionState | null): PrismaSessionState | null => {
  if (!state || !VALID_SESSION_STATES.has(state)) return null;
  return state as PrismaSessionState;
};

export class PrismaProtocolTrackingRepository implements ProtocolTrackingRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findIdempotencyRecord(key: string): Promise<IdempotencyRecord | null> {
    const record = await this.prisma.idempotencyRecord.findUnique({ where: { key } });
    if (!record) {
      return null;
    }

    return {
      key: record.key,
      channel: record.channel as TransportChannel,
      case_id: record.caseId,
      participant_id: record.participantId,
      action_type: record.actionType,
      payload_hash: record.payloadHash,
      response_json: record.responseJson,
      created_at: record.createdAt
    };
  }

  async findRecentByFingerprint(input: {
    channel: IdempotencyRecord['channel'];
    case_id: string | null;
    participant_id: string | null;
    action_type: string;
    payload_hash: string;
    since: Date;
  }): Promise<IdempotencyRecord | null> {
    const record = await this.prisma.idempotencyRecord.findFirst({
      where: {
        channel: toPrismaChannel(input.channel),
        caseId: input.case_id,
        participantId: input.participant_id,
        actionType: input.action_type,
        payloadHash: input.payload_hash,
        createdAt: { gte: input.since }
      },
      orderBy: { createdAt: 'desc' }
    });

    if (!record) {
      return null;
    }

    return {
      key: record.key,
      channel: record.channel as TransportChannel,
      case_id: record.caseId,
      participant_id: record.participantId,
      action_type: record.actionType,
      payload_hash: record.payloadHash,
      response_json: record.responseJson,
      created_at: record.createdAt
    };
  }

  async saveIdempotencyRecord(record: IdempotencyRecord): Promise<void> {
    await this.prisma.idempotencyRecord.create({
      data: {
        key: record.key,
        channel: toPrismaChannel(record.channel),
        caseId: record.case_id,
        participantId: record.participant_id,
        actionType: record.action_type,
        payloadHash: record.payload_hash,
        responseJson: record.response_json as Prisma.InputJsonValue,
        createdAt: record.created_at
      }
    });
  }

  async saveProtocolEvent(event: ProtocolEvent): Promise<void> {
    await this.prisma.protocolEvent.create({
      data: {
        id: event.id,
        caseId: event.case_id,
        participantId: event.participant_id,
        actionType: event.action_type,
        idempotencyKey: event.idempotency_key,
        channel: toPrismaChannel(event.channel),
        outcome: toPrismaOutcome(event.outcome),
        errorCode: event.error_code,
        sessionState: toPrismaSessionState(event.session_state),
        proposalSetVersion: event.proposal_set_version,
        roundNumber: event.round_number,
        createdAt: event.created_at
      }
    });
  }

  async listProtocolEvents(caseId: string): Promise<ProtocolEvent[]> {
    const records = await this.prisma.protocolEvent.findMany({
      where: { caseId },
      orderBy: { createdAt: 'asc' }
    });

    return records.map((record) => ({
      id: record.id,
      case_id: record.caseId,
      participant_id: record.participantId,
      action_type: record.actionType,
      idempotency_key: record.idempotencyKey,
      channel: record.channel as TransportChannel,
      outcome: record.outcome as ProtocolEventOutcome,
      error_code: record.errorCode,
      session_state: (record.sessionState as SessionState | null) ?? null,
      proposal_set_version: record.proposalSetVersion,
      round_number: record.roundNumber,
      created_at: record.createdAt
    }));
  }
}
