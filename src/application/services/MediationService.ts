import { createHash, randomBytes } from 'node:crypto';
import { Clock } from '../ports/Clock.js';
import { IdGenerator } from '../ports/IdGenerator.js';
import { SessionRepository } from '../ports/SessionRepository.js';
import {
  createSessionAggregate,
  grantConsent,
  joinSession
} from '../../domain/session/stateMachine.js';
import {
  ExpiredInviteTokenError,
  InvalidInviteTokenError,
  SessionNotFoundError
} from '../../domain/session/errors.js';
import { MediationSession } from '../../domain/session/types.js';
import { IntakeValidationError } from '../../domain/intake/errors.js';

export interface SessionCreatedResult {
  session: MediationSession;
  inviteToken: string;
}

export class MediationService {
  private static readonly INVITE_EXPIRY_MS = 1000 * 60 * 60 * 24 * 3;

  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator
  ) {}

  async createSession(partyATelegramUserId: string): Promise<SessionCreatedResult> {
    const now = this.clock.now();
    const inviteToken = this.generateInviteToken();
    const tokenHash = this.hashInviteToken(inviteToken);

    const session = createSessionAggregate(
      this.idGenerator.nextId(),
      tokenHash,
      new Date(now.getTime() + MediationService.INVITE_EXPIRY_MS),
      partyATelegramUserId,
      null,
      now
    );

    await this.sessionRepository.save(session);

    return {
      session,
      inviteToken
    };
  }

  async createSessionWithTopic(
    partyATelegramUserId: string,
    problemTopic: string
  ): Promise<SessionCreatedResult> {
    const topic = normalizeProblemTopic(problemTopic);
    const now = this.clock.now();
    const inviteToken = this.generateInviteToken();
    const tokenHash = this.hashInviteToken(inviteToken);

    const session = createSessionAggregate(
      this.idGenerator.nextId(),
      tokenHash,
      new Date(now.getTime() + MediationService.INVITE_EXPIRY_MS),
      partyATelegramUserId,
      topic,
      now
    );

    await this.sessionRepository.save(session);

    return {
      session,
      inviteToken
    };
  }

  async joinSessionByInviteToken(
    inviteToken: string,
    partyBTelegramUserId: string
  ): Promise<MediationSession> {
    const tokenHash = this.hashInviteToken(inviteToken);
    const session = await this.sessionRepository.findByInviteTokenHash(tokenHash);

    if (!session) {
      throw new InvalidInviteTokenError();
    }

    if (this.clock.now() > session.inviteTokenExpiresAt) {
      throw new ExpiredInviteTokenError();
    }

    const updated = joinSession(session, partyBTelegramUserId, this.clock.now());
    await this.sessionRepository.save(updated);
    return updated;
  }

  async grantConsent(sessionId: string, telegramUserId: string): Promise<MediationSession> {
    const session = await this.sessionRepository.findById(sessionId);

    if (!session) {
      throw new SessionNotFoundError();
    }

    const updated = grantConsent(session, telegramUserId, this.clock.now());
    await this.sessionRepository.save(updated);
    return updated;
  }

  hashInviteToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private generateInviteToken(): string {
    return randomBytes(18).toString('base64url');
  }
}

const normalizeProblemTopic = (value: string): string => {
  const plain = value.replace(/\s+/g, ' ').trim();
  if (!plain) {
    throw new IntakeValidationError('Problem topic cannot be empty.');
  }
  if (plain.length > 120) {
    throw new IntakeValidationError('Problem topic cannot exceed 120 characters.');
  }
  return plain;
};
