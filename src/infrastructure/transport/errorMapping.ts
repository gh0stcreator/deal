import { FastifyReply } from 'fastify';
import { DomainError } from '../../domain/session/errors.js';

const codeToStatus: Record<string, number> = {
  INVALID_STATE_TRANSITION: 409,
  INTAKE_CONFLICT: 409,
  NEGOTIATION_CONFLICT: 409,
  TRANSPORT_ACCESS_DENIED: 403,
  INTAKE_ACCESS_DENIED: 403,
  PARTICIPANT_NOT_IN_SESSION: 403,
  SESSION_NOT_FOUND: 404,
  INTAKE_NOT_FOUND: 404,
  INVALID_INVITE_TOKEN: 400,
  EXPIRED_INVITE_TOKEN: 410,
  PROPOSAL_PRECONDITION_FAILED: 409,
  SYNTHESIS_PRECONDITION_FAILED: 409,
  NEGOTIATION_PRECONDITION_FAILED: 409,
  PROPOSAL_VALIDATION_FAILED: 400,
  NEGOTIATION_VALIDATION_FAILED: 400,
  INTAKE_VALIDATION_ERROR: 400,
  SUMMARY_MISMATCH: 409,
  DUPLICATE_JOIN: 409,
  CONSENT_ALREADY_GRANTED: 409
};

const codeToTelegramText: Record<string, string> = {
  INVALID_STATE_TRANSITION: 'Action not allowed in current session state.',
  TRANSPORT_ACCESS_DENIED: 'You are not authorized for this session.',
  INTAKE_ACCESS_DENIED: 'You are not authorized for this session.',
  PARTICIPANT_NOT_IN_SESSION: 'You are not authorized for this session.',
  SESSION_NOT_FOUND: 'Session not found.',
  INVALID_INVITE_TOKEN: 'Invite token is invalid.',
  EXPIRED_INVITE_TOKEN: 'Invite token has expired.',
  INTAKE_CONFLICT: 'Request already processed or stale version. Please retry from latest state.',
  NEGOTIATION_CONFLICT: 'Action already processed for the current round.',
  SUMMARY_MISMATCH: 'Summary confirmation does not match current generated summary.',
  PROPOSAL_PRECONDITION_FAILED: 'Proposal generation is not available in current state.',
  NEGOTIATION_PRECONDITION_FAILED: 'Negotiation action is not available in current state.',
  INTAKE_VALIDATION_ERROR: 'Invalid intake input for this step.'
};

export const mapHttpError = (error: unknown): { status: number; body: { code: string; message: string } } => {
  if (error instanceof DomainError) {
    return {
      status: codeToStatus[error.code] ?? 400,
      body: {
        code: error.code,
        message: error.message
      }
    };
  }

  return {
    status: 500,
    body: {
      code: 'INTERNAL_ERROR',
      message: 'Unexpected error'
    }
  };
};

export const sendHttpError = (error: unknown, reply: FastifyReply) => {
  const mapped = mapHttpError(error);
  return reply.code(mapped.status).send(mapped.body);
};

export const mapTelegramErrorText = (error: unknown): string => {
  if (error instanceof DomainError) {
    return codeToTelegramText[error.code] ?? error.message;
  }

  return 'Unexpected error. Try again later.';
};
