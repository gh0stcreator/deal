import { Context } from 'grammy';
import { mapTelegramErrorText } from '../../transport/errorMapping.js';
import { makeCorrelationId } from '../helpers.js';
import { issueOptionKeyboard, draftAgreementKeyboard } from '../keyboards.js';
import { renderIssueFraming, renderIssueOption, renderDraftAgreement } from '../renderers.js';
import { sendReplyWithRetry, sendDirectWithRetry } from '../transport.js';
import { BotDeps } from '../botDeps.js';

export const maybeStartIssueLoop = async (
  sessionId: string,
  triggerTelegramUserId: string,
  source: 'current' | 'direct',
  deps: BotDeps,
  ctx?: Context
): Promise<void> => {
  if (deps.issueLoopSent.has(sessionId)) {
    return;
  }

  const review = await deps.gateway.getProblemSynthesisDogfoodExport(sessionId, triggerTelegramUserId);
  if (review.confirm_count + review.clarify_count < 2) {
    return;
  }

  deps.issueLoopSent.add(sessionId);
  try {
    const loop = await deps.gateway.generateIssueResolutionLoop(
      {
        correlation_id:
          source === 'current' && ctx
            ? makeCorrelationId(ctx)
            : `tg:issue_loop:${sessionId}:${triggerTelegramUserId}`,
        channel: 'TELEGRAM',
        idempotency_key: `tg:issue_loop:${sessionId}`,
        action_type: 'issue_loop_generate',
        case_id: sessionId,
        participant_id: triggerTelegramUserId,
        payload: { session_id: sessionId }
      },
      sessionId,
      triggerTelegramUserId
    );

    const session = await deps.gateway.getSessionStatus(sessionId, triggerTelegramUserId);
    for (const participant of session.participants) {
      await sendDirectWithRetry(
        participant.telegramUserId,
        renderIssueFraming(loop),
        {
          correlation_id: `tg:issue_loop_framing:${sessionId}:${participant.telegramUserId}`,
          action_type: 'issue_loop_framing'
        },
        undefined,
        deps
      );
      await sendDirectWithRetry(
        participant.telegramUserId,
        'Вот варианты, которые могут сработать:',
        {
          correlation_id: `tg:issue_loop_intro:${sessionId}:${participant.telegramUserId}`,
          action_type: 'issue_loop_options'
        },
        undefined,
        deps
      );
      for (const option of loop.options) {
        await sendDirectWithRetry(
          participant.telegramUserId,
          renderIssueOption(option),
          {
            correlation_id: `tg:issue_loop_option:${sessionId}:${participant.telegramUserId}:${option.option_id}`,
            action_type: 'issue_loop_option'
          },
          {
            reply_markup: issueOptionKeyboard(sessionId, loop.loop_version, option.option_id)
          },
          deps
        );
      }
    }
  } catch (error) {
    deps.issueLoopSent.delete(sessionId);
    if (source === 'current' && ctx) {
      await sendReplyWithRetry(
        ctx,
        mapTelegramErrorText(error),
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'issue_loop_generate'
        },
        undefined,
        deps
      );
    }
  }
};

export const maybeStartDraftAgreement = async (
  sessionId: string,
  triggerTelegramUserId: string,
  deps: BotDeps
): Promise<void> => {
  if (deps.draftAgreementSent.has(sessionId)) {
    return;
  }

  const summary = await deps.gateway.getIssueResolutionSummary(sessionId, triggerTelegramUserId);
  if (summary.status !== 'WORKABLE_PATH_FOUND') {
    return;
  }

  deps.draftAgreementSent.add(sessionId);
  try {
    const draft = await deps.gateway.generateDraftAgreement(
      {
        correlation_id: `tg:draft:${sessionId}:${triggerTelegramUserId}`,
        channel: 'TELEGRAM',
        idempotency_key: `tg:draft:${sessionId}`,
        action_type: 'draft_agreement_generate',
        case_id: sessionId,
        participant_id: triggerTelegramUserId,
        payload: { session_id: sessionId }
      },
      sessionId,
      triggerTelegramUserId
    );
    const session = await deps.gateway.getSessionStatus(sessionId, triggerTelegramUserId);
    for (const participant of session.participants) {
      await sendDirectWithRetry(
        participant.telegramUserId,
        renderDraftAgreement(draft),
        {
          correlation_id: `tg:draft:${sessionId}:${participant.telegramUserId}`,
          action_type: 'draft_agreement'
        },
        { reply_markup: draftAgreementKeyboard(sessionId, draft.draft_version) },
        deps
      );
    }
  } catch {
    deps.draftAgreementSent.delete(sessionId);
  }
};
