import {
  IntakeField as PrismaIntakeField,
  ParticipantIntakeState as PrismaParticipantIntakeState,
  Prisma,
  PrismaClient
} from '@prisma/client';
import { IntakeRepository, IntakeSaveOptions } from '../../application/ports/IntakeRepository.js';
import { IntakeConflictError } from '../../domain/intake/errors.js';
import {
  createEmptyFields,
  IntakeAssistantQuestion,
  IntakeField,
  IntakeFieldEntry,
  IntakeRawMessage,
  IntakeState,
  NormalizedPositionModel,
  ParticipantIntake,
  ParticipantIntake as ParticipantIntakeAggregate
} from '../../domain/intake/types.js';
import { ParticipantRole } from '../../domain/session/types.js';

const fieldToPrisma: Record<IntakeField, PrismaIntakeField> = {
  facts: 'FACTS',
  interpretations: 'INTERPRETATIONS',
  interests: 'INTERESTS',
  constraints: 'CONSTRAINTS',
  boundaries: 'BOUNDARIES',
  desired_outcome: 'DESIRED_OUTCOME',
  acceptable_concessions: 'ACCEPTABLE_CONCESSIONS',
  non_negotiables: 'NON_NEGOTIABLES'
};

const prismaToField = Object.fromEntries(
  Object.entries(fieldToPrisma).map(([k, v]) => [v, k])
) as Record<PrismaIntakeField, IntakeField>;

const stateToPrisma: Record<ParticipantIntakeAggregate['state'], PrismaParticipantIntakeState> = {
  NOT_STARTED: 'NOT_STARTED',
  IN_PROGRESS: 'IN_PROGRESS',
  SUMMARY_PENDING_CONFIRMATION: 'SUMMARY_PENDING_CONFIRMATION',
  COMPLETED: 'COMPLETED'
};

const toState = (value: PrismaParticipantIntakeState): ParticipantIntakeAggregate['state'] =>
  value as ParticipantIntakeAggregate['state'];

export class PrismaIntakeRepository implements IntakeRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByParticipantId(participantId: string): Promise<ParticipantIntake | null> {
    const intake = await this.prisma.participantIntake.findUnique({
      where: { participantId },
      include: {
        fieldAnswers: true,
        confirmedSummary: true,
        participant: true
      }
    });

    return intake ? this.mapIntake(intake) : null;
  }

  async findBySessionId(sessionId: string): Promise<ParticipantIntake[]> {
    const intakes = await this.prisma.participantIntake.findMany({
      where: { sessionId },
      include: {
        fieldAnswers: true,
        confirmedSummary: true,
        participant: true
      }
    });

    return intakes.map((intake) => this.mapIntake(intake));
  }

  async save(intake: ParticipantIntake, options?: IntakeSaveOptions): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.participantIntake.findUnique({ where: { id: intake.id } });

      if (
        options?.expectedVersion !== undefined &&
        existing &&
        existing.version !== options.expectedVersion
      ) {
        throw new IntakeConflictError();
      }

      await tx.participantIntake.upsert({
        where: { id: intake.id },
        update: {
          state: stateToPrisma[intake.state],
          currentField: intake.currentField ? fieldToPrisma[intake.currentField] : null,
          normalizedPositionJson: intake.normalizedPositionModel
            ? (intake.normalizedPositionModel as Prisma.InputJsonValue)
            : Prisma.DbNull,
          generatedSummary: intake.generatedSummary,
          summaryVersion: intake.summaryVersion,
          version: intake.version,
          completedAt: intake.completedAt,
          updatedAt: intake.updatedAt
        },
        create: {
          id: intake.id,
          sessionId: intake.sessionId,
          participantId: intake.participantId,
          state: stateToPrisma[intake.state],
          currentField: intake.currentField ? fieldToPrisma[intake.currentField] : null,
          normalizedPositionJson: intake.normalizedPositionModel
            ? (intake.normalizedPositionModel as Prisma.InputJsonValue)
            : Prisma.DbNull,
          generatedSummary: intake.generatedSummary,
          summaryVersion: intake.summaryVersion,
          version: intake.version,
          completedAt: intake.completedAt,
          createdAt: intake.createdAt,
          updatedAt: intake.updatedAt
        }
      });

      await tx.intakeFieldAnswer.deleteMany({ where: { intakeId: intake.id } });
      await tx.intakeFieldAnswer.createMany({
        data: Object.values(intake.fields)
          .filter((entry) => Boolean(entry.rawValue && entry.normalizedValue))
          .map((entry) => ({
            intakeId: intake.id,
            field: fieldToPrisma[entry.field],
            rawValue: entry.rawValue!,
            normalizedValue: entry.normalizedValue!
          }))
      });

      if (intake.confirmedSummary) {
        await tx.intakeConfirmedSummary.upsert({
          where: { intakeId: intake.id },
          update: {
            summaryText: intake.confirmedSummary,
            confirmedAt: intake.completedAt ?? new Date()
          },
          create: {
            intakeId: intake.id,
            summaryText: intake.confirmedSummary,
            confirmedAt: intake.completedAt ?? new Date()
          }
        });
      }
    });
  }

  async saveRawMessage(message: IntakeRawMessage): Promise<void> {
    await this.prisma.intakeRawMessage.create({
      data: {
        id: message.id,
        intakeId: message.intakeId,
        participantId: message.participantId,
        field: fieldToPrisma[message.field],
        content: message.content,
        createdAt: message.createdAt
      }
    });
  }

  async saveAssistantQuestion(question: IntakeAssistantQuestion): Promise<void> {
    await this.prisma.intakeAssistantQuestion.create({
      data: {
        id: question.id,
        intakeId: question.intakeId,
        participantId: question.participantId,
        field: fieldToPrisma[question.field],
        content: question.content,
        createdAt: question.createdAt
      }
    });
  }

  async findRawMessages(intakeId: string, participantId: string): Promise<IntakeRawMessage[]> {
    const rows = await this.prisma.intakeRawMessage.findMany({
      where: { intakeId, participantId },
      orderBy: { createdAt: 'asc' }
    });

    return rows.map((row) => ({
      id: row.id,
      intakeId: row.intakeId,
      participantId: row.participantId,
      field: prismaToField[row.field],
      content: row.content,
      createdAt: row.createdAt
    }));
  }

  async findAssistantQuestions(
    intakeId: string,
    participantId: string
  ): Promise<IntakeAssistantQuestion[]> {
    const rows = await this.prisma.intakeAssistantQuestion.findMany({
      where: { intakeId, participantId },
      orderBy: { createdAt: 'asc' }
    });

    return rows.map((row) => ({
      id: row.id,
      intakeId: row.intakeId,
      participantId: row.participantId,
      field: prismaToField[row.field],
      content: row.content,
      createdAt: row.createdAt
    }));
  }

  async findConfirmedNormalizedModels(
    sessionId: string
  ): Promise<
    Array<{
      participantId: string;
      participantRole: ParticipantRole;
      state: IntakeState;
      normalizedPositionModel: NormalizedPositionModel | null;
      confirmedSummary: string | null;
      completedAt: Date | null;
    }>
  > {
    const rows = await this.prisma.participantIntake.findMany({
      where: { sessionId },
      include: {
        participant: true,
        confirmedSummary: true
      }
    });

    return rows.map((row) => ({
      participantId: row.participantId,
      participantRole: row.participant.role as ParticipantRole,
      state: row.state as IntakeState,
      normalizedPositionModel: (row.normalizedPositionJson ?? null) as NormalizedPositionModel | null,
      confirmedSummary: row.confirmedSummary?.summaryText ?? null,
      completedAt: row.completedAt
    }));
  }

  private mapIntake(record: any): ParticipantIntake {
    const baseFields = createEmptyFields(record.createdAt);
    const fieldAnswers = record.fieldAnswers ?? [];

    const fields = fieldAnswers.reduce(
      (acc: Record<IntakeField, IntakeFieldEntry>, answer: any) => {
        const field = prismaToField[answer.field as PrismaIntakeField];

        acc[field] = {
          field,
          rawValue: answer.rawValue,
          normalizedValue: answer.normalizedValue,
          updatedAt: answer.updatedAt
        };

        return acc;
      },
      baseFields
    );

    return {
      id: record.id,
      sessionId: record.sessionId,
      participantId: record.participantId,
      participantRole: record.participant?.role ?? 'PARTY_A',
      state: toState(record.state),
      currentField: record.currentField
        ? prismaToField[record.currentField as PrismaIntakeField]
        : null,
      fields,
      normalizedPositionModel: (record.normalizedPositionJson ?? null) as ParticipantIntake['normalizedPositionModel'],
      generatedSummary: record.generatedSummary,
      confirmedSummary: record.confirmedSummary?.summaryText ?? null,
      summaryVersion: record.summaryVersion,
      completedAt: record.completedAt,
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    };
  }
}
