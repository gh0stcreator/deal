import {
  ConsentAlreadyGrantedError,
  DuplicateJoinError,
  InvalidStateTransitionError,
  ParticipantNotInSessionError
} from './errors.js';
import {
  MediationSession,
  Participant,
  ParticipantRoles,
  SessionState,
  SessionStates
} from './types.js';

const TERMINAL_STATES: ReadonlySet<SessionState> = new Set([
  SessionStates.AGREEMENT,
  SessionStates.PARTIAL_AGREEMENT,
  SessionStates.DEADLOCK,
  SessionStates.ABANDONED
]);

export const createSessionAggregate = (
  id: string,
  inviteTokenHash: string,
  inviteTokenExpiresAt: Date,
  partyATelegramUserId: string,
  now: Date
): MediationSession => ({
  id,
  state: SessionStates.INVITED,
  inviteTokenHash,
  inviteTokenExpiresAt,
  participants: [
    {
      id: `${id}:${ParticipantRoles.PARTY_A}`,
      role: ParticipantRoles.PARTY_A,
      telegramUserId: partyATelegramUserId,
      consentGrantedAt: null
    }
  ],
  createdAt: now,
  updatedAt: now
});

export const joinSession = (
  session: MediationSession,
  partyBTelegramUserId: string,
  now: Date
): MediationSession => {
  if (session.participants.some((p) => p.telegramUserId === partyBTelegramUserId)) {
    throw new DuplicateJoinError();
  }

  if (session.state !== SessionStates.INVITED) {
    throw new InvalidStateTransitionError(
      `Cannot join session while in state ${session.state}.`
    );
  }

  const nextParticipants: Participant[] = [
    ...session.participants,
    {
      id: `${session.id}:${ParticipantRoles.PARTY_B}`,
      role: ParticipantRoles.PARTY_B,
      telegramUserId: partyBTelegramUserId,
      consentGrantedAt: null
    }
  ];

  return {
    ...session,
    participants: nextParticipants,
    state: SessionStates.CONSENT_PENDING,
    updatedAt: now
  };
};

export const grantConsent = (
  session: MediationSession,
  telegramUserId: string,
  now: Date
): MediationSession => {
  if (session.state !== SessionStates.CONSENT_PENDING && session.state !== SessionStates.CONSENTED) {
    throw new InvalidStateTransitionError(
      `Cannot grant consent while in state ${session.state}.`
    );
  }

  if (TERMINAL_STATES.has(session.state)) {
    throw new InvalidStateTransitionError('Cannot grant consent in terminal state.');
  }

  let found = false;

  const nextParticipants = session.participants.map((participant) => {
    if (participant.telegramUserId !== telegramUserId) {
      return participant;
    }

    found = true;

    if (participant.consentGrantedAt) {
      throw new ConsentAlreadyGrantedError();
    }

    return {
      ...participant,
      consentGrantedAt: now
    };
  });

  if (!found) {
    throw new ParticipantNotInSessionError();
  }

  const allConsented = nextParticipants.length === 2 && nextParticipants.every((p) => Boolean(p.consentGrantedAt));

  return {
    ...session,
    participants: nextParticipants,
    state: allConsented ? SessionStates.CONSENTED : SessionStates.CONSENT_PENDING,
    updatedAt: now
  };
};
