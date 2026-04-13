import { Bot } from 'grammy';
import { userIdFromCtx, makeCorrelationId } from '../helpers.js';
import { sendReplyWithRetry, safeAnswerCallback } from '../transport.js';
import { BotDeps } from '../botDeps.js';

export const registerInviteCallbacks = (bot: Bot, deps: BotDeps): void => {
  bot.callbackQuery('invite:send', async (ctx) => {
    await safeAnswerCallback(ctx);
    const telegramUserId = userIdFromCtx(ctx);
    const invite = deps.lastInviteByUser.get(telegramUserId);
    if (!invite) {
      await sendReplyWithRetry(ctx, 'Сначала создай договорённость, чтобы получить приглашение.', {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'invite_send'
      }, undefined, deps);
      return;
    }

    await sendReplyWithRetry(
      ctx,
      [
        'Отправьте это приглашение второму человеку:',
        '',
        `${invite.initiatorName} хочет обсудить с вами:`,
        `«${invite.topic}»`,
        '',
        'Я помогу вам спокойно договориться.',
        '',
        invite.deepLink ?? 'Не получилось создать ссылку в этом чате.'
      ].join('\n'),
      {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'invite_send'
      },
      undefined,
      deps
    );
  });

  bot.callbackQuery(/^invite:(details|copy)$/, async (ctx) => {
    await safeAnswerCallback(ctx);
    const telegramUserId = userIdFromCtx(ctx);
    const invite = deps.lastInviteByUser.get(telegramUserId);
    if (!invite) {
      await sendReplyWithRetry(ctx, 'Сначала создай договорённость, чтобы получить приглашение.', {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'invite_details'
      }, undefined, deps);
      return;
    }

    await sendReplyWithRetry(
      ctx,
      [
        invite.deepLink
          ? ['Ссылка для приглашения:', invite.deepLink].join('\n')
          : 'Не получилось создать ссылку в этом чате.',
        'Если ссылка не сработает, отправь этот токен:',
        invite.token
      ].join('\n'),
      {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'invite_details'
      },
      undefined,
      deps
    );
  });
};
