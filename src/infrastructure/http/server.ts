import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { MediationService } from '../../application/services/MediationService.js';
import { DomainError } from '../../domain/session/errors.js';

export const buildHttpServer = (mediationService: MediationService) => {
  const app = Fastify({ logger: false });

  app.register(sensible);

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/sessions', async (request, reply) => {
    const body = request.body as { telegramUserId: string };

    const result = await mediationService.createSession(body.telegramUserId);

    return reply.code(201).send({
      sessionId: result.session.id,
      state: result.session.state,
      inviteToken: result.inviteToken
    });
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) {
      return reply.code(400).send({ code: error.code, message: error.message });
    }

    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: 'Unexpected error' });
  });

  return app;
};
