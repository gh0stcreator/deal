import { ParticipantConversationState } from '../../domain/conversation/types.js';

export interface ConversationStateUpsertInput {
  sessionId: string;
  telegramUserId: string;
  currentStage: ParticipantConversationState['currentStage'];
  currentQuestionKey: string | null;
  expectedInputType: ParticipantConversationState['expectedInputType'];
  currentDraft: string | null;
  committedFields: string[];
  pendingAction: string | null;
  lastEventId: number | null;
  lastErrorCode: string | null;
  lastInboundEvent: string | null;
  lastOutboundAction: string | null;
}

export interface ConversationStateRepository {
  findBySessionAndUser(
    sessionId: string,
    telegramUserId: string
  ): Promise<ParticipantConversationState | null>;
  findActiveByUser(telegramUserId: string): Promise<ParticipantConversationState | null>;
  listBySession(sessionId: string): Promise<ParticipantConversationState[]>;
  upsert(input: ConversationStateUpsertInput): Promise<ParticipantConversationState>;
  clear(sessionId: string, telegramUserId: string): Promise<void>;
}
