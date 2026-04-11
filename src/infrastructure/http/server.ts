import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { z } from 'zod';
import { Clock, SystemClock } from '../../application/ports/Clock.js';
import { AppLogger, createNoopLogger } from '../../application/ports/AppLogger.js';
import { ProtocolGatewayService } from '../../application/services/ProtocolGatewayService.js';
import { ProposalVariantTypes } from '../../domain/proposal/types.js';
import { SuggestEditOperations } from '../../domain/negotiation/types.js';
import { sendHttpError } from '../transport/errorMapping.js';
import { InMemoryRateLimiter } from '../transport/rateLimiter.js';
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
  correlationId: string,
  userId: string,
  actionType: string,
  payload: unknown
): string => {
  const headerValue = request.headers['x-idempotency-key'];
  if (typeof headerValue === 'string' && headerValue.trim()) {
    return `http:${correlationId}:${headerValue.trim()}`;
  }

  const hash = createHash('sha256')
    .update(JSON.stringify({ actionType, userId, payload }))
    .digest('hex')
    .slice(0, 16);
  return `http:${correlationId}:${hash}`;
};

const userSchema = z.object({ telegramUserId: z.string().min(1) });
const createSessionSchema = userSchema.extend({
  problemTopic: z.string().trim().min(1).max(120).optional()
});

const RATE_LIMIT_WINDOW_MS = 60_000;
const GENERAL_ACTION_LIMIT = 30;
const JOIN_ATTEMPT_LIMIT = 8;

export interface HttpServerOptions {
  logger?: AppLogger;
  rate_limiter?: InMemoryRateLimiter;
  clock?: Clock;
}

export const buildHttpServer = (gateway: ProtocolGatewayService, options: HttpServerOptions = {}) => {
  const logger = options.logger ?? createNoopLogger();
  const rateLimiter = options.rate_limiter ?? new InMemoryRateLimiter(options.clock ?? new SystemClock());
  const app = Fastify({ logger: false });

  app.register(sensible);
  app.addHook('onRequest', async (request, reply) => {
    const headerValue = request.headers['x-correlation-id'];
    const correlationId =
      typeof headerValue === 'string' && headerValue.trim()
        ? headerValue.trim()
        : `http:${request.id}`;
    request.headers['x-correlation-id'] = correlationId;
    reply.header('x-correlation-id', correlationId);
  });

  const correlationIdFor = (request: { headers: Record<string, unknown>; id: string }): string => {
    const headerValue = request.headers['x-correlation-id'];
    if (typeof headerValue === 'string' && headerValue.trim()) {
      return headerValue.trim();
    }
    return `http:${request.id}`;
  };

  const enforceRateLimit = (
    request: { headers: Record<string, unknown>; id: string },
    reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } },
    key: string,
    limit: number,
    actionType: string
  ): boolean => {
    const decision = rateLimiter.consume(key, limit, RATE_LIMIT_WINDOW_MS);
    if (decision.allowed) {
      return true;
    }

    logger.warn(
      {
        correlation_id: correlationIdFor(request),
        action_type: actionType,
        retry_after_seconds: decision.retry_after_seconds
      },
      'http.action.rate_limited'
    );
    reply.code(429).send({
      code: 'RATE_LIMITED',
      message: `Too many requests. Retry in ~${decision.retry_after_seconds}s.`
    });
    return false;
  };

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/sessions/create', async (request, reply) => {
    try {
      const body = createSessionSchema.parse(request.body);
      if (
        !enforceRateLimit(
          request,
          reply,
          `http:action:${body.telegramUserId}`,
          GENERAL_ACTION_LIMIT,
          'create_session'
        )
      ) {
        return reply;
      }
      const result = await gateway.createSession(
        {
          correlation_id: correlationIdFor(request),
          channel: 'HTTP',
          idempotency_key: withIdempotency(request, correlationIdFor(request), body.telegramUserId, 'create_session', body),
          action_type: 'create_session',
          case_id: null,
          participant_id: body.telegramUserId,
          payload: body
        },
        body.telegramUserId,
        body.problemTopic
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
      if (
        !enforceRateLimit(
          request,
          reply,
          `http:join:${body.telegramUserId}`,
          JOIN_ATTEMPT_LIMIT,
          'join_session'
        )
      ) {
        return reply;
      }

      const result = await gateway.joinSession(
        {
          correlation_id: correlationIdFor(request),
          channel: 'HTTP',
          idempotency_key: withIdempotency(request, correlationIdFor(request), body.telegramUserId, 'join_session', body),
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
      if (
        !enforceRateLimit(
          request,
          reply,
          `http:action:${body.telegramUserId}:${params.sessionId}`,
          GENERAL_ACTION_LIMIT,
          'give_consent'
        )
      ) {
        return reply;
      }

      const result = await gateway.giveConsent(
        {
          correlation_id: correlationIdFor(request),
          channel: 'HTTP',
          idempotency_key: withIdempotency(request, correlationIdFor(request), body.telegramUserId, 'give_consent', {
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
      if (
        !enforceRateLimit(
          request,
          reply,
          `http:action:${body.telegramUserId}:${params.sessionId}`,
          GENERAL_ACTION_LIMIT,
          'resume_intake'
        )
      ) {
        return reply;
      }

      const view = await gateway.resumeIntake(
        {
          correlation_id: correlationIdFor(request),
          channel: 'HTTP',
          idempotency_key: withIdempotency(request, correlationIdFor(request), body.telegramUserId, 'resume_intake', {
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
      if (
        !enforceRateLimit(
          request,
          reply,
          `http:action:${body.telegramUserId}:${params.sessionId}`,
          GENERAL_ACTION_LIMIT,
          'confirm_summary'
        )
      ) {
        return reply;
      }

      const view = await gateway.confirmSummary(
        {
          correlation_id: correlationIdFor(request),
          channel: 'HTTP',
          idempotency_key: withIdempotency(request, correlationIdFor(request), body.telegramUserId, 'confirm_summary', {
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
      if (
        !enforceRateLimit(
          request,
          reply,
          `http:action:${body.telegramUserId}:${params.sessionId}`,
          GENERAL_ACTION_LIMIT,
          'reopen_intake'
        )
      ) {
        return reply;
      }

      const view = await gateway.reopenIntake(
        {
          correlation_id: correlationIdFor(request),
          channel: 'HTTP',
          idempotency_key: withIdempotency(request, correlationIdFor(request), body.telegramUserId, 'reopen_intake', {
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
      if (
        !enforceRateLimit(
          request,
          reply,
          `http:action:${body.telegramUserId}:${params.sessionId}`,
          GENERAL_ACTION_LIMIT,
          'generate_proposals'
        )
      ) {
        return reply;
      }

      const set = await gateway.generateProposals(
        {
          correlation_id: correlationIdFor(request),
          channel: 'HTTP',
          idempotency_key: withIdempotency(request, correlationIdFor(request), body.telegramUserId, 'generate_proposals', {
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
      if (
        !enforceRateLimit(
          request,
          reply,
          `http:action:${body.telegramUserId}:${params.sessionId}`,
          GENERAL_ACTION_LIMIT,
          'select_preferred'
        )
      ) {
        return reply;
      }

      const result = await gateway.selectPreferred(
        {
          correlation_id: correlationIdFor(request),
          channel: 'HTTP',
          idempotency_key: withIdempotency(request, correlationIdFor(request), body.telegramUserId, 'select_preferred', {
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
      if (
        !enforceRateLimit(
          request,
          reply,
          `http:action:${body.telegramUserId}:${params.sessionId}`,
          GENERAL_ACTION_LIMIT,
          'accept_proposal'
        )
      ) {
        return reply;
      }

      const result = await gateway.acceptProposal(
        {
          correlation_id: correlationIdFor(request),
          channel: 'HTTP',
          idempotency_key: withIdempotency(request, correlationIdFor(request), body.telegramUserId, 'accept_proposal', {
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
      if (
        !enforceRateLimit(
          request,
          reply,
          `http:action:${body.telegramUserId}:${params.sessionId}`,
          GENERAL_ACTION_LIMIT,
          'reject_proposal'
        )
      ) {
        return reply;
      }

      const result = await gateway.rejectProposal(
        {
          correlation_id: correlationIdFor(request),
          channel: 'HTTP',
          idempotency_key: withIdempotency(request, correlationIdFor(request), body.telegramUserId, 'reject_proposal', {
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
      if (
        !enforceRateLimit(
          request,
          reply,
          `http:action:${body.telegramUserId}:${params.sessionId}`,
          GENERAL_ACTION_LIMIT,
          'suggest_edit'
        )
      ) {
        return reply;
      }

      const result = await gateway.suggestEdit(
        {
          correlation_id: correlationIdFor(request),
          channel: 'HTTP',
          idempotency_key: withIdempotency(request, correlationIdFor(request), body.telegramUserId, 'suggest_edit', {
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

  app.get('/sessions/:sessionId/synthesis/review', async (request, reply) => {
    try {
      const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
      const query = z.object({ telegramUserId: z.string().min(1) }).parse(request.query);
      const summary = await gateway.getProblemSynthesisReviewSummary(
        params.sessionId,
        query.telegramUserId
      );
      return reply.send(summary);
    } catch (error) {
      return sendHttpError(error, reply);
    }
  });

  app.get('/sessions/:sessionId/synthesis/review/export', async (request, reply) => {
    try {
      const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
      const query = z.object({ telegramUserId: z.string().min(1) }).parse(request.query);
      const summary = await gateway.getProblemSynthesisDogfoodExport(
        params.sessionId,
        query.telegramUserId
      );
      return reply.send(summary);
    } catch (error) {
      return sendHttpError(error, reply);
    }
  });

  app.get('/sessions/:sessionId/full-export', async (request, reply) => {
    try {
      const params = z.object({ sessionId: z.string().min(1) }).parse(request.params);
      const query = z.object({ telegramUserId: z.string().min(1) }).parse(request.query);
      const exported = await gateway.getSessionFullExport(params.sessionId, query.telegramUserId);
      return reply.send(exported);
    } catch (error) {
      return sendHttpError(error, reply);
    }
  });

  app.get('/dogfood/report', async (_request, reply) => {
    try {
      const report = await gateway.getDogfoodReport();
      return reply.send(report);
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
