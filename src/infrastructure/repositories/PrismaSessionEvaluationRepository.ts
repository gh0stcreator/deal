import { Prisma, PrismaClient } from '@prisma/client';
import { SessionEvaluationRepository } from '../../application/ports/SessionEvaluationRepository.js';
import { SessionEvaluation } from '../../domain/quality/types.js';

export class PrismaSessionEvaluationRepository implements SessionEvaluationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByCaseId(caseId: string): Promise<SessionEvaluation | null> {
    const record = await this.prisma.sessionEvaluation.findUnique({ where: { caseId } });
    if (!record) {
      return null;
    }
    return {
      caseId: record.caseId,
      synthesisConfirmed: record.synthesisConfirmed,
      synthesisClarified: record.synthesisClarified,
      optionAcceptRate: record.optionAcceptRate,
      agreementReached: record.agreementReached,
      agreementAfterEdit: record.agreementAfterEdit,
      deadlock: record.deadlock,
      qualityFlags: record.qualityFlagsJson as unknown as string[],
      updatedAt: record.updatedAt,
      createdAt: record.createdAt
    };
  }

  async upsert(evaluation: SessionEvaluation): Promise<void> {
    await this.prisma.sessionEvaluation.upsert({
      where: { caseId: evaluation.caseId },
      create: {
        caseId: evaluation.caseId,
        synthesisConfirmed: evaluation.synthesisConfirmed,
        synthesisClarified: evaluation.synthesisClarified,
        optionAcceptRate: evaluation.optionAcceptRate,
        agreementReached: evaluation.agreementReached,
        agreementAfterEdit: evaluation.agreementAfterEdit,
        deadlock: evaluation.deadlock,
        qualityFlagsJson: evaluation.qualityFlags as unknown as Prisma.InputJsonValue,
        createdAt: evaluation.createdAt,
        updatedAt: evaluation.updatedAt
      },
      update: {
        synthesisConfirmed: evaluation.synthesisConfirmed,
        synthesisClarified: evaluation.synthesisClarified,
        optionAcceptRate: evaluation.optionAcceptRate,
        agreementReached: evaluation.agreementReached,
        agreementAfterEdit: evaluation.agreementAfterEdit,
        deadlock: evaluation.deadlock,
        qualityFlagsJson: evaluation.qualityFlags as unknown as Prisma.InputJsonValue,
        updatedAt: evaluation.updatedAt
      }
    });
  }

  async listAll(): Promise<SessionEvaluation[]> {
    const rows = await this.prisma.sessionEvaluation.findMany({ orderBy: { updatedAt: 'desc' } });
    return rows.map((record) => ({
      caseId: record.caseId,
      synthesisConfirmed: record.synthesisConfirmed,
      synthesisClarified: record.synthesisClarified,
      optionAcceptRate: record.optionAcceptRate,
      agreementReached: record.agreementReached,
      agreementAfterEdit: record.agreementAfterEdit,
      deadlock: record.deadlock,
      qualityFlags: record.qualityFlagsJson as unknown as string[],
      updatedAt: record.updatedAt,
      createdAt: record.createdAt
    }));
  }
}
