import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { z } from 'zod';
import { ProtocolGatewayService } from '../../application/services/ProtocolGatewayService.js';
import { ProposalVariantTypes } from '../../domain/proposal/types.js';
import { SuggestEditOperations } from '../../domain/negotiation/types.js';
import { sendHttpError } from '../transport/errorMapping.js';
import {
  mapIntakeStatusView,
  mapNegotiationRoundStatusView,
  mapProposalListView,
  mapProposalVariantDetails,
  mapSessionStatusView,
  mapTerminalOutcomeView
} from '../transport/viewMappers.js';

const variantEnum = z.enum([
  ProposalVariantTypes.BALANCED,
  ProposalVariantTypes.A_LEANING,
  ProposalVariantTypes.B_LEANING
]);

const editOperationEnum = z.enum([
  SuggestEditOperations.MODIFY_CLAUSE_TEXT,
  SuggestEditOperations.ADJUST_TRADEOFF_NOTES,
  SuggestEditOperations.MARK_CLAUSE_UNACCEPTABLE
]);

const withIdempotency = (
  request: { headers: Record<string, unknown>; id: string },
  userId: string,
  actionType: string,
  payload: unknown
): string => {
  const headerValue = request.headers['x-idempotency-key'];
  if (typeof headerValue === 'string' && headerValue.trim()) {
    return `http:${headerValue.trim()}`;
  }

  const hash = createHash('sha256')
    .update(JSON.stringify({ actionType, userId, payload }))
    .digest('hex')
    .slice(0, 16);
  return `http:${request.id}:${hash}`;
};

const userSchema = z.object({ telegramUserId: z.string().min(1) });

export const buildHttpServer = (gateway: ProtocolGatewayService) => {
  const app = Fastify({ logger: false });

  app.register(sensible);

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/sessions/create', async (request, reply) => {
    try {
      const body = userSchema.parse(request.body);
      const result = await gateway.createSession(
        {
          channel: 'HTTP',
          idempotency_key: withIdempotency(request, body.telegramUserId, 'create_session', body),
          action_type: 'create_session',
          case_id: null,
          participant_id: body.telegramUserId,
          payload: body
        },
        body.telegramUserId
      );

      return reply.code(201).send(result);
    } catch (error) {
      return sendHttpError(error, reply);
    }
  });

  app.post('/sessions/join', async (request, reply) => {
    try {
      const body = z
        .object({ telegramUserId: z.string().min(1), inviteToken: z.string().min(1) })
        .parse(request.body);

      const result = await gateway.joinSession(
        {
          channel: 'HTTP',
          idempotency_key: withIdempotency(request, body.telegramUserId, 'join_session', body),
          action_type: 'join_session',
          case_id: null,
          participant_id: body.telegramUserId,
          payload: body
        },
        body.telegramUserId,
        body.inviteToken
      );

      return reply.send(result);
    } catch (error) {
      return sendHttpError(error, reply);
    }
  });

  app.post('/sessions/:sessionId/consent', async (request, reply) => {
    try {
      const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
      const body = userSchema.parse(request.body);

      const result = await gateway.giveConsent(
        {
          channel: 'HTTP',
          idempotency_key: withIdempotency(request, body.telegramUserId, 'give_consent', {
            params,
            body
          }),
          action_type: 'give_consent',
          case_id: params.sessionId,
          participant_id: body.telegramUserId,
          payload: { params, body }
        },
        params.sessionId,
        body.telegramUserId
      );

      return reply.send(result);
    } catch (error) {
      return sendHttpError(error, reply);
    }
  });

  app.post('/sessions/:sessionId/intake/resume', async (request, reply) => {
    try {
      const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
      const body = userSchema.parse(request.body);

      const view = await gateway.resumeIntake(
        {
          channel: 'HTTP',
          idempotency_key: withIdempotency(request, body.telegramUserId, 'resume_intake', {
            params,
            body
          }),
          action_type: 'resume_intake',
          case_id: params.sessionId,
          participant_id: body.telegramUserId,
          payload: { params, body }
        },
        params.sessionId,
        body.telegramUserId
      );

      return reply.send(mapIntakeStatusView(view));
    } catch (error) {
      return sendHttpError(error, reply);
    }
  });

  app.post('/sessions/:sessionId/intake/confirm-summary', async (request, reply) => {
    try {
      const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
      const body = userSchema.parse(request.body);

      const view = await gateway.confirmSummary(
        {
          channel: 'HTTP',
          idempotency_key: withIdempotency(request, body.telegramUserId, 'confirm_summary', {
            params,
            body
          }),
          action_type: 'confirm_summary',
          case_id: params.sessionId,
          participant_id: body.telegramUserId,
          payload: { params, body }
        },
        params.sessionId,
        body.telegramUserId
      );

      return reply.send(mapIntakeStatusView(view));
    } catch (error) {
      return sendHttpError(error, reply);
    }
  });

  app.post('/sessions/:sessionId/intake/reopen', async (request, reply) => {
    try {
      const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
      const body = userSchema.parse(request.body);

      const view = await gateway.reopenIntake(
        {
          channel: 'HTTP',
          idempotency_key: withIdempotency(request, body.telegramUserId, 'reopen_intake', {
            params,
            body
          }),
          action_type: 'reopen_intake',
          case_id: params.sessionId,
          participant_id: body.telegramUserId,
          payload: { params, body }
        },
        params.sessionId,
        body.telegramUserId
      );

      return reply.send(mapIntakeStatusView(view));
    } catch (error) {
      return sendHttpError(error, reply);
    }
  });

  app.post('/sessions/:sessionId/proposals/generate', async (request, reply) => {
    try {
      const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
      const body = userSchema.parse(request.body);

      const set = await gateway.generateProposals(
        {
          channel: 'HTTP',
          idempotency_key: withIdempotency(request, body.telegramUserId, 'generate_proposals', {
            params,
            body
          }),
          action_type: 'generate_proposals',
          case_id: params.sessionId,
          participant_id: body.telegramUserId,
          payload: { params, body }
        },
        params.sessionId,
        body.telegramUserId
      );

      return reply.send(mapProposalListView(set));
    } catch (error) {
      return sendHttpError(error, reply);
    }
  });

  app.post('/sessions/:sessionId/negotiation/select-preferred', async (request, reply) => {
    try {
      const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
      const body = z
        .object({ telegramUserId: z.string().min(1), variantType: variantEnum })
        .parse(request.body);

      const result = await gateway.selectPreferred(
        {
          channel: 'HTTP',
          idempotency_key: withIdempotency(request, body.telegramUserId, 'select_preferred', {
            params,
            body
          }),
          action_type: 'select_preferred',
          case_id: params.sessionId,
          participant_id: body.telegramUserId,
          payload: { params, body }
        },
        params.sessionId,
        body.telegramUserId,
        body.variantType
      );

      return reply.send(result);
    } catch (error) {
      return sendHttpError(error, reply);
    }
  });

  app.post('/sessions/:sessionId/negotiation/accept', async (request, reply) => {
    try {
      const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
      const body = z
        .object({ telegramUserId: z.string().min(1), variantType: variantEnum })
        .parse(request.body);

      const result = await gateway.acceptProposal(
        {
          channel: 'HTTP',
          idempotency_key: withIdempotency(request, body.telegramUserId, 'accept_proposal', {
            params,
            body
          }),
          action_type: 'accept_proposal',
          case_id: params.sessionId,
          participant_id: body.telegramUserId,
          payload: { params, body }
        },
        params.sessionId,
        body.telegramUserId,
        body.variantType
      );

      return reply.send(result);
    } catch (error) {
      return sendHttpError(error, reply);
    }
  });

  app.post('/sessions/:sessionId/negotiation/reject', async (request, reply) => {
    try {
      const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
      const body = z
        .object({ telegramUserId: z.string().min(1), variantType: variantEnum })
        .parse(request.body);

      const result = await gateway.rejectProposal(
        {
          channel: 'HTTP',
          idempotency_key: withIdempotency(request, body.telegramUserId, 'reject_proposal', {
            params,
            body
          }),
          action_type: 'reject_proposal',
          case_id: params.sessionId,
          participant_id: body.telegramUserId,
          payload: { params, body }
        },
        params.sessionId,
        body.telegramUserId,
        body.variantType
      );

      return reply.send(result);
    } catch (error) {
      return sendHttpError(error, reply);
    }
  });

  app.post('/sessions/:sessionId/negotiation/suggest-edit', async (request, reply) => {
    try {
      const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
      const body = z
        .object({
          telegramUserId: z.string().min(1),
          variantType: variantEnum,
          clauseId: z.string().min(1),
          operation: editOperationEnum,
          proposedValue: z.string().nullable().optional()
        })
        .parse(request.body);

      const result = await gateway.suggestEdit(
        {
          channel: 'HTTP',
          idempotency_key: withIdempotency(request, body.telegramUserId, 'suggest_edit', {
            params,
            body
          }),
          action_type: 'suggest_edit',
          case_id: params.sessionId,
          participant_id: body.telegramUserId,
          payload: { params, body }
        },
        {
          session_id: params.sessionId,
          telegram_user_id: body.telegramUserId,
          variant_type: body.variantType,
          clause_id: body.clauseId,
          operation: body.operation,
          proposed_value: body.proposedValue ?? null
        }
      );

      return reply.send(result);
    } catch (error) {
      return sendHttpError(error, reply);
    }
  });

  app.get('/sessions/:sessionId/status', async (request, reply) => {
    try {
      const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
      const query = z.object({ telegramUserId: z.string().min(1) }).parse(request.query);
      const session = await gateway.getSessionStatus(params.sessionId, query.telegramUserId);

      return reply.send(mapSessionStatusView(session));
    } catch (error) {
      return sendHttpError(error, reply);
    }
  });

  app.get('/sessions/:sessionId/proposals', async (request, reply) => {
    try {
      const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
      const query = z
        .object({ telegramUserId: z.string().min(1), variantType: z.string().optional() })
        .parse(request.query);

      const set = await gateway.getLatestProposalSet(params.sessionId, query.telegramUserId);
      if (!set) {
        return reply.code(404).send({ code: 'PROPOSAL_SET_NOT_FOUND', message: 'No proposal set yet.' });
      }

      if (query.variantType) {
        const details = mapProposalVariantDetails(set, query.variantType);
        if (!details) {
          return reply
            .code(404)
            .send({ code: 'PROPOSAL_VARIANT_NOT_FOUND', message: 'Variant was not found.' });
        }

        return reply.send(details);
      }

      return reply.send(mapProposalListView(set));
    } catch (error) {
      return sendHttpError(error, reply);
    }
  });

  app.get('/sessions/:sessionId/negotiation', async (request, reply) => {
    try {
      const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
      const query = z.object({ telegramUserId: z.string().min(1) }).parse(request.query);
      const view = await gateway.getNegotiationStatus(params.sessionId, query.telegramUserId);
      return reply.send(mapNegotiationRoundStatusView(view));
    } catch (error) {
      return sendHttpError(error, reply);
    }
  });

  app.get('/sessions/:sessionId/outcome', async (request, reply) => {
    try {
      const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
      const query = z.object({ telegramUserId: z.string().min(1) }).parse(request.query);
      const session = await gateway.getSessionStatus(params.sessionId, query.telegramUserId);
      return reply.send(mapTerminalOutcomeView(session));
    } catch (error) {
      return sendHttpError(error, reply);
    }
  });

  return app;
};
