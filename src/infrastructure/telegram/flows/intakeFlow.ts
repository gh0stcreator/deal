import { Context } from 'grammy';
import { ConversationStages, ConversationExpectedInputTypes } from '../../../domain/conversation/types.js';
import { SessionStates } from '../../../domain/session/types.js';
import { DomainError } from '../../../domain/session/errors.js';
import { mapTelegramErrorText } from '../../transport/errorMapping.js';
import { makeCorrelationId } from '../helpers.js';
import { mediationStepById, MediationIntakeStepId } from '../constants.js';
import { synthesisFeedbackKeyboard } from '../keyboards.js';
import { renderProblemSynthesis } from '../renderers.js';
import { sendReplyWithRetry, sendDirectWithRetry } from '../transport.js';
import { findNextMediationIntakeStep, committedConversationFields, upsertConversationState } from '../conversationState.js';
import { BotDeps } from '../botDeps.js';

export const resolveIntakeReflection = async (
  sessionId: string,
  telegramUserId: string,
  stepId: MediationIntakeStepId,
  text: string,
  deps: BotDeps
): Promise<string> => {
  const step = mediationStepById.get(stepId);
  if (!step) {
    return 'Правильно понял?';
  }

  try {
    const preview = await deps.gateway.previewIntakeReflection(
      sessionId,
      telegramUserId,
      step.writes[0] ?? 'facts',
      text,
      step.question
    );
    const reflection = preview.reflection?.trim();
    return reflection || 'Правильно понял?';
  } catch (error) {
    deps.logger.warn(
      {
        correlation_id: `tg:intake_reflection:${sessionId}:${telegramUserId}`,
        action_type: 'mediation_intake_reflection',
        code: error instanceof DomainError ? error.code : 'INTAKE_REFLECTION_FAILED'
      },
      'telegram.intake.reflection.failed'
    );
    return 'Правильно понял?';
  }
};

export const askNextMediationIntakeQuestion = async (
  participantTelegramUserId: string,
  sessionId: string,
  source: 'direct' | 'current',
  deps: BotDeps,
  ctx?: Context
): Promise<void> => {
  let view = await deps.gateway.getIntakeProgress(sessionId, participantTelegramUserId);
  if (view.state === 'SUMMARY_PENDING_CONFIRMATION' && view.generatedSummary) {
    view = await deps.gateway.confirmSummary(
      {
        correlation_id:
          source === 'current' && ctx
            ? makeCorrelationId(ctx)
            : `tg:intake_auto_confirm:${sessionId}:${participantTelegramUserId}`,
        channel: 'TELEGRAM',
        idempotency_key: `tg:intake_auto_confirm:${sessionId}:${participantTelegramUserId}:${view.version}`,
        action_type: 'intake_auto_confirm',
        case_id: sessionId,
        participant_id: participantTelegramUserId,
        payload: { session_id: sessionId, source: 'telegram_guided_intake' }
      },
      sessionId,
      participantTelegramUserId
    );
  }
  const nextStep = findNextMediationIntakeStep(view.fields);
  if (!nextStep) {
    deps.pendingMediationIntakeSession.delete(participantTelegramUserId);
    deps.pendingMediationIntakeStep.delete(participantTelegramUserId);
    deps.pendingMediationIntakeDraft.delete(participantTelegramUserId);
    // Clear intake conversation history for this participant in this session
    const historyKeyToDelete = `${sessionId}:${participantTelegramUserId}`;
    deps.intakeConversationHistory.delete(historyKeyToDelete);
    await upsertConversationState({
      sessionId,
      telegramUserId: participantTelegramUserId,
      currentStage: ConversationStages.COMPLETED,
      currentQuestionKey: null,
      expectedInputType: ConversationExpectedInputTypes.NONE,
      currentDraft: null,
      committedFields: committedConversationFields(view.fields),
      pendingAction: null,
      lastEventId: ctx?.update.update_id ?? null,
      lastInboundEvent: source === 'current' ? 'intake_transition' : 'intake_direct_transition',
      lastOutboundAction: 'mediation_intake_completed'
    }, deps);

    const session = await deps.gateway.getSessionStatus(sessionId, participantTelegramUserId);
    const allCompleted = session.state === SessionStates.READY_FOR_SYNTHESIS;
    if (!allCompleted) {
      const waitText = 'Услышал. Как только второй участник закончит — продолжим.';
      if (source === 'current' && ctx) {
        await sendReplyWithRetry(ctx, waitText, {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'mediation_intake_completed'
        }, undefined, deps);
        return;
      }
      await sendDirectWithRetry(
        participantTelegramUserId,
        waitText,
        {
          correlation_id: `tg:intake:${sessionId}:${participantTelegramUserId}`,
          action_type: 'mediation_intake_completed'
        },
        undefined,
        deps
      );
      return;
    }

    if (deps.problemSynthesisSent.has(sessionId)) {
      const alreadySentText = 'Сводная картина уже готова. Проверьте последнее сообщение.';
      if (source === 'current' && ctx) {
        await sendReplyWithRetry(
          ctx,
          alreadySentText,
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'problem_synthesis_ready'
          },
          undefined,
          deps
        );
        return;
      }
      await sendDirectWithRetry(
        participantTelegramUserId,
        alreadySentText,
        {
          correlation_id: `tg:synthesis:${sessionId}:${participantTelegramUserId}`,
          action_type: 'problem_synthesis_ready'
        },
        undefined,
        deps
      );
      return;
    }

    try {
      deps.problemSynthesisSent.add(sessionId);
      const synthesis = await deps.gateway.buildProblemSynthesis(
        {
          correlation_id:
            source === 'current' && ctx
              ? makeCorrelationId(ctx)
              : `tg:problem_synthesis:${sessionId}:${participantTelegramUserId}`,
          channel: 'TELEGRAM',
          idempotency_key: `tg:problem_synthesis:${sessionId}:${participantTelegramUserId}`,
          action_type: 'problem_synthesis',
          case_id: sessionId,
          participant_id: participantTelegramUserId,
          payload: { session_id: sessionId }
        },
        sessionId,
        participantTelegramUserId
      );
      const synthesisText = renderProblemSynthesis(synthesis.synthesis);
      for (const participant of session.participants) {
        await sendDirectWithRetry(
          participant.telegramUserId,
          synthesisText,
          {
            correlation_id: `tg:problem_synthesis_send:${sessionId}:${participant.telegramUserId}`,
            action_type: 'problem_synthesis_send'
          },
          { reply_markup: synthesisFeedbackKeyboard(sessionId) },
          deps
        );
      }
      return;
    } catch (error) {
      deps.problemSynthesisSent.delete(sessionId);
      const errorText = mapTelegramErrorText(error);
      if (source === 'current' && ctx) {
        await sendReplyWithRetry(
          ctx,
          errorText,
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'problem_synthesis_send'
          },
          undefined,
          deps
        );
        return;
      }
      await sendDirectWithRetry(
        participantTelegramUserId,
        errorText,
        {
          correlation_id: `tg:problem_synthesis_error:${sessionId}:${participantTelegramUserId}`,
          action_type: 'problem_synthesis_send'
        },
        undefined,
        deps
      );
      return;
    }
  }

  deps.pendingMediationIntakeSession.set(participantTelegramUserId, sessionId);
  deps.pendingMediationIntakeStep.set(participantTelegramUserId, nextStep.id);
  await upsertConversationState({
    sessionId,
    telegramUserId: participantTelegramUserId,
    currentStage: ConversationStages.INTAKE,
    currentQuestionKey: nextStep.id,
    expectedInputType: ConversationExpectedInputTypes.TEXT,
    currentDraft: null,
    committedFields: committedConversationFields(view.fields),
    pendingAction: null,
    lastEventId: ctx?.update.update_id ?? null,
    lastInboundEvent: source === 'current' ? 'intake_transition' : 'intake_direct_transition',
    lastOutboundAction: 'mediation_intake_question'
  }, deps);
  const text =
    nextStep.id === 'situation_facts'
      ? 'Расскажите, что происходит. Как вы это видите?'
      : nextStep.question;
  if (source === 'current' && ctx) {
    await sendReplyWithRetry(
      ctx,
      text,
      {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'mediation_intake_question'
      },
      undefined,
      deps
    );
    if (nextStep.id === 'situation_facts') {
      const historyKey = `${sessionId}:${participantTelegramUserId}`;
      const history = deps.intakeConversationHistory.get(historyKey) ?? [];
      if (history.length === 0) {
        history.push({ role: 'assistant', text });
        deps.intakeConversationHistory.set(historyKey, history);
      }
    }
    return;
  }

  await sendDirectWithRetry(
    participantTelegramUserId,
    text,
    {
      correlation_id: `tg:consent:${sessionId}:${participantTelegramUserId}`,
      action_type: 'mediation_intake_question'
    },
    undefined,
    deps
  );
  if (nextStep.id === 'situation_facts') {
    const historyKey = `${sessionId}:${participantTelegramUserId}`;
    const history = deps.intakeConversationHistory.get(historyKey) ?? [];
    if (history.length === 0) {
      history.push({ role: 'assistant', text });
      deps.intakeConversationHistory.set(historyKey, history);
    }
  }
};
