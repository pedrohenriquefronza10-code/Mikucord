import { config as dotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
dotenv({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });
export const config = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().default(3000),
    APP_ORIGIN: z
      .url()
      .refine(
        (s) => new URL(s).origin === s,
        'APP_ORIGIN deve ser uma origem sem caminho ou barra final.',
      )
      .default('http://localhost:5173'),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.url(),
    JWT_SECRET: z.string().min(48),
    S3_ENDPOINT: z.url(),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().default('tetocord'),
    S3_ACCESS_KEY: z.string().min(1),
    S3_SECRET_KEY: z.string().min(16),
    GIF_API_KEY: z.string().default(''),
    LIVEKIT_URL: z.string().default('ws://localhost:7880'),
    LIVEKIT_INTERNAL_URL: z.string().default('http://127.0.0.1:7880'),
    LIVEKIT_API_KEY: z.string().default(''),
    LIVEKIT_API_SECRET: z.string().default(''),
    TURN_HOST: z.string().default('localhost'),
    TURN_PORT: z.coerce.number().default(3478),
    TURN_TLS_PORT: z.coerce.number().default(0),
    TURN_SHARED_SECRET: z.string().default(''),
    TURN_REALM: z.string().default('tetocord'),
    VAPID_PUBLIC_KEY: z.string().default(''),
    VAPID_PRIVATE_KEY: z.string().default(''),
    VAPID_SUBJECT: z.string().default('mailto:admin@example.invalid'),
  })
  .parse(process.env);
if (config.NODE_ENV === 'production' && !config.APP_ORIGIN.startsWith('https://'))
  throw new Error('APP_ORIGIN deve usar HTTPS em produção.');
if (config.NODE_ENV === 'production' && config.LIVEKIT_API_KEY) {
  if (!config.LIVEKIT_URL.startsWith('wss://'))
    throw new Error('LIVEKIT_URL deve usar WSS em produção.');
  if (['localhost', '127.0.0.1', ''].includes(config.TURN_HOST))
    throw new Error('Configure TURN_HOST com o endereço público alcançável do coturn.');
}
