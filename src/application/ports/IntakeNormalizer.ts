import { IntakeField, NormalizedPositionModel } from '../../domain/intake/types.js';

export interface IntakePromptContext {
  systemPrompt: string;
  stage: 'intake';
  questionText?: string;
}

export interface IntakeNormalizationResult {
  reflection: string;
  extractedValue: string;
  needsClarification: boolean;
}

export interface IntakeNormalizer {
  normalizeField(
    field: IntakeField,
    rawValue: string,
    context?: IntakePromptContext
  ): Promise<IntakeNormalizationResult>;
  generateSummary(model: NormalizedPositionModel, context?: IntakePromptContext): Promise<string>;
}

export class DeterministicIntakeNormalizer implements IntakeNormalizer {
  async normalizeField(
    _field: IntakeField,
    rawValue: string,
    _context?: IntakePromptContext
  ): Promise<IntakeNormalizationResult> {
    const extracted = rawValue.trim().replace(/\s+/g, ' ');
    return {
      reflection:
        extracted.length > 0
          ? 'Я фиксирую ваш смысл и переведу его в рабочую формулировку для следующего шага.'
          : 'Нужно немного уточнить формулировку, чтобы можно было двигаться дальше.',
      extractedValue: extracted,
      needsClarification: extracted.length === 0
    };
  }

  async generateSummary(
    model: NormalizedPositionModel,
    _context?: IntakePromptContext
  ): Promise<string> {
    return [
      `Facts: ${model.facts}`,
      `Interpretations: ${model.interpretations}`,
      `Interests: ${model.interests}`,
      `Constraints: ${model.constraints}`,
      `Boundaries: ${model.boundaries}`,
      `Desired outcome: ${model.desired_outcome}`,
      `Acceptable concessions: ${model.acceptable_concessions}`,
      `Non-negotiables: ${model.non_negotiables}`
    ].join('\n');
  }
}
