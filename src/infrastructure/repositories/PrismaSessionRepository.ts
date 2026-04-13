import { PrismaClient, Prisma } from '@prisma/client';
import { SessionRepository } from '../../application/ports/SessionRepository.js';
import {
  MediationSession,
  Participant,
  SessionState
} from '../../domain/session/types.js';

interface SessionRecord {
  id: string;
  state: string;
  inviteTokenHash: string;
  inviteTokenExpiresAt: Date;
  problemTopic: string | null;
  createdAt: Date;
  updatedAt: Date;
  participants: Array<{
    id: string;
    role: Participant['role'];
    telegramUserId: string;
    consentGrantedAt: Date | null;
  }>;
}

const mapSession = (record: SessionRecord): MediationSession => ({
  id: record.id,
  state: record.state as SessionState,
  inviteTokenHash: record.inviteTokenHash,
  inviteTokenExpiresAt: record.inviteTokenExpiresAt,
  problemTopic: record.problemTopic,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  participants: record.participants.map(
    (participant): Participant => ({
      id: participant.id,
      role: participant.role,
      telegramUserId: participant.telegramUserId,
      consentGrantedAt: participant.consentGrantedAt
    })
  )
});

export class PrismaSessionRepository implements SessionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async save(session: MediationSession): Promise<void> {
    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.mediationSession.upsert({
        where: { id: session.id },
        update: {
          state: session.state,
          inviteTokenHash: session.inviteTokenHash,
          inviteTokenExpiresAt: session.inviteTokenExpiresAt,
          problemTopic: session.problemTopic
        },
        create: {
          id: session.id,
          state: session.state,
          inviteTokenHash: session.inviteTokenHash,
          inviteTokenExpiresAt: session.inviteTokenExpiresAt,
          problemTopic: session.problemTopic
        }
      });

      for (const participant of session.participants) {
        await tx.sessionParticipant.upsert({
          where: {
            sessionId_role: {
              sessionId: session.id,
              role: participant.role
            }
          },
          update: {
            telegramUserId: participant.telegramUserId,
            consentGrantedAt: participant.consentGrantedAt
          },
          create: {
            id: participant.id,
            sessionId: session.id,
            role: participant.role,
            telegramUserId: participant.telegramUserId,
            consentGrantedAt: participant.consentGrantedAt
          }
        });
      }
    });
  }

  async findById(sessionId: string): Promise<MediationSession | null> {
    const session = await this.prisma.mediationSession.findUnique({
      where: { id: sessionId },
      include: { participants: true }
    });

    return session ? mapSession(session as SessionRecord) : null;
  }

  async findByInviteTokenHash(tokenHash: string): Promise<MediationSession | null> {
    const session = await this.prisma.mediationSession.findUnique({
      where: { inviteTokenHash: tokenHash },
      include: { participants: true }
    });

    return session ? mapSession(session as SessionRecord) : null;
  }

  async findByParticipantTelegramUserId(telegramUserId: string, limit: number): Promise<MediationSession[]> {
    const sessions = await this.prisma.mediationSession.findMany({
      where: {
        participants: {
          some: { telegramUserId }
        }
      },
      include: { participants: true },
      orderBy: { updatedAt: 'desc' },
      take: limit
    });
    return sessions.map((s) => mapSession(s as SessionRecord));
  }
}
