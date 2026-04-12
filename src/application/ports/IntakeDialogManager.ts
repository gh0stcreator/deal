import { IntakeField } from '../../domain/intake/types.js';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface IntakeDialogResult {
  reply: string;
  extractedFields: Partial<Record<IntakeField, string>>;
  isComplete: boolean;
}

export interface IntakeDialogManager {
  processTurn(input: {
    topic: string;
    history: ConversationTurn[];
    collectedFields: Partial<Record<string, string>>;
    latestUserMessage: string;
  }): Promise<IntakeDialogResult>;
}
