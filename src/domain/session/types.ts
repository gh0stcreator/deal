export const SessionStates = {
  CREATED: 'CREATED',
  INVITED: 'INVITED',
  BOTH_JOINED: 'BOTH_JOINED',
  CONSENT_PENDING: 'CONSENT_PENDING',
  CONSENTED: 'CONSENTED',
  SIDE_A_INTAKE: 'SIDE_A_INTAKE',
  SIDE_B_INTAKE: 'SIDE_B_INTAKE',
  READY_FOR_SYNTHESIS: 'READY_FOR_SYNTHESIS',
  SYNTHESIS_COMPLETED: 'SYNTHESIS_COMPLETED',
  READY_FOR_PROPOSAL: 'READY_FOR_PROPOSAL',
  PROPOSALS_GENERATED: 'PROPOSALS_GENERATED',
  PROPOSAL_READY: 'PROPOSAL_READY',
  NEGOTIATION: 'NEGOTIATION',
  AGREEMENT: 'AGREEMENT',
  PARTIAL_AGREEMENT: 'PARTIAL_AGREEMENT',
  DEADLOCK: 'DEADLOCK',
  ABANDONED: 'ABANDONED'
} as const;

export type SessionState = (typeof SessionStates)[keyof typeof SessionStates];

export const ParticipantRoles = {
  PARTY_A: 'PARTY_A',
  PARTY_B: 'PARTY_B'
} as const;

export type ParticipantRole = (typeof ParticipantRoles)[keyof typeof ParticipantRoles];

export interface Participant {
  id: string;
  role: ParticipantRole;
  telegramUserId: string;
  consentGrantedAt: Date | null;
}

export interface MediationSession {
  id: string;
  state: SessionState;
  inviteTokenHash: string;
  inviteTokenExpiresAt: Date;
  participants: Participant[];
  createdAt: Date;
  updatedAt: Date;
}

export interface InviteToken {
  plainToken: string;
  tokenHash: string;
}
