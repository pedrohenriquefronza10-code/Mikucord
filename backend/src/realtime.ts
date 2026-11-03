import type { FastifyInstance } from 'fastify';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { redis } from './redis.js';
import { config } from './config.js';
import { validSession } from './auth.js';
import { pool, tx, ensure } from './db.js';
import { channelAccess, guildAccess, P } from './permissions.js';
import { sendMessage, messageBody } from './messages.js';
import { z } from 'zod';
export async function realtime(app: FastifyInstance) {
  let shuttingDown = false;
  const io = new Server(app.server, {
    cors: { origin: config.APP_ORIGIN, credentials: true },
    maxHttpBufferSize: 32_768,
    allowRequest: (req, cb) =>
      cb(null, !req.headers.origin || req.headers.origin === config.APP_ORIGIN),
  });
  const pub = redis.duplicate(),
    sub = redis.duplicate();
  pub.on('error', () => {});
  sub.on('error', () => {});
  io.adapter(createAdapter(pub, sub));
  io.use(async (socket, next) => {
    try {
      const token = app.parseCookie(socket.request.headers.cookie ?? '').access;
      ensure(token, 401, 'Entre novamente.');
      const user = app.jwt.verify<{ sub: string; sid: string; exp: number }>(token);
      ensure(await validSession(user.sid, user.sub), 401, 'Sessão encerrada.');
      socket.data.user = user;
      next();
    } catch {
      next(new Error('Sessão expirada.'));
    }
  });
  async function announcePresence(userId: string) {
    if (shuttingDown) return;
    const guilds = (
      await pool.query('SELECT guild_id FROM guild_members WHERE user_id=$1', [userId])
    ).rows.map((r) => r.guild_id);
    for (const socket of await io.fetchSockets()) {
      if (!(await validSession(socket.data.user.sid, socket.data.user.sub))) continue;
      for (const guild of guilds) {
        try {
          await guildAccess(socket.data.user.sub, guild);
          socket.emit('presence.changed', { guildId: guild });
        } catch {}
      }
    }
  }
  io.on('connection', (socket) => {
    let disposed = false;
    const heartbeat = async () => {
      try {
        const user = socket.data.user;
        if (user.exp * 1000 < Date.now() || !(await validSession(user.sid, user.sub))) {
          socket.disconnect(true);
          return;
        }
        await redis
          .multi()
          .zremrangebyscore(`presence:${user.sub}`, '-inf', Date.now())
          .zadd(`presence:${user.sub}`, Date.now() + 90_000, socket.id)
          .expire(`presence:${user.sub}`, 120)
          .exec();
      } catch {
        socket.emit('service.error', { error: 'Presença indisponível. Tentando reconectar.' });
      }
    };
    void heartbeat()
      .then(() => announcePresence(socket.data.user.sub))
      .catch(() => {});
    const timer = setInterval(() => void heartbeat(), 20_000);
    const handle = (name: string, fn: (data: unknown) => Promise<unknown>) =>
      socket.on(name, async (data, ack) => {
        try {
          ensure(
            socket.data.user.exp * 1000 > Date.now() &&
              (await validSession(socket.data.user.sid, socket.data.user.sub)),
            401,
            'Sessão expirada.',
          );
          const key = `socket-rate:${socket.data.user.sub}`,
            count = await redis.incr(key);
          if (count === 1) await redis.expire(key, 60);
          ensure(count <= 90, 429, 'Você está enviando eventos rápido demais.');
          const result = await fn(data);
          if (typeof ack === 'function') ack({ ok: true, ...(result as object) });
        } catch (error) {
          if (typeof ack === 'function') ack({ ok: false, error: (error as Error).message });
        }
      });
    handle('channel.join', async (data) => {
      const { channelId } = z.object({ channelId: z.uuid() }).parse(data);
      await channelAccess(socket.data.user.sub, channelId, P.READ_MESSAGE_HISTORY);
      socket.data.channelId = channelId;
      return {};
    });
    handle('message.send', async (data) => {
      const body = messageBody.extend({ channelId: z.uuid() }).parse(data);
      return { message: await sendMessage(socket.data.user.sub, body.channelId, body) };
    });
    handle('typing', async (data) => {
      const { channelId } = z.object({ channelId: z.uuid() }).parse(data);
      await channelAccess(socket.data.user.sub, channelId, P.SEND_MESSAGES);
      if (!(await redis.set(`typing:${channelId}:${socket.data.user.sub}`, '1', 'EX', 4, 'NX')))
        return {};
      const user = (
        await pool.query('SELECT username FROM users WHERE id=$1', [socket.data.user.sub])
      ).rows[0];
      for (const other of await io.fetchSockets()) {
        if (
          other.id === socket.id ||
          other.data.channelId !== channelId ||
          !(await validSession(other.data.user.sid, other.data.user.sub))
        )
          continue;
        try {
          await channelAccess(other.data.user.sub, channelId, P.READ_MESSAGE_HISTORY);
          other.emit('typing', {
            channelId,
            userId: socket.data.user.sub,
            username: user.username,
          });
        } catch {}
      }
      return {};
    });
    socket.on('disconnect', () => {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      void redis
        .zrem(`presence:${socket.data.user.sub}`, socket.id)
        .then(() => announcePresence(socket.data.user.sub))
        .catch(() => {});
    });
  });
  let running = false;
  async function drain() {
    if (running) return;
    running = true;
    try {
      await redis.ping();
      await tx(async (db) => {
        const rows = (
          await db.query(
            'SELECT * FROM outbox_events WHERE published_at IS NULL AND available_at<=now() ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 10',
          )
        ).rows;
        if (!rows.length) return;
        const sockets = await io.fetchSockets();
        for (const e of rows) {
          const payload = e.payload;
          for (const socket of sockets) {
            if (!(await validSession(socket.data.user.sid, socket.data.user.sub))) {
              socket.disconnect(true);
              continue;
            }
            try {
              if (payload.channelId)
                await channelAccess(
                  socket.data.user.sub,
                  payload.channelId,
                  P.READ_MESSAGE_HISTORY,
                );
              else if (payload.guildId) {
                if (payload.userId !== socket.data.user.sub)
                  await guildAccess(socket.data.user.sub, payload.guildId);
              } else if (payload.userId && payload.userId !== socket.data.user.sub) {
                const shared = await pool.query(
                  'SELECT 1 FROM guild_members a JOIN guild_members b ON a.guild_id=b.guild_id WHERE a.user_id=$1 AND b.user_id=$2 LIMIT 1',
                  [payload.userId, socket.data.user.sub],
                );
                ensure(shared.rowCount, 403, 'Sem acesso.');
              }
              socket.emit(e.event_type, {
                ...payload,
                eventId: e.id,
                version: e.aggregate_version,
              });
            } catch {
              /* Permission changes prevent stale room subscriptions from receiving data. */
            }
          }
          await db.query(
            'UPDATE outbox_events SET published_at=now(),attempts=attempts+1 WHERE id=$1',
            [e.id],
          );
        }
      });
    } catch (error) {
      app.log.warn(
        { code: (error as { code?: string }).code },
        'Outbox pendente; nova tentativa automática.',
      );
    } finally {
      running = false;
    }
  }
  const worker = setInterval(() => void drain(), 300);
  return {
    io,
    revalidate: async () => {
      for (const socket of await io.fetchSockets())
        if (!(await validSession(socket.data.user.sid, socket.data.user.sub)))
          socket.disconnect(true);
    },
    close: async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      clearInterval(worker);
      while (running) await new Promise((resolve) => setTimeout(resolve, 20));
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await sub.punsubscribe();
      await sub.unsubscribe();
      await Promise.all([pub.quit(), sub.quit()]);
    },
  };
}
