import { DomainError } from '../session/errors.js';

export class SynthesisPreconditionError extends DomainError {
  constructor(message: string) {
    super('SYNTHESIS_PRECONDITION_FAILED', message);
  }
}
