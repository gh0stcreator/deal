import { DomainError } from '../session/errors.js';

export class ProposalPreconditionError extends DomainError {
  constructor(message: string) {
    super('PROPOSAL_PRECONDITION_FAILED', message);
  }
}

export class ProposalValidationError extends DomainError {
  constructor(message: string) {
    super('PROPOSAL_VALIDATION_FAILED', message);
  }
}
