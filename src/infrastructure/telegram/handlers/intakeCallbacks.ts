import { Bot } from 'grammy';
import { ConversationStages, ConversationExpectedInputTypes } from '../../../domain/conversation/types.js';
import { DomainError } from '../../../domain/session/errors.js';
import { ProtocolGatewayService, StructuredIntakeAnswerInput } from '../../../application/services/ProtocolGatewayService.js';
import { userIdFromCtx, makeCorrelationId, makeStableIntakeConfirmKey } from '../helpers.js';
import { mediationStepById, MediationIntakeStepId } from '../constants.js';
import { sendReplyWithRetry, safeAnswerCallback } from '../transport.js';
import {
  findNextMediationIntakeStep,
  committedConversationFields,
  upsertConversationState
} from '../conversationState.js';
import { detectCurrentUxStep, resolveSessionContext } from '../logging.js';
import { askNextMediationIntakeQuestion } from '../flows/intakeFlow.js';
import { createSessionFlow } from '../flows/sessionFlow.js';
import { BotDeps } from '../botDeps.js';

export const registerIntakeCallbacks = (bot: Bot, deps: BotDeps): void => {
  bot.callbackQuery(/^intake:edit:([A-Za-z0-9_-]{3,}):([a-z_]+)$/, async (ctx) => {
    await safeAnswerCallback(ctx);
    const sessionId = ctx.match[1];
    const stepId = ctx.match[2] as MediationIntakeStepId;
    const telegramUserId = userIdFromCtx(ctx);
    if (!mediationStepById.has(stepId)) {
      await sendReplyWithRetry(ctx, 'Не могу найти этот шаг. Отправьте ответ ещё раз.', {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'mediation_intake_edit'
      }, undefined, deps);
      return;
    }
    deps.pendingMediationIntakeSession.set(telegramUserId, sessionId);
    deps.pendingMediationIntakeStep.set(telegramUserId, stepId);
    deps.pendingMediationIntakeDraft.delete(telegramUserId);
    const progress = await deps.gateway.getIntakeProgress(sessionId, telegramUserId);
    await upsertConversationState({
      sessionId,
      telegramUserId,
      currentStage: ConversationStages.INTAKE,
      currentQuestionKey: stepId,
      expectedInputType: ConversationExpectedInputTypes.TEXT,
      currentDraft: null,
      committedFields: committedConversationFields(progress.fields),
      pendingAction: null,
      lastEventId: ctx.update.update_id,
      lastInboundEvent: 'intake_edit',
      lastOutboundAction: 'mediation_intake_edit'
    }, deps);
    await sendReplyWithRetry(
      ctx,
      'Отправьте исправленный вариант.',
      {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'mediation_intake_edit'
      },
      undefined,
      deps
    );
  });

  bot.callbackQuery(/^intake:confirm:([A-Za-z0-9_-]{3,}):([a-z_]+)$/, async (ctx) => {
    await safeAnswerCallback(ctx);
    const sessionId = ctx.match[1];
    const stepId = ctx.match[2] as MediationIntakeStepId;
    const telegramUserId = userIdFromCtx(ctx);
    const step = mediationStepById.get(stepId);
    const persistedConversationState = await deps.conversationStateRepository.findBySessionAndUser(
      sessionId,
      telegramUserId
    );
    const currentIntakeSession = deps.pendingMediationIntakeSession.get(telegramUserId) ?? null;
    const currentIntakeStep = deps.pendingMediationIntakeStep.get(telegramUserId) ?? null;
    const draftFromMemory = deps.pendingMediationIntakeDraft.get(telegramUserId);
    const sessionContext = await resolveSessionContext(ctx, telegramUserId, deps);
    if (!step) {
      await sendReplyWithRetry(ctx, 'Не могу найти этот шаг. Отправьте ответ ещё раз.', {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'mediation_intake_confirm'
      }, undefined, deps);
      return;
    }

    const draftFromMemoryIsValid =
      Boolean(draftFromMemory) &&
      draftFromMemory?.sessionId === sessionId &&
      draftFromMemory?.stepId === stepId;
    const primaryField = step.writes[0] ?? 'facts';
    let beforeProgress: Awaited<ReturnType<ProtocolGatewayService['getIntakeProgress']>> | null = null;
    try {
      beforeProgress = await deps.gateway.getIntakeProgress(sessionId, telegramUserId);
    } catch {
      beforeProgress = null;
    }

    const persistedStepBefore = beforeProgress ? findNextMediationIntakeStep(beforeProgress.fields)?.id ?? null : null;
    let draftValue: string | null = draftFromMemoryIsValid ? draftFromMemory!.text : null;
    if (!draftValue) {
      try {
        draftValue = await deps.gateway.getLatestIntakeDraft(sessionId, telegramUserId, primaryField);
      } catch {
        draftValue = null;
      }
    }

    deps.logger.info(
      {
        correlation_id: makeCorrelationId(ctx),
        session_id: sessionId,
        telegram_user_id: telegramUserId,
        role: sessionContext.role,
        current_ux_step: detectCurrentUxStep(telegramUserId, deps),
        current_protocol_state: sessionContext.protocol_state,
        intake_step: stepId,
        current_intake_session: currentIntakeSession,
        current_intake_step: currentIntakeStep,
        persisted_conversation_stage: persistedConversationState?.currentStage ?? null,
        persisted_expected_input_type: persistedConversationState?.expectedInputType ?? null,
        persisted_current_question_key: persistedConversationState?.currentQuestionKey ?? null,
        draft_present: Boolean(draftValue),
        draft_value: draftValue,
        persisted_intake_step_before: persistedStepBefore,
        persisted_step_completed_before: beforeProgress
          ? step.writes.every((field) => {
              const entry = beforeProgress!.fields[field];
              return Boolean(entry.rawValue && entry.normalizedValue);
            })
          : null,
        next_step_attempted: null,
        branch: draftFromMemoryIsValid ? 'memory_draft' : 'persisted_draft_lookup',
        error_code: null
      },
      'telegram.intake.confirm.trace'
    );

    if (
      persistedConversationState &&
      (persistedConversationState.currentStage !== ConversationStages.INTAKE ||
        persistedConversationState.expectedInputType !== ConversationExpectedInputTypes.CONFIRM ||
        persistedConversationState.currentQuestionKey !== stepId)
    ) {
      const progress = await deps.gateway.getIntakeProgress(sessionId, telegramUserId);
      const liveStep = findNextMediationIntakeStep(progress.fields);
      if (liveStep) {
        await upsertConversationState({
          sessionId,
          telegramUserId,
          currentStage: ConversationStages.INTAKE,
          currentQuestionKey: liveStep.id,
          expectedInputType: ConversationExpectedInputTypes.TEXT,
          currentDraft: null,
          committedFields: committedConversationFields(progress.fields),
          pendingAction: null,
          lastEventId: ctx.update.update_id,
          lastErrorCode: 'STALE_CONFIRM_CALLBACK',
          lastInboundEvent: 'intake_confirm',
          lastOutboundAction: 'mediation_intake_question'
        }, deps);
      }
      await sendReplyWithRetry(
        ctx,
        'Это старое подтверждение. Продолжаем с актуального шага.',
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'mediation_intake_confirm'
        },
        undefined,
        deps
      );
      await askNextMediationIntakeQuestion(telegramUserId, sessionId, 'current', deps, ctx);
      return;
    }

    if (!draftValue) {
      const alreadyCompleted = beforeProgress
        ? step.writes.every((field) => {
            const entry = beforeProgress!.fields[field];
            return Boolean(entry.rawValue && entry.normalizedValue);
          })
        : false;
      if (alreadyCompleted) {
        await sendReplyWithRetry(
          ctx,
          'Этот ответ уже подтверждён.',
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'mediation_intake_confirm'
          },
          undefined,
          deps
        );
        await askNextMediationIntakeQuestion(telegramUserId, sessionId, 'current', deps, ctx);
        return;
      }
      deps.pendingMediationIntakeSession.set(telegramUserId, sessionId);
      deps.pendingMediationIntakeStep.set(telegramUserId, stepId);
      deps.pendingMediationIntakeDraft.delete(telegramUserId);
      await upsertConversationState({
        sessionId,
        telegramUserId,
        currentStage: ConversationStages.INTAKE,
        currentQuestionKey: stepId,
        expectedInputType: ConversationExpectedInputTypes.TEXT,
        currentDraft: null,
        committedFields: beforeProgress ? committedConversationFields(beforeProgress.fields) : [],
        pendingAction: null,
        lastEventId: ctx.update.update_id,
        lastErrorCode: 'DRAFT_MISSING',
        lastInboundEvent: 'intake_confirm',
        lastOutboundAction: 'mediation_intake_question'
      }, deps);
      await sendReplyWithRetry(
        ctx,
        'Кажется, шаг сбился. Давайте продолжим.',
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'mediation_intake_confirm'
        },
        undefined,
        deps
      );
      await sendReplyWithRetry(
        ctx,
        step.question,
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'mediation_intake_confirm'
        },
        undefined,
        deps
      );
      return;
    }

    try {
      const answers: StructuredIntakeAnswerInput[] = step.writes.map((field) => ({
        field,
        value: draftValue!
      }));
      if (step.id === 'acceptable_flexibility') {
        const progress = await deps.gateway.getIntakeProgress(sessionId, telegramUserId);
        const hardConstraint = progress.fields.constraints.rawValue?.trim();
        if (hardConstraint) {
          answers.push({
            field: 'non_negotiables',
            value: hardConstraint
          });
        }
      }

      await deps.gateway.submitIntakeAnswers(
        {
          correlation_id: makeCorrelationId(ctx),
          channel: 'TELEGRAM',
          idempotency_key: makeStableIntakeConfirmKey(sessionId, telegramUserId, step.id, draftValue!),
          action_type: 'mediation_intake_confirm',
          case_id: sessionId,
          participant_id: telegramUserId,
          payload: { session_id: sessionId, step_id: step.id, text: draftValue! }
        },
        sessionId,
        telegramUserId,
        answers
      );
      deps.pendingMediationIntakeDraft.delete(telegramUserId);
      const afterProgress = await deps.gateway.getIntakeProgress(sessionId, telegramUserId);
      const persistedStepAfter = findNextMediationIntakeStep(afterProgress.fields)?.id ?? null;
      deps.logger.info(
        {
          correlation_id: makeCorrelationId(ctx),
          session_id: sessionId,
          telegram_user_id: telegramUserId,
          current_ux_step: detectCurrentUxStep(telegramUserId, deps),
          current_protocol_state: sessionContext.protocol_state,
          intake_step: stepId,
          persisted_intake_step_before: persistedStepBefore,
          persisted_intake_step_after: persistedStepAfter,
          persisted_step_completed_after: step.writes.every((field) => {
            const entry = afterProgress.fields[field];
            return Boolean(entry.rawValue && entry.normalizedValue);
          }),
          draft_present: true,
          draft_value: draftValue!,
          next_step_attempted: persistedStepAfter,
          branch: 'confirm_committed',
          error_code: null
        },
        'telegram.intake.confirm.trace'
      );
      await askNextMediationIntakeQuestion(telegramUserId, sessionId, 'current', deps, ctx);
    } catch (error) {
      const domainCode = error instanceof DomainError ? error.code : 'INTAKE_CONFIRM_FAILED';
      deps.logger.warn(
        {
          correlation_id: makeCorrelationId(ctx),
          session_id: sessionId,
          telegram_user_id: telegramUserId,
          current_ux_step: detectCurrentUxStep(telegramUserId, deps),
          current_protocol_state: sessionContext.protocol_state,
          intake_step: stepId,
          persisted_intake_step_before: persistedStepBefore,
          draft_present: Boolean(draftValue),
          draft_value: draftValue,
          next_step_attempted: null,
          branch: 'confirm_error',
          error_code: domainCode
        },
        'telegram.intake.confirm.trace'
      );
      deps.pendingMediationIntakeSession.set(telegramUserId, sessionId);
      deps.pendingMediationIntakeStep.set(telegramUserId, stepId);
      deps.pendingMediationIntakeDraft.delete(telegramUserId);
      await upsertConversationState({
        sessionId,
        telegramUserId,
        currentStage: ConversationStages.INTAKE,
        currentQuestionKey: stepId,
        expectedInputType: ConversationExpectedInputTypes.TEXT,
        currentDraft: null,
        committedFields: beforeProgress ? committedConversationFields(beforeProgress.fields) : [],
        pendingAction: null,
        lastEventId: ctx.update.update_id,
        lastErrorCode: domainCode,
        lastInboundEvent: 'intake_confirm',
        lastOutboundAction: 'mediation_intake_question'
      }, deps);
      if (domainCode === 'INTAKE_VALIDATION_ERROR' && error instanceof Error && error.message) {
        await sendReplyWithRetry(
          ctx,
          error.message,
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'mediation_intake_confirm'
          },
          undefined,
          deps
        );
        await sendReplyWithRetry(
          ctx,
          step.question,
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'mediation_intake_confirm'
          },
          undefined,
          deps
        );
      } else {
        await sendReplyWithRetry(
          ctx,
          'Не получилось сохранить этот шаг. Давайте продолжим.',
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'mediation_intake_confirm'
          },
          undefined,
          deps
        );
        await sendReplyWithRetry(
          ctx,
          step.question,
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'mediation_intake_confirm'
          },
          undefined,
          deps
        );
      }
    }
  });

  bot.callbackQuery(/^create_topic:(confirm_draft|rephrase)$/, async (ctx) => {
    await safeAnswerCallback(ctx);
    const telegramUserId = userIdFromCtx(ctx);
    const action = ctx.match[1];
    const draft = deps.pendingCreateTopicDraft.get(telegramUserId);

    if (!draft) {
      deps.pendingInput.set(telegramUserId, 'CREATE_TOPIC');
      await sendReplyWithRetry(
        ctx,
        'О чём хотите договориться? Опишите коротко.',
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'create_topic_prompt'
        },
        undefined,
        deps
      );
      return;
    }

    if (action === 'rephrase') {
      deps.pendingCreateTopicDraft.delete(telegramUserId);
      deps.pendingInput.set(telegramUserId, 'CREATE_TOPIC');
      await sendReplyWithRetry(
        ctx,
        'Отправьте формулировку ещё раз.',
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'create_topic_rephrase'
        },
        undefined,
        deps
      );
      return;
    }

    const initiatorName = (ctx.from?.first_name ?? 'Кто-то').replace(/\s+/g, ' ').trim();
    const created = await createSessionFlow(ctx, telegramUserId, draft.topic, initiatorName || 'Кто-то', deps);
    if (created) {
      deps.pendingInput.delete(telegramUserId);
      deps.pendingCreateTopicDraft.delete(telegramUserId);
    }
  });

  // Backward-compatible guard for stale callbacks from older UX versions.
  bot.callbackQuery(/^problem:(confirm|edit):([A-Za-z0-9_-]{3,})$/, async (ctx) => {
    await safeAnswerCallback(ctx);
    const sessionId = ctx.match[2];
    const telegramUserId = userIdFromCtx(ctx);
    deps.pendingMediationIntakeSession.set(telegramUserId, sessionId);
    deps.pendingMediationIntakeStep.delete(telegramUserId);
    deps.pendingMediationIntakeDraft.delete(telegramUserId);
    await sendReplyWithRetry(
      ctx,
      'Этот шаг устарел. Продолжаем по текущему сценарию.',
      {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'legacy_problem_callback'
      },
      undefined,
      deps
    );
    await askNextMediationIntakeQuestion(telegramUserId, sessionId, 'current', deps, ctx);
  });
};
