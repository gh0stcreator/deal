import { MediationService } from '../services/MediationService.js';

export const giveConsentCommand = async (
  mediationService: MediationService,
  sessionId: string,
  telegramUserId: string
) => mediationService.grantConsent(sessionId, telegramUserId);
