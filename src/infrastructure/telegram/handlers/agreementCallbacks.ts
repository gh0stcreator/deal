import { Bot } from 'grammy';
import { mapTelegramErrorText } from '../../transport/errorMapping.js';
import { renderDraftAgreement } from '../renderers.js';
import { draftAgreementKeyboard } from '../keyboards.js';
import { userIdFromCtx, makeCorrelationId, makeKey } from '../helpers.js';
import { sendReplyWithRetry, sendDirectWithRetry, safeAnswerCallback } from '../transport.js';
import { BotDeps } from '../botDeps.js';

export const registerAgreementCallbacks = (bot: Bot, deps: BotDeps): void => {
  bot.callbackQuery(
    /^agreement:respond:([A-Za-z0-9_-]{3,}):(\d+):(confirm|edit|reject)$/,
    async (ctx) => {
      await safeAnswerCallback(ctx);
      const sessionId = ctx.match[1];
      const draftVersion = Number(ctx.match[2]);
      const action = ctx.match[3];
      const telegramUserId = userIdFromCtx(ctx);

      if (action === 'edit') {
        deps.pendingDraftAgreementChange.set(telegramUserId, { sessionId, draftVersion });
        await sendReplyWithRetry(
          ctx,
          'Что именно нужно изменить?',
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'draft_agreement_edit_prompt'
          },
          undefined,
          deps
        );
        return;
      }

      const responseType =
        action === 'confirm' ? 'CONFIRM' : 'REJECT';

      try {
        const decision = await deps.gateway.submitDraftAgreementResponse(
          {
            correlation_id: makeCorrelationId(ctx),
            channel: 'TELEGRAM',
            idempotency_key: makeKey(ctx, `draft_response_${draftVersion}_${action}`),
            action_type: 'draft_agreement_response',
            case_id: sessionId,
            participant_id: telegramUserId,
            payload: { session_id: sessionId, draft_version: draftVersion, action }
          },
          {
            session_id: sessionId,
            telegram_user_id: telegramUserId,
            draft_version: draftVersion,
            response_type: responseType
          }
        );

        const feedback =
          decision.outcome === 'AGREEMENT'
            ? 'Готово. Договорённость подтверждена обеими сторонами.'
            : decision.outcome === 'DEADLOCK'
              ? 'Пока договорённость не получилась. Зафиксировал, что стороны не пришли к варианту.'
              : decision.outcome === 'PARTIAL_AGREEMENT'
                ? 'Зафиксировал частичное согласие. Нужны уточнения по оставшимся пунктам.'
                : 'Зафиксировал ответ. Ждём вторую сторону.';
        await sendReplyWithRetry(
          ctx,
          feedback,
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'draft_agreement_response'
          },
          undefined,
          deps
        );
      } catch (error) {
        await sendReplyWithRetry(
          ctx,
          mapTelegramErrorText(error),
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'draft_agreement_response'
          },
          undefined,
          deps
        );
      }
    }
  );
};
