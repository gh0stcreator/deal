import {
  IntakeAssistantQuestion,
  IntakeMutationArtifacts,
  IntakeRawMessage,
  ParticipantIntake
} from '../../domain/intake/types.js';

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
}
