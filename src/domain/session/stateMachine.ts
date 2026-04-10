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
  SessionStates.AGREEMENT_REACHED,
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
  problemTopic: string | null,
  now: Date
): MediationSession => ({
  id,
  state: SessionStates.INVITED,
  inviteTokenHash,
  inviteTokenExpiresAt,
  problemTopic,
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

export const markSynthesisCompleted = (
  session: MediationSession,
  now: Date
): MediationSession => {
  if (session.state !== SessionStates.READY_FOR_SYNTHESIS) {
    throw new InvalidStateTransitionError(
      `Cannot mark synthesis completed from state ${session.state}.`
    );
  }

  return {
    ...session,
    state: SessionStates.SYNTHESIS_COMPLETED,
    updatedAt: now
  };
};

export const markReadyForProposal = (
  session: MediationSession,
  now: Date
): MediationSession => {
  if (session.state !== SessionStates.SYNTHESIS_COMPLETED) {
    throw new InvalidStateTransitionError(
      `Cannot mark ready for proposal from state ${session.state}.`
    );
  }

  return {
    ...session,
    state: SessionStates.READY_FOR_PROPOSAL,
    updatedAt: now
  };
};

export const markProposalsGenerated = (
  session: MediationSession,
  now: Date
): MediationSession => {
  if (session.state !== SessionStates.READY_FOR_PROPOSAL) {
    throw new InvalidStateTransitionError(
      `Cannot mark proposals generated from state ${session.state}.`
    );
  }

  return {
    ...session,
    state: SessionStates.PROPOSALS_GENERATED,
    updatedAt: now
  };
};

export const markNegotiationInProgress = (
  session: MediationSession,
  now: Date
): MediationSession => {
  if (
    session.state !== SessionStates.PROPOSALS_GENERATED &&
    session.state !== SessionStates.NEGOTIATION_IN_PROGRESS
  ) {
    throw new InvalidStateTransitionError(
      `Cannot mark negotiation in progress from state ${session.state}.`
    );
  }

  return {
    ...session,
    state: SessionStates.NEGOTIATION_IN_PROGRESS,
    updatedAt: now
  };
};

export const markAgreementReached = (
  session: MediationSession,
  now: Date
): MediationSession => {
  if (session.state !== SessionStates.NEGOTIATION_IN_PROGRESS) {
    throw new InvalidStateTransitionError(
      `Cannot mark agreement reached from state ${session.state}.`
    );
  }

  return {
    ...session,
    state: SessionStates.AGREEMENT_REACHED,
    updatedAt: now
  };
};

export const markPartialAgreement = (
  session: MediationSession,
  now: Date
): MediationSession => {
  if (session.state !== SessionStates.NEGOTIATION_IN_PROGRESS) {
    throw new InvalidStateTransitionError(
      `Cannot mark partial agreement from state ${session.state}.`
    );
  }

  return {
    ...session,
    state: SessionStates.PARTIAL_AGREEMENT,
    updatedAt: now
  };
};

export const markDeadlock = (
  session: MediationSession,
  now: Date
): MediationSession => {
  if (session.state !== SessionStates.NEGOTIATION_IN_PROGRESS) {
    throw new InvalidStateTransitionError(
      `Cannot mark deadlock from state ${session.state}.`
    );
  }

  return {
    ...session,
    state: SessionStates.DEADLOCK,
    updatedAt: now
  };
};

export const markAbandoned = (
  session: MediationSession,
  now: Date
): MediationSession => {
  if (
    session.state !== SessionStates.PROPOSALS_GENERATED &&
    session.state !== SessionStates.NEGOTIATION_IN_PROGRESS
  ) {
    throw new InvalidStateTransitionError(
      `Cannot mark abandoned from state ${session.state}.`
    );
  }

  return {
    ...session,
    state: SessionStates.ABANDONED,
    updatedAt: now
  };
};
