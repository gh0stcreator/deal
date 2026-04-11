import { Prisma, PrismaClient } from '@prisma/client';
import { DraftAgreementRepository } from '../../application/ports/DraftAgreementRepository.js';
import {
  DraftAgreement,
  DraftAgreementOutcome,
  DraftAgreementResponse,
  DraftAgreementResponseType
} from '../../domain/agreement/types.js';

const asJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

export class PrismaDraftAgreementRepository implements DraftAgreementRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findLatestByCaseId(caseId: string): Promise<DraftAgreement | null> {
    const record = await this.prisma.draftAgreement.findFirst({
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
      loopVersion: record.loopVersion,
      sourceOptionId: record.sourceOptionId,
      agreementTitle: record.agreementTitle,
      agreedActions: record.agreedActionsJson as unknown as string[],
      boundaries: record.boundariesJson as unknown as string[],
      conditions: record.conditionsJson as unknown as string[],
      fallbackRule: record.fallbackRule,
      reviewPoint: record.reviewPoint,
      createdAt: record.createdAt
    };
  }

  async saveDraft(draft: DraftAgreement): Promise<void> {
    await this.prisma.draftAgreement.create({
      data: {
        id: draft.id,
        caseId: draft.caseId,
        version: draft.version,
        loopVersion: draft.loopVersion,
        sourceOptionId: draft.sourceOptionId,
        agreementTitle: draft.agreementTitle,
        agreedActionsJson: asJson(draft.agreedActions),
        boundariesJson: asJson(draft.boundaries),
        conditionsJson: asJson(draft.conditions),
        fallbackRule: draft.fallbackRule,
        reviewPoint: draft.reviewPoint,
        createdAt: draft.createdAt
      }
    });
  }

  async listByCaseId(caseId: string): Promise<DraftAgreement[]> {
    const records = await this.prisma.draftAgreement.findMany({
      where: { caseId },
      orderBy: { version: 'asc' }
    });
    return records.map((record) => ({
      id: record.id,
      caseId: record.caseId,
      version: record.version,
      loopVersion: record.loopVersion,
      sourceOptionId: record.sourceOptionId,
      agreementTitle: record.agreementTitle,
      agreedActions: record.agreedActionsJson as unknown as string[],
      boundaries: record.boundariesJson as unknown as string[],
      conditions: record.conditionsJson as unknown as string[],
      fallbackRule: record.fallbackRule,
      reviewPoint: record.reviewPoint,
      createdAt: record.createdAt
    }));
  }

  async saveOrUpdateResponse(response: DraftAgreementResponse): Promise<void> {
    await this.prisma.draftAgreementResponse.upsert({
      where: {
        caseId_draftVersion_participantId: {
          caseId: response.caseId,
          draftVersion: response.draftVersion,
          participantId: response.participantId
        }
      },
      create: {
        id: response.id,
        caseId: response.caseId,
        draftVersion: response.draftVersion,
        participantId: response.participantId,
        responseType: response.responseType,
        changeRequest: response.changeRequest,
        createdAt: response.createdAt
      },
      update: {
        id: response.id,
        responseType: response.responseType,
        changeRequest: response.changeRequest,
        createdAt: response.createdAt
      }
    });
  }

  async listResponses(caseId: string, draftVersion: number): Promise<DraftAgreementResponse[]> {
    const records = await this.prisma.draftAgreementResponse.findMany({
      where: { caseId, draftVersion },
      orderBy: { createdAt: 'asc' }
    });
    return records.map((record) => ({
      id: record.id,
      caseId: record.caseId,
      draftVersion: record.draftVersion,
      participantId: record.participantId,
      responseType: record.responseType as DraftAgreementResponseType,
      changeRequest: record.changeRequest,
      createdAt: record.createdAt
    }));
  }

  async upsertOutcome(outcome: DraftAgreementOutcome): Promise<void> {
    await this.prisma.draftAgreementOutcome.upsert({
      where: {
        caseId_draftVersion: {
          caseId: outcome.caseId,
          draftVersion: outcome.draftVersion
        }
      },
      create: {
        id: outcome.id,
        caseId: outcome.caseId,
        draftVersion: outcome.draftVersion,
        outcome: outcome.outcome,
        createdAt: outcome.createdAt
      },
      update: {
        id: outcome.id,
        outcome: outcome.outcome,
        createdAt: outcome.createdAt
      }
    });
  }

  async findOutcome(caseId: string, draftVersion: number): Promise<DraftAgreementOutcome | null> {
    const record = await this.prisma.draftAgreementOutcome.findUnique({
      where: {
        caseId_draftVersion: {
          caseId,
          draftVersion
        }
      }
    });
    if (!record) {
      return null;
    }
    return {
      id: record.id,
      caseId: record.caseId,
      draftVersion: record.draftVersion,
      outcome: record.outcome,
      createdAt: record.createdAt
    };
  }
}
