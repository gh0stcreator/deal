import { Clock } from '../ports/Clock.js';
import { IdGenerator } from '../ports/IdGenerator.js';
import { IntakeNormalizer } from '../ports/IntakeNormalizer.js';
import { IntakeRepository } from '../ports/IntakeRepository.js';
import { SessionRepository } from '../ports/SessionRepository.js';
import {
  IntakeAccessDeniedError,
  IntakeNotFoundError,
  IntakeValidationError
} from '../../domain/intake/errors.js';
import {
  confirmSummary,
  editIntakeField,
  reopenCompletedIntake,
  setSummaryPendingConfirmation,
  startIntake,
  submitIntakeField
} from '../../domain/intake/stateMachine.js';
import {
  createParticipantIntake,
  IntakeField,
  IntakeFieldOrder,
  IntakeStates,
  ParticipantIntake
} from '../../domain/intake/types.js';
import { InvalidStateTransitionError, SessionNotFoundError } from '../../domain/session/errors.js';
import {
  MediationSession,
  Participant,
  ParticipantRole,
  SessionStates
} from '../../domain/session/types.js';

const questionByField: Record<IntakeField, string> = {
  facts: 'List the key facts as concretely as possible.',
  interpretations: 'How do you interpret what happened?',
  interests: 'What interests matter most to you?',
  constraints: 'What constraints limit your options?',
  boundaries: 'What boundaries must be respected?',
  desired_outcome: 'What outcome would you consider successful?',
  acceptable_concessions: 'Which concessions are acceptable to you?',
  non_negotiables: 'What is strictly non-negotiable for you?'
};

export interface IntakeView {
  intakeId: string;
  state: ParticipantIntake['state'];
  currentField: IntakeField | null;
  summaryVersion: number;
  generatedSummary: string | null;
  confirmedSummary: string | null;
  completedAt: Date | null;
  version: number;
  fields: ParticipantIntake['fields'];
}

export interface PrivateIntakeData {
  view: IntakeView;
  rawMessages: Awaited<ReturnType<IntakeRepository['findRawMessages']>>;
  assistantQuestions: Awaited<ReturnType<IntakeRepository['findAssistantQuestions']>>;
}

export class IntakeService {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly intakeRepository: IntakeRepository,
    private readonly normalizer: IntakeNormalizer,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock
  ) {}

  async startOrResume(sessionId: string, telegramUserId: string): Promise<IntakeView> {
    const { session, participant } = await this.requireParticipant(sessionId, telegramUserId);

    if (
      session.state !== SessionStates.CONSENTED &&
      session.state !== SessionStates.SIDE_A_INTAKE &&
      session.state !== SessionStates.SIDE_B_INTAKE &&
      session.state !== SessionStates.READY_FOR_SYNTHESIS
    ) {
      throw new InvalidStateTransitionError(
        `Cannot start intake while session is in state ${session.state}.`
      );
    }

    const now = this.clock.now();
    let intake = await this.intakeRepository.findByParticipantId(participant.id);

    if (!intake) {
      intake = createParticipantIntake(
        this.idGenerator.nextId(),
        session.id,
        participant.id,
        participant.role,
        now
      );
      await this.intakeRepository.save(intake);
    }

    if (intake.state === IntakeStates.NOT_STARTED) {
      const started = startIntake(intake, now);
      await this.intakeRepository.save(started, { expectedVersion: intake.version });
      intake = started;

      if (intake.currentField) {
        await this.intakeRepository.saveAssistantQuestion({
          id: this.idGenerator.nextId(),
          intakeId: intake.id,
          participantId: participant.id,
          field: intake.currentField,
          content: questionByField[intake.currentField],
          createdAt: now
        });
      }
    }

    return this.toView(intake);
  }

  async submitFieldAnswer(input: {
    sessionId: string;
    telegramUserId: string;
    field: IntakeField;
    rawValue: string;
    expectedVersion: number;
  }): Promise<IntakeView> {
    const { participant } = await this.requireParticipant(input.sessionId, input.telegramUserId);
    const now = this.clock.now();

    const intake = await this.requireIntake(participant.id);

    this.ensureFieldOrdering(intake, input.field);

    const normalizedValue = await this.normalizer.normalizeField(input.field, input.rawValue);

    const next =
      intake.state === IntakeStates.SUMMARY_PENDING_CONFIRMATION
        ? editIntakeField(intake, input.field, input.rawValue, normalizedValue, now)
        : submitIntakeField(intake, input.field, input.rawValue, normalizedValue, now);

    let persisted = next;

    if (next.state === IntakeStates.SUMMARY_PENDING_CONFIRMATION) {
      const summary = await this.normalizer.generateSummary(next.normalizedPositionModel!);
      persisted = setSummaryPendingConfirmation(next, summary, now);
    }

    await this.intakeRepository.save(persisted, {
      expectedVersion: input.expectedVersion
    });

    await this.intakeRepository.saveRawMessage({
      id: this.idGenerator.nextId(),
      intakeId: persisted.id,
      participantId: participant.id,
      field: input.field,
      content: input.rawValue,
      createdAt: now
    });

    if (persisted.currentField) {
      await this.intakeRepository.saveAssistantQuestion({
        id: this.idGenerator.nextId(),
        intakeId: persisted.id,
        participantId: participant.id,
        field: persisted.currentField,
        content: questionByField[persisted.currentField],
        createdAt: now
      });
    }

    await this.updateSessionIntakeState(input.sessionId);

    return this.toView(persisted);
  }

  async regenerateSummary(input: {
    sessionId: string;
    telegramUserId: string;
    expectedVersion: number;
  }): Promise<IntakeView> {
    const { participant } = await this.requireParticipant(input.sessionId, input.telegramUserId);
    const intake = await this.requireIntake(participant.id);

    if (!intake.normalizedPositionModel) {
      throw new IntakeValidationError('Cannot generate summary before all required fields are completed.');
    }

    const summary = await this.normalizer.generateSummary(intake.normalizedPositionModel);
    const updated = setSummaryPendingConfirmation(intake, summary, this.clock.now());

    await this.intakeRepository.save(updated, { expectedVersion: input.expectedVersion });

    return this.toView(updated);
  }

  async confirmSummary(input: {
    sessionId: string;
    telegramUserId: string;
    summary: string;
    expectedVersion: number;
  }): Promise<IntakeView> {
    const { participant } = await this.requireParticipant(input.sessionId, input.telegramUserId);
    const intake = await this.requireIntake(participant.id);

    const updated = confirmSummary(intake, input.summary, this.clock.now());

    await this.intakeRepository.save(updated, { expectedVersion: input.expectedVersion });
    await this.updateSessionIntakeState(input.sessionId);

    return this.toView(updated);
  }

  async reopenIntake(input: {
    sessionId: string;
    telegramUserId: string;
    expectedVersion: number;
  }): Promise<IntakeView> {
    const { participant } = await this.requireParticipant(input.sessionId, input.telegramUserId);
    const intake = await this.requireIntake(participant.id);
    const reopened = reopenCompletedIntake(intake, this.clock.now());

    await this.intakeRepository.save(reopened, { expectedVersion: input.expectedVersion });
    await this.updateSessionIntakeState(input.sessionId);

    return this.toView(reopened);
  }

  async getPrivateIntakeData(
    sessionId: string,
    telegramUserId: string
  ): Promise<PrivateIntakeData> {
    const { participant } = await this.requireParticipant(sessionId, telegramUserId);
    const intake = await this.requireIntake(participant.id);
    const [rawMessages, assistantQuestions] = await Promise.all([
      this.intakeRepository.findRawMessages(intake.id, participant.id),
      this.intakeRepository.findAssistantQuestions(intake.id, participant.id)
    ]);

    return {
      view: this.toView(intake),
      rawMessages,
      assistantQuestions
    };
  }

  async savePrivateProblemClarification(
    sessionId: string,
    telegramUserId: string,
    clarification: string
  ): Promise<void> {
    const { participant } = await this.requireParticipant(sessionId, telegramUserId);
    const intake = await this.requireIntake(participant.id);
    const content = clarification.trim();
    if (!content) {
      throw new IntakeValidationError('Problem clarification cannot be empty.');
    }

    await this.intakeRepository.saveRawMessage({
      id: this.idGenerator.nextId(),
      intakeId: intake.id,
      participantId: participant.id,
      field: 'facts',
      content: `[problem_synthesis_clarification] ${content}`,
      createdAt: this.clock.now()
    });
  }

  private async requireParticipant(
    sessionId: string,
    telegramUserId: string
  ): Promise<{ session: MediationSession; participant: Participant }> {
    const session = await this.sessionRepository.findById(sessionId);
    if (!session) {
      throw new SessionNotFoundError();
    }

    const participant = session.participants.find((p) => p.telegramUserId === telegramUserId);
    if (!participant) {
      throw new IntakeAccessDeniedError();
    }

    return { session, participant };
  }

  private async requireIntake(participantId: string): Promise<ParticipantIntake> {
    const intake = await this.intakeRepository.findByParticipantId(participantId);
    if (!intake) {
      throw new IntakeNotFoundError();
    }

    return intake;
  }

  private ensureFieldOrdering(intake: ParticipantIntake, field: IntakeField): void {
    const fieldIndex = IntakeFieldOrder.indexOf(field);

    const firstMissingIndex = IntakeFieldOrder.findIndex(
      (candidate) => !intake.fields[candidate].rawValue
    );

    if (firstMissingIndex === -1) {
      return;
    }

    if (fieldIndex > firstMissingIndex) {
      throw new IntakeValidationError(
        `Field ${field} cannot be answered before ${IntakeFieldOrder[firstMissingIndex]}.`
      );
    }
  }

  private async updateSessionIntakeState(sessionId: string): Promise<void> {
    const session = await this.sessionRepository.findById(sessionId);
    if (!session) {
      throw new SessionNotFoundError();
    }

    const intakes = await this.intakeRepository.findBySessionId(sessionId);
    const byRole = new Map<ParticipantRole, ParticipantIntake>();

    for (const intake of intakes) {
      byRole.set(intake.participantRole, intake);
    }

    const aState = byRole.get('PARTY_A')?.state;
    const bState = byRole.get('PARTY_B')?.state;

    let nextSessionState = session.state;

    if (aState === IntakeStates.COMPLETED && bState === IntakeStates.COMPLETED) {
      nextSessionState = SessionStates.READY_FOR_SYNTHESIS;
    } else if (aState === IntakeStates.COMPLETED) {
      nextSessionState = SessionStates.SIDE_B_INTAKE;
    } else if (bState === IntakeStates.COMPLETED) {
      nextSessionState = SessionStates.SIDE_A_INTAKE;
    } else if (aState || bState) {
      nextSessionState = SessionStates.SIDE_A_INTAKE;
    }

    if (nextSessionState !== session.state) {
      await this.sessionRepository.save({
        ...session,
        state: nextSessionState,
        updatedAt: this.clock.now()
      });
    }
  }

  private toView(intake: ParticipantIntake): IntakeView {
    return {
      intakeId: intake.id,
      state: intake.state,
      currentField: intake.currentField,
      summaryVersion: intake.summaryVersion,
      generatedSummary: intake.generatedSummary,
      confirmedSummary: intake.confirmedSummary,
      completedAt: intake.completedAt,
      version: intake.version,
      fields: intake.fields
    };
  }
}
