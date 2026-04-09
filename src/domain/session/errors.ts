export class DomainError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class InvalidStateTransitionError extends DomainError {
  constructor(message: string) {
    super('INVALID_STATE_TRANSITION', message);
  }
}

export class InvalidInviteTokenError extends DomainError {
  constructor() {
    super('INVALID_INVITE_TOKEN', 'Invite token is invalid or expired.');
  }
}

export class ExpiredInviteTokenError extends DomainError {
  constructor() {
    super('EXPIRED_INVITE_TOKEN', 'Invite token has expired.');
  }
}

export class DuplicateJoinError extends DomainError {
  constructor() {
    super('DUPLICATE_JOIN', 'This participant has already joined the session.');
  }
}

export class ConsentAlreadyGrantedError extends DomainError {
  constructor() {
    super('CONSENT_ALREADY_GRANTED', 'Consent has already been granted.');
  }
}

export class ParticipantNotInSessionError extends DomainError {
  constructor() {
    super('PARTICIPANT_NOT_IN_SESSION', 'Participant is not part of this session.');
  }
}

export class SessionNotFoundError extends DomainError {
  constructor() {
    super('SESSION_NOT_FOUND', 'Session was not found.');
  }
}
