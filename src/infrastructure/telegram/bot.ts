import { Bot } from 'grammy';
import { MediationService } from '../../application/services/MediationService.js';
import { registerConsentHandler } from './handlers/consent.js';
import { registerJoinMediationHandler } from './handlers/joinMediation.js';
import { registerStartMediationHandler } from './handlers/startMediation.js';

export const buildTelegramBot = (token: string, mediationService: MediationService) => {
  const bot = new Bot(token);

  registerStartMediationHandler(bot, mediationService);
  registerJoinMediationHandler(bot, mediationService);
  registerConsentHandler(bot, mediationService);

  return bot;
};
