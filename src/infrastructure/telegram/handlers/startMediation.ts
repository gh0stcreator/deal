import { Bot } from 'grammy';
import { MediationService } from '../../../application/services/MediationService.js';

export const registerStartMediationHandler = (bot: Bot, mediationService: MediationService) => {
  bot.command('start_mediation', async (ctx) => {
    const result = await mediationService.createSession(String(ctx.from?.id));

    await ctx.reply(
      `Session created. Share this invite token privately with the other participant:\n${result.inviteToken}`
    );
  });
};
