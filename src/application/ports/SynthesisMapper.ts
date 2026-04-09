import { NormalizedPositionModel } from '../../domain/intake/types.js';
import { StructuredSynthesis } from '../../domain/synthesis/types.js';

export interface SynthesisMapper {
  synthesize(input: {
    partyA: NormalizedPositionModel;
    partyB: NormalizedPositionModel;
  }): Promise<StructuredSynthesis>;
}
