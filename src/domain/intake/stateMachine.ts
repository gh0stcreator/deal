import { InvalidStateTransitionError } from '../session/errors.js';
import { SummaryMismatchError } from './errors.js';
import {
  areAllFieldsCompleted,
  buildNormalizedPositionModel,
  IntakeField,
  IntakeFieldOrder,
  IntakeStates,
  nextUnansweredField,
  ParticipantIntake
} from './types.js';

export const startIntake = (intake: ParticipantIntake, now: Date): ParticipantIntake => {
  if (intake.state === IntakeStates.NOT_STARTED) {
    return {
      ...intake,
      state: IntakeStates.IN_PROGRESS,
      currentField: nextUnansweredField(intake.fields),
      updatedAt: now,
      version: intake.version + 1
    };
  }

  if (intake.state === IntakeStates.IN_PROGRESS) {
    return intake;
  }

  throw new InvalidStateTransitionError(
    `Cannot start intake from state ${intake.state}.`
  );
};

export const submitIntakeField = (
  intake: ParticipantIntake,
  field: IntakeField,
  rawValue: string,
  normalizedValue: string,
  now: Date
): ParticipantIntake => {
  if (intake.state !== IntakeStates.IN_PROGRESS) {
    throw new InvalidStateTransitionError(
      `Cannot submit field while intake is in state ${intake.state}.`
    );
  }

  const cleanedRaw = rawValue.trim();
  const cleanedNormalized = normalizedValue.trim();

  if (!cleanedRaw || !cleanedNormalized) {
    throw new InvalidStateTransitionError('Raw and normalized values must be non-empty.');
  }

  // boundaries is always derived from constraints — keep them in sync automatically
  const updatedFields: typeof intake.fields = {
    ...intake.fields,
    [field]: {
      ...intake.fields[field],
      rawValue: cleanedRaw,
      normalizedValue: cleanedNormalized,
      updatedAt: now
    }
  };
  if (field === 'constraints') {
    updatedFields.boundaries = {
      ...intake.fields.boundaries,
      rawValue: cleanedRaw,
      normalizedValue: cleanedNormalized,
      updatedAt: now
    };
  }

  const allDone = areAllFieldsCompleted(updatedFields);

  return {
    ...intake,
    fields: updatedFields,
    state: allDone ? IntakeStates.SUMMARY_PENDING_CONFIRMATION : IntakeStates.IN_PROGRESS,
    currentField: allDone ? null : nextUnansweredField(updatedFields),
    normalizedPositionModel: allDone ? buildNormalizedPositionModel(updatedFields) : null,
    generatedSummary: allDone ? intake.generatedSummary : null,
    confirmedSummary: null,
    completedAt: null,
    updatedAt: now,
    version: intake.version + 1
  };
};

export const editIntakeField = (
  intake: ParticipantIntake,
  field: IntakeField,
  rawValue: string,
  normalizedValue: string,
  now: Date
): ParticipantIntake => {
  if (
    intake.state !== IntakeStates.IN_PROGRESS &&
    intake.state !== IntakeStates.SUMMARY_PENDING_CONFIRMATION
  ) {
    throw new InvalidStateTransitionError(
      `Cannot edit field while intake is in state ${intake.state}.`
    );
  }

  const resetToProgress: ParticipantIntake = {
    ...intake,
    state: IntakeStates.IN_PROGRESS,
    generatedSummary: null,
    confirmedSummary: null,
    completedAt: null
  };

  return submitIntakeField(resetToProgress, field, rawValue, normalizedValue, now);
};

export const setSummaryPendingConfirmation = (
  intake: ParticipantIntake,
  generatedSummary: string,
  now: Date
): ParticipantIntake => {
  if (!areAllFieldsCompleted(intake.fields)) {
    throw new InvalidStateTransitionError('Cannot generate summary before all fields are present.');
  }

  if (
    intake.state !== IntakeStates.IN_PROGRESS &&
    intake.state !== IntakeStates.SUMMARY_PENDING_CONFIRMATION
  ) {
    throw new InvalidStateTransitionError(
      `Cannot generate summary from state ${intake.state}.`
    );
  }

  return {
    ...intake,
    state: IntakeStates.SUMMARY_PENDING_CONFIRMATION,
    currentField: null,
    normalizedPositionModel: buildNormalizedPositionModel(intake.fields),
    generatedSummary: generatedSummary.trim(),
    summaryVersion: intake.summaryVersion + 1,
    updatedAt: now,
    version: intake.version + 1
  };
};

export const confirmSummary = (
  intake: ParticipantIntake,
  confirmedSummary: string,
  now: Date
): ParticipantIntake => {
  if (intake.state !== IntakeStates.SUMMARY_PENDING_CONFIRMATION) {
    throw new InvalidStateTransitionError(
      `Cannot confirm summary from state ${intake.state}.`
    );
  }

  if (!intake.generatedSummary) {
    throw new InvalidStateTransitionError('Summary must be generated before confirmation.');
  }

  if (confirmedSummary.trim() !== intake.generatedSummary.trim()) {
    throw new SummaryMismatchError();
  }

  return {
    ...intake,
    state: IntakeStates.COMPLETED,
    confirmedSummary: intake.generatedSummary,
    completedAt: now,
    updatedAt: now,
    version: intake.version + 1
  };
};

export const reopenCompletedIntake = (
  intake: ParticipantIntake,
  now: Date
): ParticipantIntake => {
  if (intake.state !== IntakeStates.COMPLETED) {
    throw new InvalidStateTransitionError(
      `Cannot reopen intake from state ${intake.state}.`
    );
  }

  return {
    ...intake,
    state: IntakeStates.IN_PROGRESS,
    generatedSummary: null,
    confirmedSummary: null,
    completedAt: null,
    currentField: IntakeFieldOrder[0],
    updatedAt: now,
    version: intake.version + 1
  };
};
