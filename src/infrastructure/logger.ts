import pino from 'pino';
import { AppLogger } from '../application/ports/AppLogger.js';

export const createLogger = (level: string) =>
  pino({
    level,
    transport:
      process.env.NODE_ENV === 'development'
        ? {
            target: 'pino-pretty',
            options: { colorize: true }
          }
        : undefined
  });
