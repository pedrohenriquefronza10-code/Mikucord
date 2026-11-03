import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { config } from './config.js';
import { pool, ensure } from './db.js';
import { redis } from './redis.js';
import { authRoutes, authenticate } from './auth.js';
import { routes } from './routes.js';
import { mediaRoutes, initStorage, s3 } from './media.js';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { contextRoutes } from './context.js';
import { voiceRoutes, voiceWebhook, startVoiceReconciliation, reconcileVoice } from './voice.js';
import { notificationRoutes, startPushWorker } from './notifications.js';
import { socialRoutes } from './social.js';
import { customizationRoutes } from './customization.js';
import { catalogRoutes } from './catalog.js';
import { uploadRoutes } from './uploads.js';
import { realtime } from './realtime.js';
export async function buildApp() {
  const app = Fastify({
    logger:
      config.NODE_ENV === 'test'
        ? false
        : { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] },
    disableRequestLogging: true,
    bodyLimit: 32_768,
    trustProxy: config.NODE_ENV === 'production' ? (_address, hop) => hop === 0 : false,
  });
  await app.register(cookie);
  await app.register(cors, { origin: config.APP_ORIGIN, credentials: true });
  await app.register(helmet);
  await app.register(jwt, {
    secret: config.JWT_SECRET,
    cookie: { cookieName: 'access', signed: false },
    verify: { allowedIss: 'tetocord', allowedAud: 'tetocord-web' },
  });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 0 } });
  await app.register(rateLimit, {
    nameSpace: process.env.RATE_LIMIT_NAMESPACE ?? 'tetocord-rate:',
    max: 240,
    timeWindow: '1 minute',
    redis,
    keyGenerator: (req) => {
      if (!req.url.startsWith('/api/auth/') && req.cookies.access) {
        try {
          return `user:${app.jwt.verify<{ sub: string }>(req.cookies.access).sub}`;
        } catch {}
      }
      return `ip:${req.ip}`;
    },
  });
  app.addHook('onRequest', async (req) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      ensure(
        !req.headers.origin || req.headers.origin === config.APP_ORIGIN,
        403,
        'Origem não autorizada.',
      );
      ensure(req.headers['sec-fetch-site'] !== 'cross-site', 403, 'Origem não autorizada.');
    }
  });
  app.setErrorHandler((error, req, reply) => {
    const err = error as Error & { statusCode?: number; code?: string };
    if (error instanceof ZodError)
      return reply.code(400).send({ error: error.issues[0]?.message ?? 'Dados inválidos.' });
    if (err.code === '23505') return reply.code(409).send({ error: 'Este registro já existe.' });
    if (['23503', '23514', '22P02'].includes(err.code ?? ''))
      return reply.code(400).send({ error: 'Referência ou dados inválidos.' });
    if (err.code === 'ENOSPC' || ['XMinioStorageFull', 'StorageFull'].includes(err.name))
      return reply
        .code(507)
        .send({ error: 'Sem espaço no armazenamento. Libere disco e tente novamente.' });
    const code = err.statusCode ?? 500;
    if (code >= 500) req.log.error({ name: err.name, code: err.code }, 'Falha interna.');
    return reply.code(code).send({
      error: code >= 500 ? 'Serviço temporariamente indisponível. Tente novamente.' : err.message,
    });
  });
  app.get('/api/health', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      await redis.ping();
      await s3.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET }));
      return { status: 'ok', phase: 6 };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  await app.register(authRoutes);
  await app.register(voiceWebhook);
  await app.register(async (privateApp) => {
    privateApp.addHook('preHandler', authenticate);
    await privateApp.register(routes);
    await privateApp.register(mediaRoutes);
    await privateApp.register(uploadRoutes);
    await privateApp.register(socialRoutes);
    await privateApp.register(customizationRoutes);
    await privateApp.register(catalogRoutes);
    await privateApp.register(voiceRoutes);
    await privateApp.register(notificationRoutes);
    await privateApp.register(contextRoutes);
  });
  // A storage outage must not prevent existing conversations from being read.
  const prepareStorage = async () => {
    try {
      await initStorage();
    } catch {
      app.log.warn('Armazenamento indisponível; perfil com imagem aguardando serviço.');
    }
  };
  await prepareStorage();
  const storageRetry = setInterval(() => void prepareStorage(), 30_000);
  const rt = await realtime(app);
  const stopVoice = startVoiceReconciliation(app),
    stopPush = startPushWorker(app);
  app.addHook('onResponse', async (req, reply) => {
    if (req.url === '/api/livekit/webhook')
      app.log.info({ status: reply.statusCode }, 'Webhook de mídia recebido.');
    if (['/api/auth/logout', '/api/auth/refresh'].includes(req.url)) await rt.revalidate();
    if (
      req.method !== 'GET' &&
      (/\/(roles|overwrites|moderation|membership)(\/|$)/.test(req.url) ||
        req.url === '/api/auth/logout')
    )
      await reconcileVoice(app).catch(() => {});
  });
  app.addHook('onClose', async () => {
    clearInterval(storageRetry);
    await stopVoice();
    await stopPush();
    await rt.close();
  });
  return app;
}
