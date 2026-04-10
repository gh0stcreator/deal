import { DomainError } from '../session/errors.js';

export class TransportAccessDeniedError extends DomainError {
  constructor() {
    super('TRANSPORT_ACCESS_DENIED', 'Participant is not authorized for this session action.');
  }
}
