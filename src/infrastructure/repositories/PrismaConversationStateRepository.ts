import { PrismaClient } from '@prisma/client';
import {
  ConversationStateRepository,
  ConversationStateUpsertInput
} from '../../application/ports/ConversationStateRepository.js';
import { ParticipantConversationState } from '../../domain/conversation/types.js';

const mapEntity = (value: {
  id: string;
  sessionId: string;
  telegramUserId: string;
  currentStage: string;
  currentQuestionKey: string | null;
  expectedInputType: string;
  currentDraft: string | null;
  committedFieldsJson: unknown;
  pendingAction: string | null;
  lastEventId: number | null;
  lastErrorCode: string | null;
  lastInboundEvent: string | null;
  lastOutboundAction: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ParticipantConversationState => ({
  id: value.id,
  sessionId: value.sessionId,
  telegramUserId: value.telegramUserId,
  currentStage: value.currentStage as ParticipantConversationState['currentStage'],
  currentQuestionKey: value.currentQuestionKey,
  expectedInputType: value.expectedInputType as ParticipantConversationState['expectedInputType'],
  currentDraft: value.currentDraft,
  committedFields: Array.isArray(value.committedFieldsJson)
    ? value.committedFieldsJson.filter((entry): entry is string => typeof entry === 'string')
    : [],
  pendingAction: value.pendingAction,
  lastEventId: value.lastEventId,
  lastErrorCode: value.lastErrorCode,
  lastInboundEvent: value.lastInboundEvent,
  lastOutboundAction: value.lastOutboundAction,
  createdAt: value.createdAt,
  updatedAt: value.updatedAt
});

export class PrismaConversationStateRepository implements ConversationStateRepository {
  constructor(private readonly prisma: PrismaClient) {}

  private get delegate() {
    if (!this.prisma) {
      throw new Error(
        'PrismaConversationStateRepository: PrismaClient is not initialized. Check DI wiring.'
      );
    }
    const delegate = (this.prisma as unknown as { participantConversationState?: any })
      .participantConversationState;
    if (!delegate) {
      throw new Error(
        'PrismaConversationStateRepository: participantConversationState delegate is unavailable. Run Prisma migrations/generate and restart the app.'
      );
    }
    return delegate;
  }

  async findBySessionAndUser(
    sessionId: string,
    telegramUserId: string
  ): Promise<ParticipantConversationState | null> {
    const entity = await this.delegate.findUnique({
      where: {
        sessionId_telegramUserId: {
          sessionId,
          telegramUserId
        }
      }
    });
    return entity ? mapEntity(entity) : null;
  }

  async findActiveByUser(telegramUserId: string): Promise<ParticipantConversationState | null> {
    const entity = await this.delegate.findFirst({
      where: { telegramUserId },
      orderBy: { updatedAt: 'desc' }
    });
    return entity ? mapEntity(entity) : null;
  }

  async listBySession(sessionId: string): Promise<ParticipantConversationState[]> {
    const entities = await this.delegate.findMany({
      where: { sessionId },
      orderBy: { updatedAt: 'asc' }
    });
    return entities.map((entry: Parameters<typeof mapEntity>[0]) => mapEntity(entry));
  }

  async upsert(input: ConversationStateUpsertInput): Promise<ParticipantConversationState> {
    const entity = await this.delegate.upsert({
      where: {
        sessionId_telegramUserId: {
          sessionId: input.sessionId,
          telegramUserId: input.telegramUserId
        }
      },
      update: {
        currentStage: input.currentStage,
        currentQuestionKey: input.currentQuestionKey,
        expectedInputType: input.expectedInputType,
        currentDraft: input.currentDraft,
        committedFieldsJson: input.committedFields,
        pendingAction: input.pendingAction,
        lastEventId: input.lastEventId,
        lastErrorCode: input.lastErrorCode,
        lastInboundEvent: input.lastInboundEvent,
        lastOutboundAction: input.lastOutboundAction
      },
      create: {
        sessionId: input.sessionId,
        telegramUserId: input.telegramUserId,
        currentStage: input.currentStage,
        currentQuestionKey: input.currentQuestionKey,
        expectedInputType: input.expectedInputType,
        currentDraft: input.currentDraft,
        committedFieldsJson: input.committedFields,
        pendingAction: input.pendingAction,
        lastEventId: input.lastEventId,
        lastErrorCode: input.lastErrorCode,
        lastInboundEvent: input.lastInboundEvent,
        lastOutboundAction: input.lastOutboundAction
      }
    });
    return mapEntity(entity);
  }

  async clear(sessionId: string, telegramUserId: string): Promise<void> {
    await this.delegate.deleteMany({
      where: { sessionId, telegramUserId }
    });
  }
}
