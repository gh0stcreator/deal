import { IntakeDialogManager, IntakeDialogResult, ConversationTurn } from '../../application/ports/IntakeDialogManager.js';
import { IntakeField } from '../../domain/intake/types.js';

const PRIMARY_FIELDS: IntakeField[] = [
  'facts',
  'interpretations',
  'interests',
  'constraints',
  'desired_outcome',
  'acceptable_concessions'
];

const NEXT_QUESTION: Partial<Record<IntakeField, string>> = {
  facts: 'Что в этой ситуации задевает вас сильнее всего?',
  interpretations: 'Что для вас здесь важнее всего?',
  interests: 'Что для вас в таком решении точно неприемлемо?',
  constraints: 'Какой результат для вас был бы рабочим?',
  desired_outcome: 'Где вы готовы быть гибкими, если это поможет договориться?'
};

export class DeterministicIntakeDialogManager implements IntakeDialogManager {
  async processTurn(input: {
    topic: string;
    history: ConversationTurn[];
    collectedFields: Partial<Record<string, string>>;
    latestUserMessage: string;
  }): Promise<IntakeDialogResult> {
    // Find first field from primary list that is NOT in collectedFields
    const currentField = PRIMARY_FIELDS.find((field) => !input.collectedFields[field]);

    if (!currentField) {
      // All fields collected — should not normally happen but handle gracefully
      return {
        reply: 'Услышал. Этого достаточно для следующего шага.',
        extractedFields: {},
        isComplete: true
      };
    }

    // Extract the current field from latest user message
    // Note: boundaries is auto-derived from constraints in the domain state machine
    const extractedFields: Partial<Record<IntakeField, string>> = {
      [currentField]: input.latestUserMessage
    };

    // Build reply
    const nextFieldIndex = PRIMARY_FIELDS.indexOf(currentField) + 1;
    const nextField = PRIMARY_FIELDS[nextFieldIndex] as IntakeField | undefined;
    const nextQuestion = nextField ? NEXT_QUESTION[currentField] : undefined;

    let reply: string;
    if (nextQuestion) {
      reply = nextQuestion;
    } else {
      reply = 'Услышал.';
    }

    const isComplete = currentField === 'acceptable_concessions';

    return { reply, extractedFields, isComplete };
  }
}
