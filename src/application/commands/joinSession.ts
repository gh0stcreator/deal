import { MediationService } from '../services/MediationService.js';

export const joinSessionCommand = async (
  mediationService: MediationService,
  inviteToken: string,
  telegramUserId: string
) => mediationService.joinSessionByInviteToken(inviteToken, telegramUserId);
