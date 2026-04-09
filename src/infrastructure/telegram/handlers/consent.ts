import { Bot } from 'grammy';
import { MediationService } from '../../../application/services/MediationService.js';
import { DomainError } from '../../../domain/session/errors.js';

export const registerConsentHandler = (bot: Bot, mediationService: MediationService) => {
  bot.command('consent', async (ctx) => {
    const sessionId = ctx.message?.text?.split(' ')[1];

    if (!sessionId) {
      await ctx.reply('Usage: /consent <session_id>');
      return;
    }

    try {
      const session = await mediationService.grantConsent(sessionId, String(ctx.from?.id));
      await ctx.reply(`Consent recorded. Current state: ${session.state}`);
    } catch (error) {
      if (error instanceof DomainError) {
        await ctx.reply(error.message);
        return;
      }

      throw error;
    }
  });
};
