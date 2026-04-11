import {
  IssueReactionType as PrismaIssueReactionType,
  Prisma,
  PrismaClient
} from '@prisma/client';
import { IssueResolutionRepository } from '../../application/ports/IssueResolutionRepository.js';
import {
  IssueReactionType,
  IssueResolutionLoop,
  IssueResolutionReaction
} from '../../domain/issue/types.js';

const toPrismaReaction = (
  reaction: IssueReactionType
): PrismaIssueReactionType => reaction as PrismaIssueReactionType;

export class PrismaIssueResolutionRepository implements IssueResolutionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findLatestLoopByCaseId(caseId: string): Promise<IssueResolutionLoop | null> {
    const record = await this.prisma.issueResolutionLoop.findFirst({
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
      synthesisVersion: record.synthesisVersion,
      issueTitle: record.issueTitle,
      sideAPriority: record.sideAPriority,
      sideBPriority: record.sideBPriority,
      issueConstraints: record.issueConstraintsJson as unknown as string[],
      options: record.optionsJson as unknown as IssueResolutionLoop['options'],
      optionTradeoffs: record.optionTradeoffsJson as unknown as string[],
      createdAt: record.createdAt
    };
  }

  async saveLoop(loop: IssueResolutionLoop): Promise<void> {
    await this.prisma.issueResolutionLoop.create({
      data: {
        id: loop.id,
        caseId: loop.caseId,
        version: loop.version,
        synthesisVersion: loop.synthesisVersion,
        issueTitle: loop.issueTitle,
        sideAPriority: loop.sideAPriority,
        sideBPriority: loop.sideBPriority,
        issueConstraintsJson: loop.issueConstraints as unknown as Prisma.InputJsonValue,
        optionsJson: loop.options as unknown as Prisma.InputJsonValue,
        optionTradeoffsJson: loop.optionTradeoffs as unknown as Prisma.InputJsonValue,
        createdAt: loop.createdAt
      }
    });
  }

  async listLoopsByCaseId(caseId: string): Promise<IssueResolutionLoop[]> {
    const records = await this.prisma.issueResolutionLoop.findMany({
      where: { caseId },
      orderBy: { version: 'asc' }
    });
    return records.map((record) => ({
      id: record.id,
      caseId: record.caseId,
      version: record.version,
      synthesisVersion: record.synthesisVersion,
      issueTitle: record.issueTitle,
      sideAPriority: record.sideAPriority,
      sideBPriority: record.sideBPriority,
      issueConstraints: record.issueConstraintsJson as unknown as string[],
      options: record.optionsJson as unknown as IssueResolutionLoop['options'],
      optionTradeoffs: record.optionTradeoffsJson as unknown as string[],
      createdAt: record.createdAt
    }));
  }

  async saveOrUpdateReaction(reaction: IssueResolutionReaction): Promise<void> {
    await this.prisma.issueResolutionReaction.upsert({
      where: {
        caseId_loopVersion_participantId_optionId: {
          caseId: reaction.caseId,
          loopVersion: reaction.loopVersion,
          participantId: reaction.participantId,
          optionId: reaction.optionId
        }
      },
      create: {
        id: reaction.id,
        caseId: reaction.caseId,
        loopVersion: reaction.loopVersion,
        participantId: reaction.participantId,
        optionId: reaction.optionId,
        reactionType: toPrismaReaction(reaction.reactionType),
        changeRequest: reaction.changeRequest,
        createdAt: reaction.createdAt
      },
      update: {
        id: reaction.id,
        reactionType: toPrismaReaction(reaction.reactionType),
        changeRequest: reaction.changeRequest,
        createdAt: reaction.createdAt
      }
    });
  }

  async listReactions(caseId: string, loopVersion: number): Promise<IssueResolutionReaction[]> {
    const records = await this.prisma.issueResolutionReaction.findMany({
      where: { caseId, loopVersion },
      orderBy: { createdAt: 'asc' }
    });
    return records.map((record) => ({
      id: record.id,
      caseId: record.caseId,
      loopVersion: record.loopVersion,
      participantId: record.participantId,
      optionId: record.optionId,
      reactionType: record.reactionType as IssueReactionType,
      changeRequest: record.changeRequest,
      createdAt: record.createdAt
    }));
  }
}
