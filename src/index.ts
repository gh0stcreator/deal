import { loadEnv } from './config/env.js';
import { SystemClock } from './application/ports/Clock.js';
import { RandomIdGenerator } from './application/ports/IdGenerator.js';
import { DeterministicIntakeNormalizer } from './application/ports/IntakeNormalizer.js';
import { MediationService } from './application/services/MediationService.js';
import { IntakeService } from './application/services/IntakeService.js';
import { SynthesisService } from './application/services/SynthesisService.js';
import { DeterministicSynthesisMapper } from './application/services/DeterministicSynthesisMapper.js';
import { ProposalGenerationService } from './application/services/ProposalGenerationService.js';
import { DeterministicProposalMapper } from './application/services/DeterministicProposalMapper.js';
import { NegotiationService } from './application/services/NegotiationService.js';
import { ProtocolGatewayService } from './application/services/ProtocolGatewayService.js';
import { buildHttpServer } from './infrastructure/http/server.js';
import { createLogger } from './infrastructure/logger.js';
import { InMemoryRateLimiter } from './infrastructure/transport/rateLimiter.js';
import { prisma } from './infrastructure/db/prisma.js';
import { PrismaSessionRepository } from './infrastructure/repositories/PrismaSessionRepository.js';
import { PrismaIntakeRepository } from './infrastructure/repositories/PrismaIntakeRepository.js';
import { PrismaMediationSummaryRepository } from './infrastructure/repositories/PrismaMediationSummaryRepository.js';
import { PrismaProposalSetRepository } from './infrastructure/repositories/PrismaProposalSetRepository.js';
import { PrismaNegotiationRoundRepository } from './infrastructure/repositories/PrismaNegotiationRoundRepository.js';
import { PrismaProtocolTrackingRepository } from './infrastructure/repositories/PrismaProtocolTrackingRepository.js';
import { PrismaSynthesisReviewRepository } from './infrastructure/repositories/PrismaSynthesisReviewRepository.js';
import { PrismaIssueResolutionRepository } from './infrastructure/repositories/PrismaIssueResolutionRepository.js';
import { buildTelegramBot } from './infrastructure/telegram/bot.js';

const bootstrap = async () => {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);
  const clock = new SystemClock();
  const ids = new RandomIdGenerator();
  const rateLimiter = new InMemoryRateLimiter(clock);

  const sessionRepository = new PrismaSessionRepository(prisma);
  const intakeRepository = new PrismaIntakeRepository(prisma);
  const summaryRepository = new PrismaMediationSummaryRepository(prisma);
  const proposalSetRepository = new PrismaProposalSetRepository(prisma);
  const roundRepository = new PrismaNegotiationRoundRepository(prisma);
  const protocolTrackingRepository = new PrismaProtocolTrackingRepository(prisma);
  const synthesisReviewRepository = new PrismaSynthesisReviewRepository(prisma);
  const issueResolutionRepository = new PrismaIssueResolutionRepository(prisma);

  const mediationService = new MediationService(sessionRepository, clock, ids);
  const intakeService = new IntakeService(
    sessionRepository,
    intakeRepository,
    new DeterministicIntakeNormalizer(),
    ids,
    clock
  );
  const synthesisService = new SynthesisService(
    sessionRepository,
    intakeRepository,
    summaryRepository,
    new DeterministicSynthesisMapper(),
    ids,
    clock
  );
  const proposalService = new ProposalGenerationService(
    sessionRepository,
    summaryRepository,
    proposalSetRepository,
    new DeterministicProposalMapper(),
    ids,
    clock
  );
  const negotiationService = new NegotiationService(
    sessionRepository,
    proposalSetRepository,
    roundRepository,
    ids,
    clock
  );

  const gateway = new ProtocolGatewayService(
    mediationService,
    intakeService,
    synthesisService,
    proposalService,
    negotiationService,
    sessionRepository,
    proposalSetRepository,
    protocolTrackingRepository,
    ids,
    clock,
    logger,
    synthesisReviewRepository,
    issueResolutionRepository
  );

  const app = buildHttpServer(gateway, {
    logger,
    rate_limiter: rateLimiter,
    clock
  });

  try {
    await app.listen({ port: env.APP_PORT, host: '0.0.0.0' });
    logger.info({ port: env.APP_PORT }, 'HTTP server started');

    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_BOT_TOKEN !== 'replace-me') {
      const bot = buildTelegramBot(env.TELEGRAM_BOT_TOKEN, gateway, {
        logger,
        rate_limiter: rateLimiter
      });
      await bot.start();
      logger.info('Telegram bot started');
    } else {
      logger.warn('Telegram bot token not configured. Bot bootstrap skipped.');
    }
  } catch (error) {
    logger.error({ err: error }, 'Failed to bootstrap application');
    process.exit(1);
  }
};

void bootstrap();
