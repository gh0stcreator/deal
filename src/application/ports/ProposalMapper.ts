import { StructuredSynthesis } from '../../domain/synthesis/types.js';
import { ProposalVariant } from '../../domain/proposal/types.js';

export interface ProposalMapper {
  generateVariants(input: {
    synthesis: StructuredSynthesis;
  }): Promise<[ProposalVariant, ProposalVariant, ProposalVariant]>;
}
