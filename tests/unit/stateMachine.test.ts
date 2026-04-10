import { describe, expect, it } from 'vitest';
import {
  ConsentAlreadyGrantedError,
  DuplicateJoinError,
  InvalidStateTransitionError,
  ParticipantNotInSessionError
} from '../../src/domain/session/errors.js';
import {
  createSessionAggregate,
  grantConsent,
  joinSession
} from '../../src/domain/session/stateMachine.js';
import { SessionStates } from '../../src/domain/session/types.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const EXPIRY = new Date('2026-01-04T00:00:00.000Z');

describe('session state machine', () => {
  it('creates a valid invited session', () => {
    const session = createSessionAggregate('s-1', 'hash', EXPIRY, 'user-a', null, NOW);

    expect(session.state).toBe(SessionStates.INVITED);
    expect(session.participants).toHaveLength(1);
    expect(session.inviteTokenExpiresAt.toISOString()).toBe(EXPIRY.toISOString());
  });

  it('joins second participant and moves to consent_pending', () => {
    const session = createSessionAggregate('s-1', 'hash', EXPIRY, 'user-a', null, NOW);
    const joined = joinSession(session, 'user-b', NOW);

    expect(joined.state).toBe(SessionStates.CONSENT_PENDING);
    expect(joined.participants).toHaveLength(2);
  });

  it('rejects duplicate join', () => {
    const session = createSessionAggregate('s-1', 'hash', EXPIRY, 'user-a', null, NOW);

    expect(() => joinSession(session, 'user-a', NOW)).toThrow(DuplicateJoinError);
  });

  it('rejects invalid join state transition', () => {
    const session = createSessionAggregate('s-1', 'hash', EXPIRY, 'user-a', null, NOW);
    const joined = joinSession(session, 'user-b', NOW);

    expect(() => joinSession(joined, 'user-c', NOW)).toThrow(InvalidStateTransitionError);
  });

  it('records both consents and moves to consented', () => {
    const session = createSessionAggregate('s-1', 'hash', EXPIRY, 'user-a', null, NOW);
    const joined = joinSession(session, 'user-b', NOW);
    const aConsented = grantConsent(joined, 'user-a', NOW);
    const bConsented = grantConsent(aConsented, 'user-b', NOW);

    expect(aConsented.state).toBe(SessionStates.CONSENT_PENDING);
    expect(bConsented.state).toBe(SessionStates.CONSENTED);
    expect(bConsented.participants.every((p) => p.consentGrantedAt)).toBe(true);
  });

  it('rejects duplicate consent and non-participant consent', () => {
    const session = createSessionAggregate('s-1', 'hash', EXPIRY, 'user-a', null, NOW);
    const joined = joinSession(session, 'user-b', NOW);
    const consented = grantConsent(joined, 'user-a', NOW);

    expect(() => grantConsent(consented, 'user-a', NOW)).toThrow(ConsentAlreadyGrantedError);
    expect(() => grantConsent(consented, 'user-c', NOW)).toThrow(ParticipantNotInSessionError);
  });
});
