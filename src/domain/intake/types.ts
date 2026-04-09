import { ParticipantRole } from '../session/types.js';

export const IntakeStates = {
  NOT_STARTED: 'NOT_STARTED',
  IN_PROGRESS: 'IN_PROGRESS',
  SUMMARY_PENDING_CONFIRMATION: 'SUMMARY_PENDING_CONFIRMATION',
  COMPLETED: 'COMPLETED'
} as const;

export type IntakeState = (typeof IntakeStates)[keyof typeof IntakeStates];

export const IntakeFieldOrder = [
  'facts',
  'interpretations',
  'interests',
  'constraints',
  'boundaries',
  'desired_outcome',
  'acceptable_concessions',
  'non_negotiables'
] as const;

export type IntakeField = (typeof IntakeFieldOrder)[number];

export interface IntakeFieldEntry {
  field: IntakeField;
  rawValue: string | null;
  normalizedValue: string | null;
  updatedAt: Date | null;
}

export type NormalizedPositionModel = Record<IntakeField, string>;

export interface ParticipantIntake {
  id: string;
  sessionId: string;
  participantId: string;
  participantRole: ParticipantRole;
  state: IntakeState;
  currentField: IntakeField | null;
  fields: Record<IntakeField, IntakeFieldEntry>;
  normalizedPositionModel: NormalizedPositionModel | null;
  generatedSummary: string | null;
  confirmedSummary: string | null;
  summaryVersion: number;
  completedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface IntakeRawMessage {
  id: string;
  intakeId: string;
  participantId: string;
  field: IntakeField;
  content: string;
  createdAt: Date;
}

export interface IntakeAssistantQuestion {
  id: string;
  intakeId: string;
  participantId: string;
  field: IntakeField;
  content: string;
  createdAt: Date;
}

export interface IntakeMutationArtifacts {
  rawMessage?: IntakeRawMessage;
  assistantQuestion?: IntakeAssistantQuestion;
}

export const createEmptyFields = (at: Date): Record<IntakeField, IntakeFieldEntry> =>
  IntakeFieldOrder.reduce(
    (acc, field) => {
      acc[field] = {
        field,
        rawValue: null,
        normalizedValue: null,
        updatedAt: null
      };

      return acc;
    },
    {} as Record<IntakeField, IntakeFieldEntry>
  );

export const areAllFieldsCompleted = (fields: Record<IntakeField, IntakeFieldEntry>): boolean =>
  IntakeFieldOrder.every((field) => Boolean(fields[field].rawValue && fields[field].normalizedValue));

export const buildNormalizedPositionModel = (
  fields: Record<IntakeField, IntakeFieldEntry>
): NormalizedPositionModel => {
  const model = {} as NormalizedPositionModel;

  for (const field of IntakeFieldOrder) {
    const entry = fields[field];
    if (!entry.normalizedValue) {
      throw new Error(`Field ${field} has no normalized value.`);
    }
    model[field] = entry.normalizedValue;
  }

  return model;
};

export const nextUnansweredField = (
  fields: Record<IntakeField, IntakeFieldEntry>
): IntakeField | null => IntakeFieldOrder.find((field) => !fields[field].rawValue) ?? null;

export const createParticipantIntake = (
  id: string,
  sessionId: string,
  participantId: string,
  participantRole: ParticipantRole,
  now: Date
): ParticipantIntake => ({
  id,
  sessionId,
  participantId,
  participantRole,
  state: IntakeStates.NOT_STARTED,
  currentField: IntakeFieldOrder[0],
  fields: createEmptyFields(now),
  normalizedPositionModel: null,
  generatedSummary: null,
  confirmedSummary: null,
  summaryVersion: 0,
  completedAt: null,
  version: 1,
  createdAt: now,
  updatedAt: now
});
