import { ParticipantConversationState, ConversationStages } from '../../domain/conversation/types.js';
import { IntakeField } from '../../domain/intake/types.js';
import { ProtocolGatewayService } from '../../application/services/ProtocolGatewayService.js';
import { mediationIntakeSteps, intakeFieldToConversationKey, MediationIntakeStepDefinition } from './constants.js';
import { BotDeps } from './botDeps.js';

export const findNextMediationIntakeStep = (
  fields: Awaited<ReturnType<ProtocolGatewayService['getIntakeProgress']>>['fields']
): MediationIntakeStepDefinition | null => {
  for (const step of mediationIntakeSteps) {
    const completed = step.writes.every((field) => {
      const entry = fields[field];
      return Boolean(entry.rawValue && entry.normalizedValue);
    });
    if (!completed) {
      return step;
    }
  }
  return null;
};

export const committedConversationFields = (
  fields: Awaited<ReturnType<ProtocolGatewayService['getIntakeProgress']>>['fields']
): string[] => {
  const committed = new Set<string>();
  for (const [field, entry] of Object.entries(fields) as Array<[IntakeField, { rawValue: string | null; normalizedValue: string | null }]>) {
    if (entry.rawValue && entry.normalizedValue) {
      committed.add(intakeFieldToConversationKey[field]);
    }
  }
  return [...committed];
};

export const upsertConversationState = async (input: {
  sessionId: string;
  telegramUserId: string;
  currentStage: ParticipantConversationState['currentStage'];
  currentQuestionKey: string | null;
  expectedInputType: ParticipantConversationState['expectedInputType'];
  currentDraft: string | null;
  committedFields: string[];
  pendingAction: string | null;
  lastEventId: number | null;
  lastErrorCode?: string | null;
  lastInboundEvent?: string | null;
  lastOutboundAction?: string | null;
}, deps: BotDeps): Promise<void> => {
  await deps.conversationStateRepository.upsert({
    sessionId: input.sessionId,
    telegramUserId: input.telegramUserId,
    currentStage: input.currentStage,
    currentQuestionKey: input.currentQuestionKey,
    expectedInputType: input.expectedInputType,
    currentDraft: input.currentDraft,
    committedFields: input.committedFields,
    pendingAction: input.pendingAction,
    lastEventId: input.lastEventId,
    lastErrorCode: input.lastErrorCode ?? null,
    lastInboundEvent: input.lastInboundEvent ?? null,
    lastOutboundAction: input.lastOutboundAction ?? null
  });
};

export const findActiveIntakeState = async (telegramUserId: string, deps: BotDeps) => {
  const state = await deps.conversationStateRepository.findActiveByUser(telegramUserId);
  if (!state || state.currentStage !== ConversationStages.INTAKE) {
    return null;
  }
  return state;
};
