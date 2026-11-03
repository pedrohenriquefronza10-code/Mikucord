import { randomBytes, randomUUID, createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool, tx, ensure, type DB } from './db.js';
import { config } from './config.js';
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; sid: string };
    user: { sub: string; sid: string; exp: number };
  }
}
export const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export const publicUserColumns =
  'id,username,tag,avatar_asset_id,banner_asset_id,about_me,preferred_status,custom_status_text,custom_status_emoji,accent_color,created_at';
export async function getUser(id: string, db: DB = pool) {
  const user = (
    await db.query(
      `SELECT ${publicUserColumns} FROM users WHERE id=$1 AND disabled_at IS NULL AND deleted_at IS NULL`,
      [id],
    )
  ).rows[0];
  ensure(user, 401, 'Sessão encerrada. Entre novamente.');
  const preferences = (await db.query('SELECT * FROM user_preferences WHERE user_id=$1', [id]))
    .rows[0];
  if (preferences?.theme_id) {
    const theme = (
      await db.query(
        "SELECT t.* FROM themes t WHERE t.id=$1 AND deleted_at IS NULL AND (owner_id=$2 OR (visibility='guild' AND guild_id IN(SELECT guild_id FROM guild_members WHERE user_id=$2)))",
        [preferences.theme_id, id],
      )
    ).rows[0];
    if (theme) {
      preferences.palette = theme.palette;
      preferences.base_mode = theme.base_mode;
    } else {
      preferences.theme_mode = 'dark';
      preferences.theme_id = null;
    }
  }
  return { ...user, preferences };
}
export async function validSession(sid: string, sub: string) {
  return !!(
    await pool.query(
      'SELECT 1 FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.disabled_at IS NULL AND u.deleted_at IS NULL',
      [sid, sub],
    )
  ).rowCount;
}
export async function authenticate(req: FastifyRequest) {
  try {
    await req.jwtVerify({ onlyCookie: true });
    ensure(await validSession(req.user.sid, req.user.sub), 401, 'Sessão encerrada.');
  } catch {
    throw Object.assign(new Error('Entre novamente para continuar.'), { statusCode: 401 });
  }
}
const cookieOptions = {
  httpOnly: true,
  secure: config.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  path: '/api',
};
export function clearCookies(reply: FastifyReply) {
  reply
    .clearCookie('access', { ...cookieOptions, path: '/' })
    .clearCookie('refresh', cookieOptions);
}
async function session(db: DB, user: string, agent: string | undefined, family = randomUUID()) {
  const token = randomBytes(48).toString('base64url');
  const row = (
    await db.query(
      "INSERT INTO auth_sessions(user_id,family_id,refresh_token_hash,user_agent,expires_at) VALUES($1,$2,$3,$4,now()+interval '30 days') RETURNING *",
      [user, family, digest(token), agent?.slice(0, 512)],
    )
  ).rows[0];
  return { token, row };
}
function issue(
  app: FastifyInstance,
  reply: FastifyReply,
  s: { token: string; row: Record<string, any> },
) {
  const access = app.jwt.sign(
    { sub: s.row.user_id, sid: s.row.id },
    { expiresIn: '15m', iss: 'tetocord', aud: 'tetocord-web' },
  );
  reply.setCookie('access', access, { ...cookieOptions, path: '/', maxAge: 900 });
  reply.setCookie('refresh', s.token, { ...cookieOptions, maxAge: 30 * 24 * 60 * 60 });
}
const password = z
  .string()
  .min(10, 'Use pelo menos 10 caracteres.')
  .refine((s) => Buffer.byteLength(s, 'utf8') <= 72, 'A senha deve ter até 72 bytes UTF-8.');
const dummyHash = await bcrypt.hash('dummy-password-not-a-login', 12);
export async function authRoutes(app: FastifyInstance) {
  app.post(
    '/api/auth/register',
    { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      const body = z
        .object({
          username: z
            .string()
            .trim()
            .min(2)
            .max(32)
            .regex(/^[\p{L}\p{N}_.-]+$/u, 'Use letras, números, ponto, hífen ou sublinhado.'),
          password,
        })
        .parse(req.body);
      const hash = await bcrypt.hash(body.password, 12);
      const result = await tx(async (db) => {
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `register:${body.username.toLowerCase()}`,
        ]);
        const taken = new Set(
          (
            await db.query('SELECT tag FROM users WHERE lower(username)=lower($1)', [body.username])
          ).rows.map((r) => r.tag),
        );
        let tag = '';
        const start = Math.floor(Math.random() * 9999);
        for (let i = 0; i < 9999; i++) {
          const t = String(((start + i) % 9999) + 1).padStart(4, '0');
          if (!taken.has(t)) {
            tag = t;
            break;
          }
        }
        ensure(tag, 409, 'Este nome não tem mais tags disponíveis. Escolha outro.');
        const user = (
          await db.query(
            'INSERT INTO users(username,tag,password_hash) VALUES($1,$2,$3) RETURNING id',
            [body.username, tag, hash],
          )
        ).rows[0];
        await db.query('INSERT INTO user_preferences(user_id) VALUES($1)', [user.id]);
        return {
          s: await session(db, user.id, req.headers['user-agent']),
          user: await getUser(user.id, db),
        };
      });
      issue(app, reply, result.s);
      return reply.code(201).send({ user: result.user });
    },
  );
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 15, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      const body = z
        .object({ handle: z.string().max(40), password: z.string().max(200) })
        .parse(req.body);
      const split = body.handle.lastIndexOf('#');
      const user = (
        await pool.query(
          'SELECT * FROM users WHERE lower(username)=lower($1) AND tag=$2 AND deleted_at IS NULL AND disabled_at IS NULL',
          [body.handle.slice(0, split), body.handle.slice(split + 1)],
        )
      ).rows[0];
      const match = await bcrypt.compare(body.password, user?.password_hash ?? dummyHash);
      ensure(
        user && match && Buffer.byteLength(body.password) <= 72,
        401,
        'Usuário ou senha incorretos. Use nome#tag.',
      );
      const s = await tx((db) => session(db, user.id, req.headers['user-agent']));
      issue(app, reply, s);
      return { user: await getUser(user.id) };
    },
  );
  app.post('/api/auth/refresh', async (req, reply) => {
    const token = req.cookies.refresh;
    ensure(token, 401, 'Sessão expirada.');
    const result = await tx(async (db) => {
      const old = (
        await db.query('SELECT * FROM auth_sessions WHERE refresh_token_hash=$1 FOR UPDATE', [
          digest(token),
        ])
      ).rows[0];
      if (!old) return null;
      if (old.revoked_at) {
        await db.query(
          "UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,now()),revocation_reason='refresh_reuse' WHERE family_id=$1",
          [old.family_id],
        );
        return null;
      }
      if (new Date(old.expires_at).getTime() <= Date.now()) return null;
      const user = await getUser(old.user_id, db),
        s = await session(db, old.user_id, req.headers['user-agent'], old.family_id);
      await db.query(
        'UPDATE voice_participants SET auth_session_id=$2 WHERE auth_session_id=$1 AND left_at IS NULL',
        [old.id, s.row.id],
      );
      await db.query(
        'UPDATE push_subscriptions SET auth_session_id=$2 WHERE auth_session_id=$1 AND revoked_at IS NULL',
        [old.id, s.row.id],
      );
      await db.query(
        "UPDATE auth_sessions SET revoked_at=now(),revocation_reason='rotated',replaced_by_session_id=$2,last_used_at=now() WHERE id=$1",
        [old.id, s.row.id],
      );
      return { s, user };
    });
    if (!result) {
      clearCookies(reply);
      return reply.code(401).send({ error: 'Sessão expirada ou reutilizada. Entre novamente.' });
    }
    issue(app, reply, result.s);
    return { user: result.user };
  });
  app.post('/api/auth/logout', async (req, reply) => {
    if (req.cookies.refresh)
      await pool.query(
        "UPDATE auth_sessions SET revoked_at=now(),revocation_reason='logout' WHERE family_id IN(SELECT family_id FROM auth_sessions WHERE refresh_token_hash=$1)",
        [digest(req.cookies.refresh)],
      );
    clearCookies(reply);
    return { ok: true };
  });
}
