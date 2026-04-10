import { DomainError } from '../session/errors.js';

export class NegotiationPreconditionError extends DomainError {
  constructor(message: string) {
    super('NEGOTIATION_PRECONDITION_FAILED', message);
  }
}

export class NegotiationValidationError extends DomainError {
  constructor(message: string) {
    super('NEGOTIATION_VALIDATION_FAILED', message);
  }
}

export class NegotiationConflictError extends DomainError {
  constructor(message: string) {
    super('NEGOTIATION_CONFLICT', message);
  }
}
