import { MediationService } from '../services/MediationService.js';

export const createSessionCommand = async (
  mediationService: MediationService,
  telegramUserId: string
) => mediationService.createSession(telegramUserId);
