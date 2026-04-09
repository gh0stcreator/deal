import {
  IntakeAssistantQuestion,
  IntakeMutationArtifacts,
  IntakeRawMessage,
  IntakeState,
  ParticipantIntake
} from '../../domain/intake/types.js';
import { NormalizedPositionModel } from '../../domain/intake/types.js';
import { ParticipantRole } from '../../domain/session/types.js';

export interface IntakeSaveOptions {
  expectedVersion?: number;
  artifacts?: IntakeMutationArtifacts;
}

export interface IntakeRepository {
  findByParticipantId(participantId: string): Promise<ParticipantIntake | null>;
  findBySessionId(sessionId: string): Promise<ParticipantIntake[]>;
  save(intake: ParticipantIntake, options?: IntakeSaveOptions): Promise<void>;
  saveRawMessage(message: IntakeRawMessage): Promise<void>;
  saveAssistantQuestion(question: IntakeAssistantQuestion): Promise<void>;
  findRawMessages(intakeId: string, participantId: string): Promise<IntakeRawMessage[]>;
  findAssistantQuestions(intakeId: string, participantId: string): Promise<IntakeAssistantQuestion[]>;
  findConfirmedNormalizedModels(
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
  >;
}
