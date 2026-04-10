import { describe, expect, it } from 'vitest';
import { InvalidStateTransitionError } from '../../src/domain/session/errors.js';
import {
  markAbandoned,
  markAgreementReached,
  markDeadlock,
  markNegotiationInProgress,
  markPartialAgreement,
  markProposalsGenerated
} from '../../src/domain/session/stateMachine.js';
import { SessionStates, type MediationSession } from '../../src/domain/session/types.js';

const NOW = new Date('2026-01-10T00:00:00.000Z');

const baseSession = (state: keyof typeof SessionStates | (typeof SessionStates)[keyof typeof SessionStates]): MediationSession => ({
  id: 's-1',
  state: typeof state === 'string' ? state : SessionStates.CREATED,
  inviteTokenHash: 'hash',
  inviteTokenExpiresAt: new Date('2026-01-12T00:00:00.000Z'),
  participants: [
    {
      id: 's-1:PARTY_A',
      role: 'PARTY_A',
      telegramUserId: 'a',
      consentGrantedAt: NOW
    },
    {
      id: 's-1:PARTY_B',
      role: 'PARTY_B',
      telegramUserId: 'b',
      consentGrantedAt: NOW
    }
  ],
  createdAt: NOW,
  updatedAt: NOW
});

describe('negotiation state transitions', () => {
  it('moves from proposals_generated to negotiation_in_progress', () => {
    const session = baseSession(SessionStates.PROPOSALS_GENERATED);
    const next = markNegotiationInProgress(session, NOW);

    expect(next.state).toBe(SessionStates.NEGOTIATION_IN_PROGRESS);
  });

  it('marks agreement/partial/deadlock from negotiation_in_progress', () => {
    const session = baseSession(SessionStates.NEGOTIATION_IN_PROGRESS);

    expect(markAgreementReached(session, NOW).state).toBe(SessionStates.AGREEMENT_REACHED);
    expect(markPartialAgreement(session, NOW).state).toBe(SessionStates.PARTIAL_AGREEMENT);
    expect(markDeadlock(session, NOW).state).toBe(SessionStates.DEADLOCK);
  });

  it('allows abandonment from proposals_generated and negotiation_in_progress', () => {
    const fromGenerated = markAbandoned(baseSession(SessionStates.PROPOSALS_GENERATED), NOW);
    const fromNegotiation = markAbandoned(baseSession(SessionStates.NEGOTIATION_IN_PROGRESS), NOW);

    expect(fromGenerated.state).toBe(SessionStates.ABANDONED);
    expect(fromNegotiation.state).toBe(SessionStates.ABANDONED);
  });

  it('rejects invalid negotiation transitions', () => {
    expect(() => markNegotiationInProgress(baseSession(SessionStates.CONSENTED), NOW)).toThrow(
      InvalidStateTransitionError
    );
    expect(() => markAgreementReached(baseSession(SessionStates.PROPOSALS_GENERATED), NOW)).toThrow(
      InvalidStateTransitionError
    );
    expect(() => markAbandoned(baseSession(SessionStates.CONSENTED), NOW)).toThrow(
      InvalidStateTransitionError
    );
  });

  it('still enforces proposal generation precondition', () => {
    expect(() => markProposalsGenerated(baseSession(SessionStates.SYNTHESIS_COMPLETED), NOW)).toThrow(
      InvalidStateTransitionError
    );
  });
});
