import { NormalizedPositionModel } from '../../domain/intake/types.js';
import { StructuredSynthesis } from '../../domain/synthesis/types.js';

export interface SynthesisPromptContext {
  systemPrompt: string;
  stage: 'synthesis';
}

export interface SynthesisMapper {
  synthesize(input: {
    partyA: NormalizedPositionModel;
    partyB: NormalizedPositionModel;
  }, context?: SynthesisPromptContext): Promise<StructuredSynthesis>;
}
