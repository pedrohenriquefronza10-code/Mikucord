import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx, ensure, event, audit, type DB } from './db.js';
import { guildAccess, channelAccess, P, ALL } from './permissions.js';
import { getUser } from './auth.js';
const id = (p: unknown, k = 'id') => z.uuid().parse((p as Record<string, string>)[k]);
export const color = z.string().regex(/^#[0-9a-f]{6}$/i);
export const palette = z
  .object({
    primary: color,
    secondary: color,
    background: color,
    surface: color,
    text: color,
    accent: color,
  })
  .strict();
const bits = z
  .string()
  .regex(/^\d+$/)
  .refine((s) => BigInt(s) <= ALL, 'Permissões desconhecidas.');
export async function manageGuild(user: string, guild: string, permission: bigint, db: DB = pool) {
  const a = await guildAccess(user, guild, db);
  ensure((a.permissions & permission) !== 0n, 403, 'Sem permissão para esta ação.');
  return a;
}
export async function canTheme(user: string, theme: string, db: DB = pool) {
  const row = (
    await db.query(
      "SELECT * FROM themes WHERE id=$1 AND deleted_at IS NULL AND (owner_id=$2 OR (visibility='guild' AND EXISTS(SELECT 1 FROM guild_members WHERE user_id=$2 AND guild_id=themes.guild_id)))",
      [theme, user],
    )
  ).rows[0];
  ensure(row, 403, 'Tema indisponível.');
  return row;
}
function hierarchy(a: Awaited<ReturnType<typeof guildAccess>>, actor: string, position: number) {
  ensure(
    a.owner_id === actor ||
      position < Math.max(...a.roles.map((r: { position: number }) => r.position), 0),
    403,
    'Esse cargo está acima da sua hierarquia.',
  );
}
export async function customizationRoutes(app: FastifyInstance) {
  app.get('/api/themes', async (req) => ({
    themes: (
      await pool.query(
        "SELECT * FROM themes WHERE deleted_at IS NULL AND (owner_id=$1 OR (visibility='guild' AND guild_id IN(SELECT guild_id FROM guild_members WHERE user_id=$1))) ORDER BY created_at DESC",
        [req.user.sub],
      )
    ).rows,
  }));
  app.post('/api/themes', async (req, reply) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(64),
        base_mode: z.enum(['dark', 'light']),
        palette,
        guild_id: z.uuid().nullable().default(null),
      })
      .parse(req.body);
    if (body.guild_id) await guildAccess(req.user.sub, body.guild_id);
    const theme = (
      await pool.query(
        'INSERT INTO themes(owner_id,guild_id,name,visibility,base_mode,palette) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
        [
          req.user.sub,
          body.guild_id,
          body.name,
          body.guild_id ? 'guild' : 'private',
          body.base_mode,
          JSON.stringify(body.palette),
        ],
      )
    ).rows[0];
    return reply.code(201).send({ theme });
  });
  app.put('/api/me/theme', async (req) => {
    const body = z
      .object({
        mode: z.enum(['dark', 'light', 'custom']),
        theme_id: z.uuid().nullable().default(null),
      })
      .parse(req.body);
    if (body.mode === 'custom') {
      ensure(body.theme_id, 400, 'Escolha um tema.');
      await canTheme(req.user.sub, body.theme_id);
    }
    await pool.query(
      'UPDATE user_preferences SET theme_mode=$2,theme_id=$3,updated_at=now() WHERE user_id=$1',
      [req.user.sub, body.mode, body.mode === 'custom' ? body.theme_id : null],
    );
    return { user: await getUser(req.user.sub) };
  });
  app.delete('/api/themes/:id', async (req) => {
    const theme = id(req.params);
    await tx(async (db) => {
      ensure(
        (await db.query('SELECT 1 FROM themes WHERE id=$1 AND owner_id=$2', [theme, req.user.sub]))
          .rowCount,
        403,
        'Você só pode remover os seus temas.',
      );
      await db.query(
        "UPDATE user_preferences SET theme_id=NULL,theme_mode='dark' WHERE theme_id=$1",
        [theme],
      );
      await db.query('UPDATE guilds SET theme_id=NULL WHERE theme_id=$1', [theme]);
      await db.query('UPDATE themes SET deleted_at=now() WHERE id=$1', [theme]);
    });
    return { ok: true };
  });
  app.patch('/api/guilds/:id', async (req) => {
    const guild = id(req.params),
      body = z
        .object({
          name: z.string().trim().min(1).max(100).optional(),
          description: z.string().max(1000).optional(),
          tags: z.array(z.string().min(1).max(32)).max(10).optional(),
          boost_enabled: z.boolean().optional(),
          boost_level: z.number().int().min(0).max(3).optional(),
          theme_id: z.uuid().nullable().optional(),
          visual_settings: z.object({ palette: palette.optional() }).strict().optional(),
        })
        .strict()
        .parse(req.body);
    await tx(async (db) => {
      await manageGuild(req.user.sub, guild, P.MANAGE_GUILD, db);
      if (body.theme_id) await canTheme(req.user.sub, body.theme_id, db);
      if (body.boost_enabled === false) body.boost_level = 0;
      if (body.boost_enabled === true && body.boost_level === undefined) body.boost_level = 1;
      for (const [key, value] of Object.entries(body))
        await db.query(`UPDATE guilds SET ${key}=$2,updated_at=now() WHERE id=$1`, [
          guild,
          ['tags'].includes(key)
            ? value
            : typeof value === 'object' && value !== null
              ? JSON.stringify(value)
              : value,
        ]);
      await audit(db, guild, req.user.sub, 'guild.update', guild);
      await event(db, 'guild.changed', guild, { guildId: guild });
    });
    return { guild: (await pool.query('SELECT * FROM guilds WHERE id=$1', [guild])).rows[0] };
  });
  app.get('/api/guilds/:id/audit', async (req) => {
    const guild = id(req.params);
    await manageGuild(req.user.sub, guild, P.VIEW_AUDIT_LOG);
    const q = z.object({ before: z.iso.datetime().optional() }).parse(req.query);
    return {
      logs: (
        await pool.query(
          'SELECT a.*,u.username FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE a.guild_id=$1 AND ($2::timestamptz IS NULL OR a.created_at<$2) ORDER BY a.created_at DESC,a.id DESC LIMIT 100',
          [guild, q.before ?? null],
        )
      ).rows,
    };
  });
  app.patch('/api/guilds/:id/roles/:role', async (req) => {
    const guild = id(req.params),
      role = id(req.params, 'role'),
      body = z
        .object({
          name: z.string().trim().min(1).max(100).optional(),
          color: color.nullable().optional(),
          permissions: bits.optional(),
          position: z.number().int().positive().optional(),
          mentionable: z.boolean().optional(),
          hoist: z.boolean().optional(),
        })
        .strict()
        .parse(req.body);
    await tx(async (db) => {
      const a = await manageGuild(req.user.sub, guild, P.MANAGE_ROLES, db);
      await db.query('SELECT id FROM guilds WHERE id=$1 FOR UPDATE', [guild]);
      const r = (await db.query('SELECT * FROM roles WHERE id=$1 AND guild_id=$2', [role, guild]))
        .rows[0];
      ensure(r, 404, 'Cargo não encontrado.');
      hierarchy(a, req.user.sub, r.position);
      if (body.position !== undefined) {
        ensure(!r.is_everyone, 400, 'Everyone tem posição fixa.');
        hierarchy(a, req.user.sub, body.position);
      }
      if (body.permissions)
        ensure(
          (BigInt(body.permissions) & ~a.permissions) === 0n,
          403,
          'Você não pode conceder permissões que não possui.',
        );
      for (const [key, value] of Object.entries(body))
        await db.query(`UPDATE roles SET ${key}=$2,updated_at=now() WHERE id=$1`, [role, value]);
      await audit(db, guild, req.user.sub, 'role.update', role);
      await event(db, 'guild.changed', guild, { guildId: guild });
    });
    return { ok: true };
  });
  app.delete('/api/guilds/:id/roles/:role', async (req) => {
    const guild = id(req.params),
      role = id(req.params, 'role');
    await tx(async (db) => {
      const a = await manageGuild(req.user.sub, guild, P.MANAGE_ROLES, db),
        r = (await db.query('SELECT * FROM roles WHERE id=$1 AND guild_id=$2', [role, guild]))
          .rows[0];
      ensure(r && !r.is_everyone, 400, 'Esse cargo não pode ser removido.');
      hierarchy(a, req.user.sub, r.position);
      await db.query('DELETE FROM message_role_mentions WHERE role_id=$1', [role]);
      await db.query('DELETE FROM roles WHERE id=$1', [role]);
      await audit(db, guild, req.user.sub, 'role.delete', role);
      await event(db, 'guild.changed', guild, { guildId: guild });
    });
    return { ok: true };
  });
  app.patch('/api/channels/:id', async (req) => {
    const channel = id(req.params),
      body = z
        .object({
          name: z.string().trim().min(1).max(100).optional(),
          topic: z.string().max(1024).optional(),
          slowmode_seconds: z.number().int().min(0).max(21600).optional(),
          position: z.number().int().min(0).max(1000000).optional(),
          permissions_synced: z.boolean().optional(),
        })
        .strict()
        .parse(req.body);
    await tx(async (db) => {
      const a = await channelAccess(req.user.sub, channel, P.MANAGE_CHANNELS, db);
      ensure(a.channel.guild_id, 400, 'Use as configurações da conversa.');
      for (const [key, value] of Object.entries(body))
        await db.query(`UPDATE channels SET ${key}=$2,updated_at=now() WHERE id=$1`, [
          channel,
          value,
        ]);
      await audit(db, a.channel.guild_id, req.user.sub, 'channel.update', channel);
      await event(db, 'guild.changed', a.channel.guild_id, { guildId: a.channel.guild_id });
    });
    return { ok: true };
  });
  app.get('/api/channels/:id/overwrites', async (req) => {
    const a = await channelAccess(req.user.sub, id(req.params), P.MANAGE_ROLES);
    return {
      roles: (
        await pool.query('SELECT * FROM channel_role_overwrites WHERE channel_id=$1', [
          a.channel.id,
        ])
      ).rows,
      members: (
        await pool.query('SELECT * FROM channel_member_overwrites WHERE channel_id=$1', [
          a.channel.id,
        ])
      ).rows,
    };
  });
  app.put('/api/channels/:id/overwrites', async (req) => {
    const channel = id(req.params),
      body = z
        .object({ target: z.enum(['role', 'member']), targetId: z.uuid(), allow: bits, deny: bits })
        .parse(req.body);
    ensure(
      (BigInt(body.allow) & BigInt(body.deny)) === 0n,
      400,
      'Um bit não pode ser permitido e negado ao mesmo tempo.',
    );
    await tx(async (db) => {
      const a = await channelAccess(req.user.sub, channel, P.MANAGE_ROLES, db);
      ensure(a.channel.guild_id, 400, 'DMs não usam cargos.');
      ensure(
        ((BigInt(body.allow) | BigInt(body.deny)) & ~a.member.permissions) === 0n,
        403,
        'Você não pode modificar permissões que não tem.',
      );
      if (body.target === 'role') {
        const role = (
          await db.query('SELECT * FROM roles WHERE id=$1 AND guild_id=$2', [
            body.targetId,
            a.channel.guild_id,
          ])
        ).rows[0];
        ensure(role, 404, 'Cargo não encontrado.');
        hierarchy(a.member, req.user.sub, role.position);
      } else {
        const target = await guildAccess(body.targetId, a.channel.guild_id, db);
        if (body.targetId !== req.user.sub)
          hierarchy(
            a.member,
            req.user.sub,
            Math.max(...target.roles.map((r: { position: number }) => r.position), 0),
          );
      }
      const table =
          body.target === 'role' ? 'channel_role_overwrites' : 'channel_member_overwrites',
        column = body.target === 'role' ? 'role_id' : 'user_id';
      await db.query(
        `INSERT INTO ${table}(guild_id,channel_id,${column},allow,deny) VALUES($1,$2,$3,$4,$5) ON CONFLICT(channel_id,${column}) DO UPDATE SET allow=EXCLUDED.allow,deny=EXCLUDED.deny`,
        [a.channel.guild_id, channel, body.targetId, body.allow, body.deny],
      );
      await db.query('UPDATE channels SET permissions_synced=false WHERE id=$1', [channel]);
      await audit(db, a.channel.guild_id, req.user.sub, 'channel.overwrite', channel);
      await event(db, 'guild.changed', a.channel.guild_id, { guildId: a.channel.guild_id });
    });
    return { ok: true };
  });
  app.post('/api/guilds/:id/moderation', async (req) => {
    const guild = id(req.params),
      body = z
        .object({
          userId: z.uuid(),
          action: z.enum(['kick', 'ban', 'unban', 'timeout']),
          reason: z.string().max(1000).default(''),
          minutes: z.number().int().min(0).max(40320).default(60),
        })
        .parse(req.body);
    ensure(body.userId !== req.user.sub, 400, 'Escolha outro membro.');
    await tx(async (db) => {
      const a = await manageGuild(
        req.user.sub,
        guild,
        {
          kick: P.KICK_MEMBERS,
          ban: P.BAN_MEMBERS,
          unban: P.BAN_MEMBERS,
          timeout: P.MODERATE_MEMBERS,
        }[body.action],
        db,
      );
      const g = (await db.query('SELECT owner_id FROM guilds WHERE id=$1', [guild])).rows[0];
      ensure(g.owner_id !== body.userId, 403, 'O dono do servidor é protegido.');
      if (body.action !== 'unban') {
        const target = await guildAccess(body.userId, guild, db);
        hierarchy(
          a,
          req.user.sub,
          Math.max(...target.roles.map((r: { position: number }) => r.position), 0),
        );
      }
      if (body.action === 'timeout')
        await db.query(
          "UPDATE guild_members SET timeout_until=CASE WHEN $3=0 THEN NULL ELSE now()+$3*interval '1 minute' END WHERE guild_id=$1 AND user_id=$2",
          [guild, body.userId, body.minutes],
        );
      else if (body.action === 'unban')
        await db.query('DELETE FROM guild_bans WHERE guild_id=$1 AND user_id=$2', [
          guild,
          body.userId,
        ]);
      else {
        if (body.action === 'ban')
          await db.query(
            'INSERT INTO guild_bans(guild_id,user_id,banned_by,reason) VALUES($1,$2,$3,$4) ON CONFLICT(guild_id,user_id) DO UPDATE SET reason=EXCLUDED.reason',
            [guild, body.userId, req.user.sub, body.reason],
          );
        await db.query('DELETE FROM guild_members WHERE guild_id=$1 AND user_id=$2', [
          guild,
          body.userId,
        ]);
      }
      await audit(db, guild, req.user.sub, `member.${body.action}`, body.userId);
      await event(db, 'guild.changed', guild, { guildId: guild, userId: body.userId });
      await event(db, 'profile.updated', body.userId, { userId: body.userId });
    });
    return { ok: true };
  });
}
