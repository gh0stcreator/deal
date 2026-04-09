import { DomainError } from '../session/errors.js';

export class IntakeNotFoundError extends DomainError {
  constructor() {
    super('INTAKE_NOT_FOUND', 'Participant intake was not found.');
  }
}

export class IntakeConflictError extends DomainError {
  constructor() {
    super('INTAKE_CONFLICT', 'Intake was updated concurrently. Please retry.');
  }
}

export class IntakeAccessDeniedError extends DomainError {
  constructor() {
    super('INTAKE_ACCESS_DENIED', 'Participant does not have access to this intake.');
  }
}

export class IntakeValidationError extends DomainError {
  constructor(message: string) {
    super('INTAKE_VALIDATION_ERROR', message);
  }
}

export class SummaryMismatchError extends DomainError {
  constructor() {
    super('SUMMARY_MISMATCH', 'Provided summary does not match current generated summary.');
  }
}
