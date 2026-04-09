import { SessionRepository } from '../../application/ports/SessionRepository.js';
import { MediationSession } from '../../domain/session/types.js';

export class InMemorySessionRepository implements SessionRepository {
  private readonly sessions = new Map<string, MediationSession>();

  async save(session: MediationSession): Promise<void> {
    this.sessions.set(session.id, structuredClone(session));
  }

  async findById(sessionId: string): Promise<MediationSession | null> {
    const session = this.sessions.get(sessionId);
    return session ? structuredClone(session) : null;
  }

  async findByInviteTokenHash(tokenHash: string): Promise<MediationSession | null> {
    for (const session of this.sessions.values()) {
      if (session.inviteTokenHash === tokenHash) {
        return structuredClone(session);
      }
    }

    return null;
  }
}
