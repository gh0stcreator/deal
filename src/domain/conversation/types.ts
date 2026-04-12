export const ConversationStages = {
  INTAKE: 'INTAKE',
  COMPLETED: 'COMPLETED'
} as const;

export type ConversationStage = (typeof ConversationStages)[keyof typeof ConversationStages];

export const ConversationExpectedInputTypes = {
  TEXT: 'TEXT',
  CONFIRM: 'CONFIRM',
  EDIT: 'EDIT',
  NONE: 'NONE'
} as const;

export type ConversationExpectedInputType =
  (typeof ConversationExpectedInputTypes)[keyof typeof ConversationExpectedInputTypes];

export interface ParticipantConversationState {
  id: string;
  sessionId: string;
  telegramUserId: string;
  currentStage: ConversationStage;
  currentQuestionKey: string | null;
  expectedInputType: ConversationExpectedInputType;
  currentDraft: string | null;
  committedFields: string[];
  pendingAction: string | null;
  lastEventId: number | null;
  lastErrorCode: string | null;
  lastInboundEvent: string | null;
  lastOutboundAction: string | null;
  createdAt: Date;
  updatedAt: Date;
}
