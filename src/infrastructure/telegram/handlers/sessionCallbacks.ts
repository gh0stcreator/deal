import { Bot } from 'grammy';
import { userIdFromCtx } from '../helpers.js';
import { safeAnswerCallback } from '../transport.js';
import { giveConsentFlow, describeSessionForUser } from '../flows/sessionFlow.js';
import { BotDeps } from '../botDeps.js';

export const registerSessionCallbacks = (bot: Bot, deps: BotDeps): void => {
  bot.callbackQuery(/^consent:([A-Za-z0-9_-]{3,})$/, async (ctx) => {
    await safeAnswerCallback(ctx);
    await giveConsentFlow(ctx, ctx.match[1], userIdFromCtx(ctx), 'give_consent_button', deps);
  });

  bot.callbackQuery(/^status:([A-Za-z0-9_-]{3,})$/, async (ctx) => {
    await safeAnswerCallback(ctx);
    const sessionId = ctx.match[1];
    const telegramUserId = userIdFromCtx(ctx);
    await describeSessionForUser(ctx, sessionId, telegramUserId, deps);
  });
};
