import { MediationSession } from '../../domain/session/types.js';

export interface SessionRepository {
  save(session: MediationSession): Promise<void>;
  findById(sessionId: string): Promise<MediationSession | null>;
  findByInviteTokenHash(tokenHash: string): Promise<MediationSession | null>;
}
