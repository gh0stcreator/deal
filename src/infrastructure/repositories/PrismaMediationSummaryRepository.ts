import { Prisma, PrismaClient } from '@prisma/client';
import { MediationSummaryRepository } from '../../application/ports/MediationSummaryRepository.js';
import { MediationSummary, StructuredSynthesis } from '../../domain/synthesis/types.js';

export class PrismaMediationSummaryRepository implements MediationSummaryRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findLatestByCaseId(caseId: string): Promise<MediationSummary | null> {
    const record = await this.prisma.mediationSummary.findFirst({
      where: { caseId },
      orderBy: { version: 'desc' }
    });

    return record ? this.mapRecord(record) : null;
  }

  async save(summary: MediationSummary): Promise<void> {
    await this.prisma.mediationSummary.create({
      data: {
        id: summary.id,
        caseId: summary.caseId,
        version: summary.version,
        sharedGoalsJson: summary.content.shared_goals,
        overlappingInterestsJson: summary.content.overlapping_interests,
        conflictingPointsJson: summary.content.conflicting_points,
        constraintsMatrixJson:
          summary.content.constraints_matrix as unknown as Prisma.InputJsonValue,
        nonNegotiablesConflictsJson: summary.content.non_negotiables_conflicts,
        potentialAgreementZonesJson: summary.content.potential_agreement_zones,
        riskAreasJson: summary.content.risk_areas,
        neutralRepresentationJson:
          summary.content.neutral_representation_layer as unknown as Prisma.InputJsonValue,
        createdAt: summary.createdAt
      }
    });
  }

  private mapRecord(record: any): MediationSummary {
    return {
      id: record.id,
      caseId: record.caseId,
      version: record.version,
      content: {
        shared_goals: record.sharedGoalsJson,
        overlapping_interests: record.overlappingInterestsJson,
        conflicting_points: record.conflictingPointsJson,
        constraints_matrix: record.constraintsMatrixJson,
        non_negotiables_conflicts: record.nonNegotiablesConflictsJson,
        potential_agreement_zones: record.potentialAgreementZonesJson,
        risk_areas: record.riskAreasJson,
        neutral_representation_layer: record.neutralRepresentationJson
      } as StructuredSynthesis,
      createdAt: record.createdAt
    };
  }
}
