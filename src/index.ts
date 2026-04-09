import { loadEnv } from './config/env.js';
import { SystemClock } from './application/ports/Clock.js';
import { RandomIdGenerator } from './application/ports/IdGenerator.js';
import { MediationService } from './application/services/MediationService.js';
import { buildHttpServer } from './infrastructure/http/server.js';
import { createLogger } from './infrastructure/logger.js';
import { prisma } from './infrastructure/db/prisma.js';
import { PrismaSessionRepository } from './infrastructure/repositories/PrismaSessionRepository.js';
import { buildTelegramBot } from './infrastructure/telegram/bot.js';

const bootstrap = async () => {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);

  const repository = new PrismaSessionRepository(prisma);
  const service = new MediationService(repository, new SystemClock(), new RandomIdGenerator());
  const app = buildHttpServer(service);

  try {
    await app.listen({ port: env.APP_PORT, host: '0.0.0.0' });
    logger.info({ port: env.APP_PORT }, 'HTTP server started');

    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_BOT_TOKEN !== 'replace-me') {
      const bot = buildTelegramBot(env.TELEGRAM_BOT_TOKEN, service);
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
