import type { FastifyInstance } from 'fastify';
import webpush from 'web-push';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { z } from 'zod';
import { config } from './config.js';
import { pool, tx, ensure } from './db.js';
import { channelAccess, P } from './permissions.js';
import { validSession } from './auth.js';
export function inQuietHours(
  timezone: string,
  schedules: Array<{ weekday: number; start_local: string; end_local: string }>,
  date = new Date(),
) {
  const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date),
    get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')) + 1,
    time = `${get('hour')}:${get('minute')}:${get('second')}`;
  return schedules.some((s) => s.weekday === day && s.start_local <= time && time < s.end_local);
}
export async function notificationRoutes(app: FastifyInstance) {
  app.get('/api/me/notification-settings', async (req) => {
    await pool.query(
      'INSERT INTO notification_preferences(user_id) VALUES($1) ON CONFLICT DO NOTHING',
      [req.user.sub],
    );
    return {
      preferences: (
        await pool.query('SELECT * FROM notification_preferences WHERE user_id=$1', [req.user.sub])
      ).rows[0],
      schedules: (
        await pool.query(
          'SELECT * FROM notification_schedules WHERE user_id=$1 ORDER BY weekday,start_local',
          [req.user.sub],
        )
      ).rows,
      sounds: (
        await pool.query('SELECT * FROM user_notification_sounds WHERE user_id=$1', [req.user.sub])
      ).rows,
      publicKey: config.VAPID_PUBLIC_KEY,
    };
  });
  app.patch('/api/me/notification-settings', async (req) => {
    const body = z
      .object({
        desktop_enabled: z.boolean().optional(),
        sound_enabled: z.boolean().optional(),
        direct_messages: z.boolean().optional(),
        mentions: z.boolean().optional(),
        everyone_mentions: z.boolean().optional(),
        quiet_hours_enabled: z.boolean().optional(),
        timezone: z.string().max(100).optional(),
        schedules: z
          .array(
            z.object({
              weekday: z.number().int().min(1).max(7),
              start: z.string().regex(/^\d{2}:\d{2}$/),
              end: z.string().regex(/^\d{2}:\d{2}$/),
            }),
          )
          .max(28)
          .optional(),
      })
      .strict()
      .parse(req.body);
    if (body.timezone) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: body.timezone }).format();
      } catch {
        ensure(false, 400, 'Fuso horário inválido.');
      }
    }
    if (body.schedules)
      for (const s of body.schedules) {
        ensure(
          s.start < s.end && s.start <= '23:59' && s.end <= '24:00',
          400,
          'Use horários válidos e divida janelas que atravessam a meia-noite.',
        );
        ensure(
          !body.schedules.some(
            (other) =>
              other !== s &&
              other.weekday === s.weekday &&
              other.start < s.end &&
              s.start < other.end,
          ),
          400,
          'Há horários de silêncio sobrepostos.',
        );
      }
    await tx(async (db) => {
      await db.query(
        'INSERT INTO notification_preferences(user_id) VALUES($1) ON CONFLICT DO NOTHING',
        [req.user.sub],
      );
      for (const [key, value] of Object.entries(body))
        if (!['timezone', 'schedules'].includes(key))
          await db.query(
            `UPDATE notification_preferences SET ${key}=$2,updated_at=now() WHERE user_id=$1`,
            [req.user.sub, value],
          );
      if (body.timezone)
        await db.query('UPDATE user_preferences SET timezone=$2 WHERE user_id=$1', [
          req.user.sub,
          body.timezone,
        ]);
      if (body.schedules) {
        await db.query('DELETE FROM notification_schedules WHERE user_id=$1', [req.user.sub]);
        for (const s of body.schedules)
          await db.query(
            'INSERT INTO notification_schedules(user_id,weekday,start_local,end_local) VALUES($1,$2,$3,$4)',
            [req.user.sub, s.weekday, s.start, s.end],
          );
      }
    });
    return { ok: true };
  });
  app.patch('/api/me/sounds/:event', async (req) => {
    const event = z
        .enum(['message', 'call_join', 'call_leave'])
        .parse((req.params as { event: string }).event),
      body = z
        .object({
          enabled: z.boolean(),
          volume: z.number().min(0).max(1),
          reset: z.boolean().default(false),
        })
        .parse(req.body);
    await pool.query(
      'INSERT INTO user_notification_sounds(user_id,event,enabled,volume) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,event) DO UPDATE SET enabled=EXCLUDED.enabled,volume=EXCLUDED.volume,asset_id=CASE WHEN $5 THEN NULL ELSE user_notification_sounds.asset_id END',
      [req.user.sub, event, body.enabled, body.volume, body.reset],
    );
    return { ok: true };
  });
  app.post('/api/push/subscriptions', async (req, reply) => {
    ensure(config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY, 503, 'Push não configurado.');
    const body = z
      .object({
        endpoint: z.url(),
        keys: z.object({
          p256dh: z
            .string()
            .regex(/^[A-Za-z0-9_-]+$/)
            .max(100),
          auth: z
            .string()
            .regex(/^[A-Za-z0-9_-]+$/)
            .max(40),
        }),
      })
      .parse(req.body);
    const endpoint = new URL(body.endpoint),
      host = endpoint.hostname;
    ensure(
      endpoint.protocol === 'https:' &&
        !endpoint.username &&
        !endpoint.password &&
        (!endpoint.port || endpoint.port === '443') &&
        (host === 'fcm.googleapis.com' ||
          host === 'web.push.apple.com' ||
          host === 'updates.push.services.mozilla.com' ||
          host.endsWith('.push.services.mozilla.com') ||
          host.endsWith('.notify.windows.com')),
      400,
      'Provedor de push não suportado.',
    );
    ensure(
      Buffer.from(body.keys.p256dh, 'base64url').length === 65 &&
        Buffer.from(body.keys.auth, 'base64url').length === 16,
      400,
      'Chaves de assinatura inválidas.',
    );
    await pool.query(
      'INSERT INTO push_subscriptions(user_id,auth_session_id,endpoint,p256dh,auth_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT(endpoint) DO UPDATE SET user_id=EXCLUDED.user_id,auth_session_id=EXCLUDED.auth_session_id,p256dh=EXCLUDED.p256dh,auth_key=EXCLUDED.auth_key,revoked_at=NULL',
      [req.user.sub, req.user.sid, body.endpoint, body.keys.p256dh, body.keys.auth],
    );
    await pool.query(
      'INSERT INTO notification_preferences(user_id,desktop_enabled) VALUES($1,true) ON CONFLICT(user_id) DO UPDATE SET desktop_enabled=true',
      [req.user.sub],
    );
    return reply.code(201).send({ ok: true });
  });
  app.delete('/api/push/subscriptions', async (req) => {
    const body = z.object({ endpoint: z.url() }).parse(req.body);
    await pool.query(
      'UPDATE push_subscriptions SET revoked_at=now() WHERE user_id=$1 AND endpoint=$2',
      [req.user.sub, body.endpoint],
    );
    return { ok: true };
  });
  app.put('/api/notifications/read', async (req) => {
    await pool.query(
      'UPDATE notifications SET read_at=now() WHERE recipient_id=$1 AND read_at IS NULL',
      [req.user.sub],
    );
    return { ok: true };
  });
}
export function startPushWorker(app: FastifyInstance) {
  let running = false;
  const timer = setInterval(async () => {
    if (running || !config.VAPID_PRIVATE_KEY) return;
    running = true;
    try {
      await pool.query(
        "INSERT INTO notification_deliveries(notification_id,subscription_id) SELECT n.id,s.id FROM notifications n JOIN push_subscriptions s ON s.user_id=n.recipient_id WHERE n.created_at>now()-interval '1 day' AND n.read_at IS NULL AND s.revoked_at IS NULL ON CONFLICT DO NOTHING",
      );
      await tx(async (db) => {
        const deliveries = (
          await db.query(
            "SELECT d.*,n.recipient_id,n.channel_id,n.guild_id,n.kind,n.read_at,s.endpoint,s.p256dh,s.auth_key,s.auth_session_id,s.revoked_at AS subscription_revoked_at,u.preferred_status,up.timezone FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id JOIN push_subscriptions s ON s.id=d.subscription_id JOIN users u ON u.id=n.recipient_id JOIN user_preferences up ON up.user_id=u.id WHERE d.state='pending' AND (d.next_attempt_at IS NULL OR d.next_attempt_at<=now()) ORDER BY d.created_at FOR UPDATE OF d SKIP LOCKED LIMIT 5",
          )
        ).rows;
        for (const d of deliveries) {
          const p = (
            await db.query('SELECT * FROM notification_preferences WHERE user_id=$1', [
              d.recipient_id,
            ])
          ).rows[0];
          let allowed =
            !!p?.desktop_enabled &&
            !d.subscription_revoked_at &&
            !d.read_at &&
            d.preferred_status !== 'dnd' &&
            (await validSession(d.auth_session_id, d.recipient_id));
          if (d.kind === 'direct_message' && !p?.direct_messages) allowed = false;
          if (['mention', 'role_mention'].includes(d.kind) && !p?.mentions) allowed = false;
          if (d.kind === 'everyone_mention' && !p?.everyone_mentions) allowed = false;
          if (allowed && p.quiet_hours_enabled) {
            const schedules = (
              await db.query('SELECT * FROM notification_schedules WHERE user_id=$1', [
                d.recipient_id,
              ])
            ).rows;
            allowed = !inQuietHours(d.timezone, schedules);
          }
          if (allowed && d.channel_id)
            try {
              await channelAccess(d.recipient_id, d.channel_id, P.READ_MESSAGE_HISTORY);
            } catch {
              allowed = false;
            }
          if (!allowed) {
            await db.query("UPDATE notification_deliveries SET state='suppressed' WHERE id=$1", [
              d.id,
            ]);
            continue;
          }
          try {
            const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
            await webpush.sendNotification(
              { endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth_key } },
              JSON.stringify({
                title: 'Tetocord',
                body:
                  d.kind === 'direct_message'
                    ? 'Você recebeu uma mensagem.'
                    : d.kind === 'friend_request'
                      ? 'Você recebeu um pedido de amizade.'
                      : 'Alguém chamou você na conversa.',
                tag: d.notification_id,
                guildId: d.guild_id,
                channelId: d.channel_id,
              }),
              {
                TTL: 300,
                vapidDetails: {
                  subject: config.VAPID_SUBJECT,
                  publicKey: config.VAPID_PUBLIC_KEY,
                  privateKey: config.VAPID_PRIVATE_KEY,
                },
                timeout: 10000,
                ...(proxy ? { agent: new HttpsProxyAgent(proxy) } : {}),
              },
            );
            await db.query(
              "UPDATE notification_deliveries SET state='sent',sent_at=now(),attempts=attempts+1 WHERE id=$1",
              [d.id],
            );
            await db.query('UPDATE push_subscriptions SET last_success_at=now() WHERE id=$1', [
              d.subscription_id,
            ]);
          } catch (e) {
            const code = (e as { statusCode?: number }).statusCode;
            if (code === 404 || code === 410)
              await db.query('UPDATE push_subscriptions SET revoked_at=now() WHERE id=$1', [
                d.subscription_id,
              ]);
            await db.query(
              "UPDATE notification_deliveries SET state=$2,attempts=attempts+1,next_attempt_at=now()+interval '1 minute',last_error_code=$3 WHERE id=$1",
              [
                d.id,
                d.attempts >= 4 || code === 404 || code === 410 ? 'failed' : 'pending',
                String(code ?? 'network'),
              ],
            );
          }
        }
      });
    } catch {
      app.log.warn('Entrega push pendente; tentativa posterior.');
    } finally {
      running = false;
    }
  }, 1000);
  return async () => {
    clearInterval(timer);
    while (running) await new Promise((r) => setTimeout(r, 20));
  };
}
