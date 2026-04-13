import { IntakeField } from '../../domain/intake/types.js';

export const RATE_LIMIT_WINDOW_MS = 60_000;
export const GENERAL_ACTION_LIMIT = 30;
export const JOIN_ATTEMPT_LIMIT = 8;
export const INVALID_COMMAND_LIMIT = 10;

export type PendingInputKind = 'JOIN_TOKEN' | 'CREATE_TOPIC';
export type TelegramEventType = 'message' | 'callback' | 'command' | 'other';

export type MediationIntakeStepId =
  | 'situation_facts'
  | 'tension_point'
  | 'important_need_or_interest'
  | 'hard_constraint'
  | 'desired_outcome'
  | 'acceptable_flexibility';

export interface MediationIntakeStepDefinition {
  id: MediationIntakeStepId;
  question: string;
  writes: IntakeField[];
}

export const mediationIntakeSteps: MediationIntakeStepDefinition[] = [
  {
    id: 'situation_facts',
    question: 'Чтобы зафиксировать базу: что конкретно сейчас происходит?',
    writes: ['facts']
  },
  {
    id: 'tension_point',
    question: 'Что в этой ситуации задевает вас сильнее всего?',
    writes: ['interpretations']
  },
  {
    id: 'important_need_or_interest',
    question: 'Что для вас здесь важнее всего?',
    writes: ['interests']
  },
  {
    id: 'hard_constraint',
    question: 'Что для вас в таком решении точно неприемлемо?',
    writes: ['constraints', 'boundaries']
  },
  {
    id: 'desired_outcome',
    question: 'Какой результат для вас был бы рабочим?',
    writes: ['desired_outcome']
  },
  {
    id: 'acceptable_flexibility',
    question: 'Где вы готовы быть гибкими, если это поможет договориться?',
    writes: ['acceptable_concessions']
  }
];

export const mediationStepById = new Map(mediationIntakeSteps.map((step) => [step.id, step]));

export const intakeFieldToConversationKey: Record<IntakeField, string> = {
  facts: 'situation_facts',
  interpretations: 'tension_point',
  interests: 'important_need_or_interest',
  constraints: 'hard_constraint',
  boundaries: 'hard_constraint',
  desired_outcome: 'desired_outcome',
  acceptable_concessions: 'acceptable_flexibility',
  non_negotiables: 'hard_constraint'
};
