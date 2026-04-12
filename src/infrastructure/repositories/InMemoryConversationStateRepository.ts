import {
  ConversationStateRepository,
  ConversationStateUpsertInput
} from '../../application/ports/ConversationStateRepository.js';
import { ParticipantConversationState } from '../../domain/conversation/types.js';

const clone = (value: ParticipantConversationState): ParticipantConversationState => ({
  ...value,
  committedFields: [...value.committedFields],
  createdAt: new Date(value.createdAt),
  updatedAt: new Date(value.updatedAt)
});

export class InMemoryConversationStateRepository implements ConversationStateRepository {
  private readonly store = new Map<string, ParticipantConversationState>();
  private idCounter = 0;

  private key(sessionId: string, telegramUserId: string): string {
    return `${sessionId}:${telegramUserId}`;
  }

  async findBySessionAndUser(
    sessionId: string,
    telegramUserId: string
  ): Promise<ParticipantConversationState | null> {
    const value = this.store.get(this.key(sessionId, telegramUserId));
    return value ? clone(value) : null;
  }

  async findActiveByUser(telegramUserId: string): Promise<ParticipantConversationState | null> {
    const candidates = [...this.store.values()]
      .filter((entry) => entry.telegramUserId === telegramUserId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return candidates.length > 0 ? clone(candidates[0]) : null;
  }

  async listBySession(sessionId: string): Promise<ParticipantConversationState[]> {
    return [...this.store.values()]
      .filter((entry) => entry.sessionId === sessionId)
      .map((entry) => clone(entry));
  }

  async upsert(input: ConversationStateUpsertInput): Promise<ParticipantConversationState> {
    const now = new Date();
    const key = this.key(input.sessionId, input.telegramUserId);
    const existing = this.store.get(key);
    const next: ParticipantConversationState = {
      id: existing?.id ?? `conversation-${++this.idCounter}`,
      sessionId: input.sessionId,
      telegramUserId: input.telegramUserId,
      currentStage: input.currentStage,
      currentQuestionKey: input.currentQuestionKey,
      expectedInputType: input.expectedInputType,
      currentDraft: input.currentDraft,
      committedFields: [...input.committedFields],
      pendingAction: input.pendingAction,
      lastEventId: input.lastEventId,
      lastErrorCode: input.lastErrorCode,
      lastInboundEvent: input.lastInboundEvent,
      lastOutboundAction: input.lastOutboundAction,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    this.store.set(key, next);
    return clone(next);
  }

  async clear(sessionId: string, telegramUserId: string): Promise<void> {
    this.store.delete(this.key(sessionId, telegramUserId));
  }
}
