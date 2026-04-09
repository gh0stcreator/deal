import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  LOG_LEVEL: z.string().default('info')
});

export type AppEnv = z.infer<typeof envSchema>;

export const loadEnv = (): AppEnv => envSchema.parse(process.env);
