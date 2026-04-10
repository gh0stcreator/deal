import {
  Prisma,
  PrismaClient,
  ProposalVariantType as PrismaProposalVariantType
} from '@prisma/client';
import { ProposalSetRepository } from '../../application/ports/ProposalSetRepository.js';
import {
  ProposalSet,
  ProposalVariant,
  ProposalVariantType
} from '../../domain/proposal/types.js';

const toPrismaVariantType = (
  variantType: ProposalVariantType
): PrismaProposalVariantType => variantType as PrismaProposalVariantType;

export class PrismaProposalSetRepository implements ProposalSetRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findLatestByCaseId(caseId: string): Promise<ProposalSet | null> {
    const set = await this.prisma.proposalSet.findFirst({
      where: { caseId },
      orderBy: { version: 'desc' },
      include: { variants: true }
    });

    if (!set) {
      return null;
    }

    return {
      id: set.id,
      case_id: set.caseId,
      version: set.version,
      mediation_summary_version: set.mediationSummaryVersion,
      created_at: set.createdAt,
      variants: set.variants
        .sort((a, b) => a.variantType.localeCompare(b.variantType))
        .map((variant) =>
          this.mapPayload(variant.payloadJson as Prisma.JsonObject, variant.variantType)
        )
    };
  }

  async save(proposalSet: ProposalSet): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.proposalSet.create({
        data: {
          id: proposalSet.id,
          caseId: proposalSet.case_id,
          version: proposalSet.version,
          mediationSummaryVersion: proposalSet.mediation_summary_version,
          createdAt: proposalSet.created_at
        }
      });

      await tx.proposalVariant.createMany({
        data: proposalSet.variants.map((variant) => ({
          id: `${proposalSet.id}:${variant.variant_type}`,
          proposalSetId: proposalSet.id,
          variantType: toPrismaVariantType(variant.variant_type),
          payloadJson: variant as unknown as Prisma.InputJsonValue
        }))
      });
    });
  }

  private mapPayload(payload: Prisma.JsonObject, variantType: string): ProposalVariant {
    const mapped = payload as unknown as ProposalVariant;
    return {
      ...mapped,
      variant_type: variantType as ProposalVariantType
    };
  }
}
