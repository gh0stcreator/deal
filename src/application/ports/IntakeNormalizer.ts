import { IntakeField, NormalizedPositionModel } from '../../domain/intake/types.js';

export interface IntakeNormalizer {
  normalizeField(field: IntakeField, rawValue: string): Promise<string>;
  generateSummary(model: NormalizedPositionModel): Promise<string>;
}

export class DeterministicIntakeNormalizer implements IntakeNormalizer {
  async normalizeField(_field: IntakeField, rawValue: string): Promise<string> {
    return rawValue.trim().replace(/\s+/g, ' ');
  }

  async generateSummary(model: NormalizedPositionModel): Promise<string> {
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
