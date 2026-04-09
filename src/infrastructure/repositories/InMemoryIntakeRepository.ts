import { IntakeRepository, IntakeSaveOptions } from '../../application/ports/IntakeRepository.js';
import { IntakeConflictError } from '../../domain/intake/errors.js';
import {
  IntakeState,
  IntakeAssistantQuestion,
  NormalizedPositionModel,
  IntakeRawMessage,
  ParticipantIntake
} from '../../domain/intake/types.js';
import { ParticipantRole } from '../../domain/session/types.js';

export class InMemoryIntakeRepository implements IntakeRepository {
  private readonly intakesById = new Map<string, ParticipantIntake>();
  private readonly intakeByParticipantId = new Map<string, string>();
  private readonly rawMessages: IntakeRawMessage[] = [];
  private readonly assistantQuestions: IntakeAssistantQuestion[] = [];

  async findByParticipantId(participantId: string): Promise<ParticipantIntake | null> {
    const intakeId = this.intakeByParticipantId.get(participantId);
    if (!intakeId) {
      return null;
    }

    const intake = this.intakesById.get(intakeId);
    return intake ? structuredClone(intake) : null;
  }

  async findBySessionId(sessionId: string): Promise<ParticipantIntake[]> {
    return Array.from(this.intakesById.values())
      .filter((intake) => intake.sessionId === sessionId)
      .map((intake) => structuredClone(intake));
  }

  async save(intake: ParticipantIntake, options?: IntakeSaveOptions): Promise<void> {
    const existing = this.intakesById.get(intake.id);

    if (
      options?.expectedVersion !== undefined &&
      existing &&
      existing.version !== options.expectedVersion
    ) {
      throw new IntakeConflictError();
    }

    this.intakesById.set(intake.id, structuredClone(intake));
    this.intakeByParticipantId.set(intake.participantId, intake.id);
  }

  async saveRawMessage(message: IntakeRawMessage): Promise<void> {
    this.rawMessages.push(structuredClone(message));
  }

  async saveAssistantQuestion(question: IntakeAssistantQuestion): Promise<void> {
    this.assistantQuestions.push(structuredClone(question));
  }

  async findRawMessages(intakeId: string, participantId: string): Promise<IntakeRawMessage[]> {
    return this.rawMessages
      .filter((message) => message.intakeId === intakeId && message.participantId === participantId)
      .map((message) => structuredClone(message));
  }

  async findAssistantQuestions(
    intakeId: string,
    participantId: string
  ): Promise<IntakeAssistantQuestion[]> {
    return this.assistantQuestions
      .filter((question) => question.intakeId === intakeId && question.participantId === participantId)
      .map((question) => structuredClone(question));
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
    return Array.from(this.intakesById.values())
      .filter((intake) => intake.sessionId === sessionId)
      .map((intake) => ({
        participantId: intake.participantId,
        participantRole: intake.participantRole,
        state: intake.state,
        normalizedPositionModel: structuredClone(intake.normalizedPositionModel),
        confirmedSummary: intake.confirmedSummary,
        completedAt: intake.completedAt
      }));
  }
}
