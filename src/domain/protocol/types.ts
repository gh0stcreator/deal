import { SessionState } from '../session/types.js';

export const TransportChannels = {
  TELEGRAM: 'TELEGRAM',
  HTTP: 'HTTP'
} as const;

export type TransportChannel = (typeof TransportChannels)[keyof typeof TransportChannels];

export const ProtocolEventOutcomes = {
  ACCEPTED: 'ACCEPTED',
  NO_OP: 'NO_OP',
  ERROR: 'ERROR'
} as const;

export type ProtocolEventOutcome =
  (typeof ProtocolEventOutcomes)[keyof typeof ProtocolEventOutcomes];

export interface IdempotencyRecord {
  key: string;
  channel: TransportChannel;
  case_id: string | null;
  participant_id: string | null;
  action_type: string;
  payload_hash: string;
  response_json: unknown;
  created_at: Date;
}

export interface ProtocolEvent {
  id: string;
  case_id: string | null;
  participant_id: string | null;
  action_type: string;
  idempotency_key: string;
  channel: TransportChannel;
  outcome: ProtocolEventOutcome;
  error_code: string | null;
  session_state: SessionState | null;
  proposal_set_version: number | null;
  round_number: number | null;
  created_at: Date;
}
