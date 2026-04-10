import {
  PrismaClient,
  SynthesisReactionType as PrismaSynthesisReactionType
} from '@prisma/client';
import { SynthesisReviewRepository } from '../../application/ports/SynthesisReviewRepository.js';
import {
  ProblemSynthesisSnapshot,
  SynthesisReactionType,
  SynthesisReviewSignal
} from '../../domain/synthesis/types.js';

const toPrismaReaction = (
  reaction: SynthesisReactionType
): PrismaSynthesisReactionType => reaction as PrismaSynthesisReactionType;

export class PrismaSynthesisReviewRepository implements SynthesisReviewRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findLatestProblemSynthesis(caseId: string): Promise<ProblemSynthesisSnapshot | null> {
    const record = await this.prisma.problemSynthesisSnapshot.findFirst({
      where: { caseId },
      orderBy: { version: 'desc' }
    });

    if (!record) {
      return null;
    }

    return {
      id: record.id,
      caseId: record.caseId,
      version: record.version,
      focus: record.focus,
      sharedPoints: record.sharedPoints,
      divergence: record.divergence,
      createdAt: record.createdAt
    };
  }

  async saveProblemSynthesis(snapshot: ProblemSynthesisSnapshot): Promise<void> {
    await this.prisma.problemSynthesisSnapshot.create({
      data: {
        id: snapshot.id,
        caseId: snapshot.caseId,
        version: snapshot.version,
        focus: snapshot.focus,
        sharedPoints: snapshot.sharedPoints,
        divergence: snapshot.divergence,
        createdAt: snapshot.createdAt
      }
    });
  }

  async saveOrUpdateReviewSignal(signal: SynthesisReviewSignal): Promise<void> {
    await this.prisma.synthesisReviewSignal.upsert({
      where: {
        caseId_participantId_synthesisVersion: {
          caseId: signal.caseId,
          participantId: signal.participantId,
          synthesisVersion: signal.synthesisVersion
        }
      },
      create: {
        id: signal.id,
        caseId: signal.caseId,
        participantId: signal.participantId,
        synthesisVersion: signal.synthesisVersion,
        reactionType: toPrismaReaction(signal.reactionType),
        createdAt: signal.createdAt
      },
      update: {
        id: signal.id,
        reactionType: toPrismaReaction(signal.reactionType),
        createdAt: signal.createdAt
      }
    });
  }

  async listReviewSignals(caseId: string, synthesisVersion: number): Promise<SynthesisReviewSignal[]> {
    const records = await this.prisma.synthesisReviewSignal.findMany({
      where: { caseId, synthesisVersion },
      orderBy: { createdAt: 'asc' }
    });

    return records.map((record) => ({
      id: record.id,
      caseId: record.caseId,
      participantId: record.participantId,
      synthesisVersion: record.synthesisVersion,
      reactionType: record.reactionType as SynthesisReactionType,
      createdAt: record.createdAt
    }));
  }
}
