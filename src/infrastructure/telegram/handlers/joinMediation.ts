import { Bot } from 'grammy';
import { MediationService } from '../../../application/services/MediationService.js';
import { DomainError } from '../../../domain/session/errors.js';

export const registerJoinMediationHandler = (bot: Bot, mediationService: MediationService) => {
  bot.command('join', async (ctx) => {
    const token = ctx.message?.text?.split(' ')[1];

    if (!token) {
      await ctx.reply('Usage: /join <invite_token>');
      return;
    }

    try {
      const session = await mediationService.joinSessionByInviteToken(token, String(ctx.from?.id));
      await ctx.reply(`Joined session ${session.id}. Please run /consent ${session.id}`);
    } catch (error) {
      if (error instanceof DomainError) {
        await ctx.reply(error.message);
        return;
      }

      throw error;
    }
  });
};
