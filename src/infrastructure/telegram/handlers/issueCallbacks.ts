import { Bot } from 'grammy';
import { IssueReactionTypes } from '../../../domain/issue/types.js';
import { mapTelegramErrorText } from '../../transport/errorMapping.js';
import { userIdFromCtx, makeCorrelationId, makeKey } from '../helpers.js';
import { sendReplyWithRetry, safeAnswerCallback } from '../transport.js';
import { maybeStartDraftAgreement } from '../flows/issueFlow.js';
import { BotDeps } from '../botDeps.js';

export const registerIssueCallbacks = (bot: Bot, deps: BotDeps): void => {
  bot.callbackQuery(
    /^issue:react:([A-Za-z0-9_-]{3,}):(\d+):([A-Z0-9_]+):(accept|reject|edit)$/,
    async (ctx) => {
      await safeAnswerCallback(ctx);
      const sessionId = ctx.match[1];
      const loopVersion = Number(ctx.match[2]);
      const optionId = ctx.match[3];
      const action = ctx.match[4];
      const telegramUserId = userIdFromCtx(ctx);

      if (action === 'edit') {
        deps.pendingIssueChange.set(telegramUserId, { sessionId, loopVersion, optionId });
        await sendReplyWithRetry(
          ctx,
          'Что именно в этом варианте нужно изменить?',
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'issue_reaction_edit_prompt'
          },
          undefined,
          deps
        );
        return;
      }

      const reactionType =
        action === 'accept' ? IssueReactionTypes.ACCEPT : IssueReactionTypes.REJECT;
      try {
        const summary = await deps.gateway.submitIssueOptionReaction(
          {
            correlation_id: makeCorrelationId(ctx),
            channel: 'TELEGRAM',
            idempotency_key: makeKey(ctx, `issue_react_${loopVersion}_${optionId}_${action}`),
            action_type: 'issue_option_reaction',
            case_id: sessionId,
            participant_id: telegramUserId,
            payload: {
              session_id: sessionId,
              loop_version: loopVersion,
              option_id: optionId,
              reaction_type: reactionType
            }
          },
          {
            session_id: sessionId,
            telegram_user_id: telegramUserId,
            loop_version: loopVersion,
            option_id: optionId,
            reaction_type: reactionType
          }
        );

        const feedback =
          summary.status === 'WORKABLE_PATH_FOUND'
            ? 'Похоже, есть рабочий вариант. Зафиксировал реакцию.'
            : summary.status === 'NO_WORKABLE_PATH'
              ? 'Пока рабочий вариант не найден. Зафиксировал реакцию.'
              : 'Реакцию зафиксировал. Дальше ждём ответ второй стороны.';
        await sendReplyWithRetry(
          ctx,
          feedback,
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'issue_option_reaction'
          },
          undefined,
          deps
        );
        await maybeStartDraftAgreement(sessionId, telegramUserId, deps);
      } catch (error) {
        await sendReplyWithRetry(
          ctx,
          mapTelegramErrorText(error),
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'issue_option_reaction'
          },
          undefined,
          deps
        );
      }
    }
  );
};
