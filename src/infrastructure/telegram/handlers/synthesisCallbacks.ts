import { Bot } from 'grammy';
import { mapTelegramErrorText } from '../../transport/errorMapping.js';
import { userIdFromCtx, makeCorrelationId, makeKey } from '../helpers.js';
import { sendReplyWithRetry, safeAnswerCallback } from '../transport.js';
import { maybeStartIssueLoop } from '../flows/issueFlow.js';
import { BotDeps } from '../botDeps.js';

export const registerSynthesisCallbacks = (bot: Bot, deps: BotDeps): void => {
  bot.callbackQuery(/^synthesis:ok:([A-Za-z0-9_-]{3,})$/, async (ctx) => {
    await safeAnswerCallback(ctx);
    try {
      const sessionId = ctx.match[1];
      const telegramUserId = userIdFromCtx(ctx);
      await deps.gateway.recordProblemSynthesisReaction(
        {
          correlation_id: makeCorrelationId(ctx),
          channel: 'TELEGRAM',
          idempotency_key: makeKey(ctx, 'synthesis_confirm'),
          action_type: 'synthesis_confirm',
          case_id: sessionId,
          participant_id: telegramUserId,
          payload: { session_id: sessionId, reaction: 'confirm' }
        },
        sessionId,
        telegramUserId,
        'confirm'
      );
      await sendReplyWithRetry(
        ctx,
        'Хорошо, двигаемся дальше.',
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'synthesis_ack'
        },
        undefined,
        deps
      );
      await maybeStartIssueLoop(sessionId, telegramUserId, 'current', deps, ctx);
    } catch (error) {
      await sendReplyWithRetry(
        ctx,
        mapTelegramErrorText(error),
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'synthesis_ack'
        },
        undefined,
        deps
      );
    }
  });

  bot.callbackQuery(/^synthesis:clarify:([A-Za-z0-9_-]{3,})$/, async (ctx) => {
    await safeAnswerCallback(ctx);
    try {
      const sessionId = ctx.match[1];
      const telegramUserId = userIdFromCtx(ctx);
      await deps.gateway.recordProblemSynthesisReaction(
        {
          correlation_id: makeCorrelationId(ctx),
          channel: 'TELEGRAM',
          idempotency_key: makeKey(ctx, 'synthesis_clarify_reaction'),
          action_type: 'synthesis_clarify_reaction',
          case_id: sessionId,
          participant_id: telegramUserId,
          payload: { session_id: sessionId, reaction: 'clarify' }
        },
        sessionId,
        telegramUserId,
        'clarify'
      );
      deps.pendingSynthesisClarificationSession.set(telegramUserId, sessionId);
      await sendReplyWithRetry(
        ctx,
        'Что именно я понял не так?',
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'synthesis_clarify_prompt'
        },
        undefined,
        deps
      );
      await maybeStartIssueLoop(sessionId, telegramUserId, 'current', deps, ctx);
    } catch (error) {
      await sendReplyWithRetry(
        ctx,
        mapTelegramErrorText(error),
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'synthesis_clarify_prompt'
        },
        undefined,
        deps
      );
    }
  });
};
