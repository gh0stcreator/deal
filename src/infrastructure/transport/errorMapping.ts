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
  INVALID_STATE_TRANSITION: 'Ты не можешь сделать это сейчас.',
  TRANSPORT_ACCESS_DENIED: 'Ты не можешь сделать это сейчас.',
  INTAKE_ACCESS_DENIED: 'Ты не можешь сделать это сейчас.',
  PARTICIPANT_NOT_IN_SESSION: 'Ты не можешь сделать это сейчас.',
  SESSION_NOT_FOUND: 'Не получилось найти договорённость.',
  INVALID_INVITE_TOKEN: 'Приглашение недействительно или устарело.',
  EXPIRED_INVITE_TOKEN: 'Приглашение недействительно или устарело.',
  INTAKE_CONFLICT: 'Ты не можешь сделать это сейчас.',
  NEGOTIATION_CONFLICT: 'Ты не можешь сделать это сейчас.',
  SUMMARY_MISMATCH: 'Ты не можешь сделать это сейчас.',
  PROPOSAL_PRECONDITION_FAILED: 'Ты не можешь сделать это сейчас.',
  NEGOTIATION_PRECONDITION_FAILED: 'Ты не можешь сделать это сейчас.',
  INTAKE_VALIDATION_ERROR: 'Ты не можешь сделать это сейчас.'
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

  return 'Что-то пошло не так. Попробуй ещё раз.';
};
