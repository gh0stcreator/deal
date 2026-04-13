import { Bot } from 'grammy';
import { ConversationStages, ConversationExpectedInputTypes } from '../../../domain/conversation/types.js';
import { IntakeField } from '../../../domain/intake/types.js';
import { IssueReactionTypes } from '../../../domain/issue/types.js';
import { DomainError } from '../../../domain/session/errors.js';
import { StructuredIntakeAnswerInput } from '../../../application/services/ProtocolGatewayService.js';
import { mapTelegramErrorText } from '../../transport/errorMapping.js';
import { userIdFromCtx, makeCorrelationId, makeKey, normalizeProblemTopicInput, extractInviteToken } from '../helpers.js';
import { mediationStepById, MediationIntakeStepId, INVALID_COMMAND_LIMIT } from '../constants.js';
import { draftAgreementKeyboard } from '../keyboards.js';
import { renderDraftAgreement } from '../renderers.js';
import { sendReplyWithRetry, sendDirectWithRetry, enforceRateLimit } from '../transport.js';
import {
  findNextMediationIntakeStep,
  committedConversationFields,
  upsertConversationState,
  findActiveIntakeState
} from '../conversationState.js';
import { askNextMediationIntakeQuestion } from '../flows/intakeFlow.js';
import { maybeStartIssueLoop, maybeStartDraftAgreement } from '../flows/issueFlow.js';
import { joinWithToken, createSessionFlow } from '../flows/sessionFlow.js';
import { BotDeps } from '../botDeps.js';

export const registerTextHandler = (bot: Bot, deps: BotDeps): void => {
  bot.on('message:text', async (ctx, next) => {
    const text = ctx.message.text;
    if (!text || text.startsWith('/')) {
      return next();
    }

    const telegramUserId = userIdFromCtx(ctx);
    const pendingClarificationForSession = deps.pendingSynthesisClarificationSession.get(telegramUserId);
    if (pendingClarificationForSession) {
      const input = text.trim();
      if (!input) {
        await sendReplyWithRetry(
          ctx,
          'Что именно я понял не так?',
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'synthesis_clarify'
          },
          undefined,
          deps
        );
        return;
      }

      try {
        await deps.gateway.submitProblemSynthesisClarification(
          {
            correlation_id: makeCorrelationId(ctx),
            channel: 'TELEGRAM',
            idempotency_key: makeKey(ctx, 'synthesis_clarify'),
            action_type: 'synthesis_clarify',
            case_id: pendingClarificationForSession,
            participant_id: telegramUserId,
            payload: { session_id: pendingClarificationForSession, text: input }
          },
          pendingClarificationForSession,
          telegramUserId,
          input
        );
        deps.pendingSynthesisClarificationSession.delete(telegramUserId);
        await sendReplyWithRetry(
          ctx,
          'Принял, записал.',
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'synthesis_clarify'
          },
          undefined,
          deps
        );
        await maybeStartIssueLoop(pendingClarificationForSession, telegramUserId, 'current', deps, ctx);
        return;
      } catch (error) {
        await sendReplyWithRetry(
          ctx,
          mapTelegramErrorText(error),
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'synthesis_clarify'
          },
          undefined,
          deps
        );
        return;
      }
    }

    const pendingIssueEdit = deps.pendingIssueChange.get(telegramUserId);
    if (pendingIssueEdit) {
      const input = text.trim();
      if (!input) {
        await sendReplyWithRetry(
          ctx,
          'Что именно в этом варианте нужно изменить?',
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'issue_reaction_edit'
          },
          undefined,
          deps
        );
        return;
      }
      try {
        const summary = await deps.gateway.submitIssueOptionReaction(
          {
            correlation_id: makeCorrelationId(ctx),
            channel: 'TELEGRAM',
            idempotency_key: makeKey(
              ctx,
              `issue_react_edit_${pendingIssueEdit.loopVersion}_${pendingIssueEdit.optionId}`
            ),
            action_type: 'issue_option_reaction',
            case_id: pendingIssueEdit.sessionId,
            participant_id: telegramUserId,
            payload: {
              session_id: pendingIssueEdit.sessionId,
              loop_version: pendingIssueEdit.loopVersion,
              option_id: pendingIssueEdit.optionId,
              reaction_type: IssueReactionTypes.REQUEST_CHANGE
            }
          },
          {
            session_id: pendingIssueEdit.sessionId,
            telegram_user_id: telegramUserId,
            loop_version: pendingIssueEdit.loopVersion,
            option_id: pendingIssueEdit.optionId,
            reaction_type: IssueReactionTypes.REQUEST_CHANGE,
            change_request: input
          }
        );
        deps.pendingIssueChange.delete(telegramUserId);
        const feedback =
          summary.status === 'WORKABLE_PATH_FOUND'
            ? 'Изменение зафиксировал. Похоже, рабочий вариант уже есть.'
            : 'Изменение зафиксировал. Ждём реакцию второй стороны.';
        await sendReplyWithRetry(
          ctx,
          feedback,
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'issue_reaction_edit'
          },
          undefined,
          deps
        );
        await maybeStartDraftAgreement(pendingIssueEdit.sessionId, telegramUserId, deps);
      } catch (error) {
        await sendReplyWithRetry(
          ctx,
          mapTelegramErrorText(error),
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'issue_reaction_edit'
          },
          undefined,
          deps
        );
      }
      return;
    }

    const pendingDraftChange = deps.pendingDraftAgreementChange.get(telegramUserId);
    if (pendingDraftChange) {
      const input = text.trim();
      if (!input) {
        await sendReplyWithRetry(
          ctx,
          'Что именно нужно изменить?',
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'draft_agreement_edit'
          },
          undefined,
          deps
        );
        return;
      }

      try {
        await deps.gateway.submitDraftAgreementResponse(
          {
            correlation_id: makeCorrelationId(ctx),
            channel: 'TELEGRAM',
            idempotency_key: makeKey(
              ctx,
              `draft_edit_${pendingDraftChange.draftVersion}`
            ),
            action_type: 'draft_agreement_response',
            case_id: pendingDraftChange.sessionId,
            participant_id: telegramUserId,
            payload: {
              session_id: pendingDraftChange.sessionId,
              draft_version: pendingDraftChange.draftVersion,
              response_type: 'REQUEST_CHANGE'
            }
          },
          {
            session_id: pendingDraftChange.sessionId,
            telegram_user_id: telegramUserId,
            draft_version: pendingDraftChange.draftVersion,
            response_type: 'REQUEST_CHANGE',
            change_request: input
          }
        );
        deps.pendingDraftAgreementChange.delete(telegramUserId);

        const regenerated = await deps.gateway.regenerateDraftAgreement(
          {
            correlation_id: makeCorrelationId(ctx),
            channel: 'TELEGRAM',
            idempotency_key: makeKey(
              ctx,
              `draft_regenerate_${pendingDraftChange.sessionId}`
            ),
            action_type: 'draft_agreement_regenerate',
            case_id: pendingDraftChange.sessionId,
            participant_id: telegramUserId,
            payload: { session_id: pendingDraftChange.sessionId }
          },
          pendingDraftChange.sessionId,
          telegramUserId
        );
        const session = await deps.gateway.getSessionStatus(pendingDraftChange.sessionId, telegramUserId);
        for (const participant of session.participants) {
          await sendDirectWithRetry(
            participant.telegramUserId,
            renderDraftAgreement(regenerated),
            {
              correlation_id: `tg:draft_regenerated:${pendingDraftChange.sessionId}:${participant.telegramUserId}`,
              action_type: 'draft_agreement'
            },
            {
              reply_markup: draftAgreementKeyboard(
                pendingDraftChange.sessionId,
                regenerated.draft_version
              )
            },
            deps
          );
        }
      } catch (error) {
        await sendReplyWithRetry(
          ctx,
          mapTelegramErrorText(error),
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'draft_agreement_edit'
          },
          undefined,
          deps
        );
      }
      return;
    }

    const activeIntakeState = await findActiveIntakeState(telegramUserId, deps);
    const pendingMediationSession = activeIntakeState?.sessionId ?? deps.pendingMediationIntakeSession.get(telegramUserId);
    if (pendingMediationSession) {
      // If user types new text while in CONFIRM state, treat it as a corrected answer
      // and let it fall through to normal intake text processing below.
      const input = text.trim();
      if (!input) {
        const stepId =
          (activeIntakeState?.currentQuestionKey as MediationIntakeStepId | undefined) ??
          deps.pendingMediationIntakeStep.get(telegramUserId);
        const question = stepId ? mediationStepById.get(stepId)?.question : null;
        await sendReplyWithRetry(
          ctx,
          question ?? 'Ответьте на текущий вопрос.',
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'mediation_intake_answer'
          },
          undefined,
          deps
        );
        return;
      }

      try {
        let stepId =
          (activeIntakeState?.currentQuestionKey as MediationIntakeStepId | undefined) ??
          deps.pendingMediationIntakeStep.get(telegramUserId);
        if (!stepId) {
          const view = await deps.gateway.getIntakeProgress(pendingMediationSession, telegramUserId);
          stepId = findNextMediationIntakeStep(view.fields)?.id;
        }

        if (!stepId) {
          await sendReplyWithRetry(
            ctx,
            'Услышал. Как только второй участник закончит — продолжим.',
            {
              correlation_id: makeCorrelationId(ctx),
              action_type: 'mediation_intake_answer'
            },
            undefined,
            deps
          );
          deps.pendingMediationIntakeSession.delete(telegramUserId);
          deps.pendingMediationIntakeStep.delete(telegramUserId);
          deps.pendingMediationIntakeDraft.delete(telegramUserId);
          return;
        }

        // Conversational intake dialog
        const historyKey = `${pendingMediationSession}:${telegramUserId}`;
        const history = deps.intakeConversationHistory.get(historyKey) ?? [];

        const intakeProgress = await deps.gateway.getIntakeProgress(pendingMediationSession, telegramUserId);
        const collectedFields: Partial<Record<string, string>> = {};
        for (const [field, entry] of Object.entries(intakeProgress.fields)) {
          if ((entry as { rawValue: string | null }).rawValue) {
            collectedFields[field] = (entry as { rawValue: string }).rawValue;
          }
        }

        let topic = 'Договорённость';
        try {
          const sessionStatus = await deps.gateway.getSessionStatus(pendingMediationSession, telegramUserId);
          topic = sessionStatus.problemTopic ?? topic;
        } catch { /* ignore */ }

        const dialogResult = await deps.dialogManager.processTurn({
          topic,
          history,
          collectedFields,
          latestUserMessage: input
        });

        // Update history
        history.push({ role: 'user', text: input });
        history.push({ role: 'assistant', text: dialogResult.reply });
        deps.intakeConversationHistory.set(historyKey, history);

        // Submit extracted fields
        if (Object.keys(dialogResult.extractedFields).length > 0) {
          const answers: StructuredIntakeAnswerInput[] = [];
          for (const [field, value] of Object.entries(dialogResult.extractedFields)) {
            if (value) answers.push({ field: field as IntakeField, value });
          }
          // boundaries is auto-derived from constraints in the domain state machine — no separate submission needed
          // Derive non_negotiables when complete
          if (dialogResult.isComplete) {
            const constraintVal = dialogResult.extractedFields.constraints
              ?? intakeProgress.fields.constraints?.rawValue?.trim()
              ?? null;
            if (constraintVal) {
              answers.push({ field: 'non_negotiables', value: constraintVal });
            }
          }
          const idempotencyKey = `tg:dialog_intake:${pendingMediationSession}:${telegramUserId}:${history.length}`;
          await deps.gateway.submitIntakeAnswers(
            {
              correlation_id: makeCorrelationId(ctx),
              channel: 'TELEGRAM',
              idempotency_key: idempotencyKey,
              action_type: 'mediation_intake_confirm',
              case_id: pendingMediationSession,
              participant_id: telegramUserId,
              payload: { session_id: pendingMediationSession, text: input }
            },
            pendingMediationSession,
            telegramUserId,
            answers
          );
        }

        deps.pendingMediationIntakeDraft.delete(telegramUserId);

        // Send dialog reply
        await sendReplyWithRetry(ctx, dialogResult.reply, {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'mediation_intake_answer'
        }, undefined, deps);

        // If complete, trigger completion check; otherwise update conversation state
        if (dialogResult.isComplete) {
          deps.intakeConversationHistory.delete(historyKey);
          await askNextMediationIntakeQuestion(telegramUserId, pendingMediationSession, 'current', deps, ctx);
        } else {
          // Update conversation state to reflect next expected step
          const updatedProgress = await deps.gateway.getIntakeProgress(pendingMediationSession, telegramUserId);
          const nextStep = findNextMediationIntakeStep(updatedProgress.fields);
          if (nextStep) {
            deps.pendingMediationIntakeSession.set(telegramUserId, pendingMediationSession);
            deps.pendingMediationIntakeStep.set(telegramUserId, nextStep.id);
            await upsertConversationState({
              sessionId: pendingMediationSession,
              telegramUserId,
              currentStage: ConversationStages.INTAKE,
              currentQuestionKey: nextStep.id,
              expectedInputType: ConversationExpectedInputTypes.TEXT,
              currentDraft: null,
              committedFields: committedConversationFields(updatedProgress.fields),
              pendingAction: null,
              lastEventId: ctx.update.update_id,
              lastInboundEvent: 'intake_answer',
              lastOutboundAction: 'mediation_intake_answer'
            }, deps);
          }
        }
        return;
      } catch (error) {
        const validationMessage =
          error instanceof DomainError && error.code === 'INTAKE_VALIDATION_ERROR'
            ? 'Опишите чуть подробнее, что происходит'
            : mapTelegramErrorText(error);
        await sendReplyWithRetry(
          ctx,
          validationMessage,
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'mediation_intake_answer'
          },
          undefined,
          deps
        );
        return;
      }
    }

    const waiting = deps.pendingInput.get(telegramUserId);
    if (!waiting) {
      return next();
    }

    if (waiting === 'CREATE_TOPIC') {
      const topic = normalizeProblemTopicInput(text);
      if (!topic) {
        await sendReplyWithRetry(
          ctx,
          'Тема должна быть короткой: до 120 символов. Попробуйте ещё раз.',
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'create_topic_validate'
          },
          undefined,
          deps
        );
        return;
      }

      const initiatorName = (ctx.from?.first_name ?? 'Кто-то').replace(/\s+/g, ' ').trim();
      const created = await createSessionFlow(ctx, telegramUserId, topic, initiatorName || 'Кто-то', deps);
      if (created) {
        deps.pendingInput.delete(telegramUserId);
        deps.pendingCreateTopicDraft.delete(telegramUserId);
      }
      return;
    }

    if (waiting === 'JOIN_TOKEN') {
      const tokenValue = extractInviteToken(text);
      if (!tokenValue) {
        await sendReplyWithRetry(ctx, 'Похоже, в приглашении ошибка. Попробуйте ещё раз или откройте ссылку', {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'join_token_parse'
        }, undefined, deps);
        return;
      }
      await joinWithToken(ctx, telegramUserId, tokenValue, 'join_session_text', deps);
      return;
    }
    return next();
  });

  bot.hears(
    /^\/(?!start$|create_session$|join_session$|give_consent$|resume_intake$|confirm_summary$|reopen_intake$|generate_proposals$|select_preferred$|accept_proposal$|reject_proposal$|suggest_edit$)[a-z_]+$/,
    async (ctx) => {
      const participantId = userIdFromCtx(ctx);
      if (
        !(await enforceRateLimit(ctx, {
          key: `tg:invalid:${participantId}`,
          limit: INVALID_COMMAND_LIMIT,
          action_type: 'invalid_command'
        }, deps))
      ) {
        return;
      }

      await sendReplyWithRetry(ctx, 'Неизвестная команда. Нажмите /start и выберите действие.', {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'invalid_command'
      }, undefined, deps);
    }
  );
};
