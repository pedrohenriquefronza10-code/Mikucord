import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { pool, tx, ensure, event, audit } from './db.js';
import { getUser, digest } from './auth.js';
import { guildAccess, channelAccess, P, ALL, BASIC } from './permissions.js';
import { status } from './redis.js';
import { canTheme } from './customization.js';
import { messageBody, sendMessage, changeMessage, hydrateMessage } from './messages.js';
const id = (input: unknown) => z.uuid().parse(input);
const param = (req: { params: unknown }, key: string) =>
  id((req.params as Record<string, string>)[key]);
export async function routes(app: FastifyInstance) {
  app.get('/api/me', async (req) => ({ user: await getUser(req.user.sub) }));
  app.patch('/api/me', async (req) => {
    const body = z
      .object({
        about_me: z.string().max(1000).optional(),
        custom_status_text: z.string().max(128).optional(),
        preferred_status: z.enum(['online', 'idle', 'dnd', 'invisible']).optional(),
        accent_color: z
          .string()
          .regex(/^#[0-9a-f]{6}$/i)
          .optional(),
      })
      .strict()
      .parse(req.body);
    await tx(async (db) => {
      for (const [key, value] of Object.entries(body))
        await db.query(`UPDATE users SET ${key}=$2,updated_at=now() WHERE id=$1`, [
          req.user.sub,
          value,
        ]);
      await event(db, 'profile.updated', req.user.sub, { userId: req.user.sub });
    });
    return { user: await getUser(req.user.sub) };
  });
  app.patch('/api/me/preferences', async (req) => {
    const body = z
      .object({
        theme_mode: z.enum(['dark', 'light', 'custom']).optional(),
        show_member_list: z.boolean().optional(),
        message_density: z.enum(['compact', 'normal', 'comfortable']).optional(),
        chat_font_size: z.number().int().min(12).max(28).optional(),
      })
      .strict()
      .parse(req.body);
    await tx(async (db) => {
      if (body.theme_mode === 'custom') {
        const preferences = (
          await db.query('SELECT theme_id FROM user_preferences WHERE user_id=$1', [req.user.sub])
        ).rows[0];
        ensure(preferences?.theme_id, 400, 'Escolha um tema personalizado primeiro.');
        await canTheme(req.user.sub, preferences.theme_id, db);
      }
      for (const [key, value] of Object.entries(body))
        await db.query(`UPDATE user_preferences SET ${key}=$2,updated_at=now() WHERE user_id=$1`, [
          req.user.sub,
          value,
        ]);
    });
    return { user: await getUser(req.user.sub) };
  });
  app.get('/api/guilds', async (req) => {
    const guilds = (
      await pool.query(
        'SELECT g.* FROM guilds g JOIN guild_members m ON m.guild_id=g.id WHERE m.user_id=$1 AND g.deleted_at IS NULL ORDER BY m.joined_at,g.id',
        [req.user.sub],
      )
    ).rows;
    return {
      guilds: await Promise.all(
        guilds.map(async (g) => ({
          ...g,
          permissions: (await guildAccess(req.user.sub, g.id)).permissions.toString(),
        })),
      ),
    };
  });
  app.post('/api/guilds', async (req, reply) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(100),
        description: z.string().max(1000).default(''),
      })
      .parse(req.body);
    const guild = await tx(async (db) => {
      const g = (
        await db.query(
          'INSERT INTO guilds(name,description,owner_id) VALUES($1,$2,$3) RETURNING *',
          [body.name, body.description, req.user.sub],
        )
      ).rows[0];
      await db.query('INSERT INTO guild_members(guild_id,user_id) VALUES($1,$2)', [
        g.id,
        req.user.sub,
      ]);
      await db.query(
        "INSERT INTO roles(guild_id,name,permissions,is_everyone) VALUES($1,'@everyone',$2,true)",
        [g.id, BASIC.toString()],
      );
      const role = (
        await db.query(
          "INSERT INTO roles(guild_id,name,color,permissions,position,hoist) VALUES($1,'Dono','#C4A5FF',$2,1,true) RETURNING id",
          [g.id, ALL.toString()],
        )
      ).rows[0];
      await db.query(
        'INSERT INTO guild_member_roles(guild_id,user_id,role_id,assigned_by) VALUES($1,$2,$3,$2)',
        [g.id, req.user.sub, role.id],
      );
      const category = (
        await db.query(
          "INSERT INTO channels(guild_id,type,name,created_by) VALUES($1,'category','Canais de texto',$2) RETURNING id",
          [g.id, req.user.sub],
        )
      ).rows[0];
      await db.query(
        "INSERT INTO channels(guild_id,type,name,topic,parent_id,created_by) VALUES($1,'text','geral','O começo de boas conversas. Chega mais!',$2,$3)",
        [g.id, category.id, req.user.sub],
      );
      await audit(db, g.id, req.user.sub, 'guild.create', g.id);
      await event(db, 'guild.changed', g.id, { guildId: g.id });
      return g;
    });
    return reply.code(201).send({ guild });
  });
  app.get('/api/guilds/:id/channels', async (req) => {
    const guild = param(req, 'id');
    await guildAccess(req.user.sub, guild);
    const all = (
      await pool.query(
        'SELECT * FROM channels WHERE guild_id=$1 AND deleted_at IS NULL ORDER BY position,created_at,id',
        [guild],
      )
    ).rows;
    const channels = [];
    for (const c of all) {
      try {
        const access = await channelAccess(req.user.sub, c.id);
        channels.push({ ...c, permissions: access.permissions.toString() });
      } catch {
        /* Inaccessible channels are omitted. */
      }
    }
    return { channels };
  });
  app.post('/api/guilds/:id/channels', async (req, reply) => {
    const guild = param(req, 'id'),
      body = z
        .object({
          name: z.string().trim().min(1).max(100),
          type: z
            .enum(['category', 'text', 'voice', 'video', 'announcement', 'forum', 'thread'])
            .default('text'),
          parentId: z.uuid().nullable().optional(),
          topic: z.string().max(1024).default(''),
          private: z.boolean().default(false),
          slowmode: z.number().int().min(0).max(21600).default(0),
        })
        .parse(req.body);
    const channel = await tx(async (db) => {
      const a = await guildAccess(req.user.sub, guild, db);
      if (body.type === 'thread') {
        ensure(body.parentId && !body.private, 400, 'Uma publicação precisa pertencer a um fórum.');
        const parent = await channelAccess(req.user.sub, body.parentId, P.SEND_MESSAGES, db);
        ensure(
          parent.channel.guild_id === guild && parent.channel.type === 'forum',
          400,
          'Fórum inválido.',
        );
      } else
        ensure((a.permissions & P.MANAGE_CHANNELS) !== 0n, 403, 'Sem permissão para criar canais.');
      if (body.parentId)
        ensure(
          (
            await db.query(
              "SELECT 1 FROM channels WHERE id=$1 AND guild_id=$2 AND type IN ('category','forum') AND deleted_at IS NULL",
              [body.parentId, guild],
            )
          ).rowCount,
          400,
          'Categoria inválida.',
        );
      ensure(
        body.type !== 'category' || !body.parentId,
        400,
        'Categoria não pode ter outra categoria como pai.',
      );
      const c = (
        await db.query(
          'INSERT INTO channels(guild_id,type,name,parent_id,topic,slowmode_seconds,permissions_synced,created_by,position) VALUES($1,$2,$3,$4,$5,$6,$7,$8,(SELECT COALESCE(max(position),0)+1 FROM channels WHERE guild_id=$1)) RETURNING *',
          [
            guild,
            body.type,
            body.name,
            body.parentId ?? null,
            body.topic,
            body.slowmode,
            !body.private,
            req.user.sub,
          ],
        )
      ).rows[0];
      if (body.private) {
        await db.query(
          'INSERT INTO channel_role_overwrites(guild_id,channel_id,role_id,deny) SELECT guild_id,$2,id,$3 FROM roles WHERE guild_id=$1 AND is_everyone',
          [guild, c.id, P.VIEW_CHANNEL.toString()],
        );
        await db.query(
          'INSERT INTO channel_member_overwrites(guild_id,channel_id,user_id,allow) VALUES($1,$2,$3,$4)',
          [guild, c.id, req.user.sub, BASIC.toString()],
        );
      }
      await audit(db, guild, req.user.sub, 'channel.create', c.id);
      await event(db, 'guild.changed', guild, { guildId: guild });
      return c;
    });
    return reply.code(201).send({ channel });
  });
  app.get('/api/guilds/:id/members', async (req) => {
    const guild = param(req, 'id');
    await guildAccess(req.user.sub, guild);
    const members = (
      await pool.query(
        `SELECT u.id,u.username,u.tag,u.avatar_asset_id,u.banner_asset_id,u.about_me,u.accent_color,u.preferred_status,u.custom_status_text,m.nickname,m.joined_at,
  COALESCE((SELECT json_agg(json_build_object('id',r.id,'name',r.name,'color',r.color,'position',r.position,'icon_asset_id',r.icon_asset_id) ORDER BY r.position DESC,r.id) FROM guild_member_roles mr JOIN roles r ON r.id=mr.role_id WHERE mr.guild_id=$1 AND mr.user_id=u.id),'[]') AS roles
  FROM guild_members m JOIN users u ON u.id=m.user_id WHERE m.guild_id=$1 ORDER BY lower(u.username),u.tag`,
        [guild],
      )
    ).rows;
    return {
      members: await Promise.all(
        members.map(async (m) => {
          const { preferred_status, ...rest } = m;
          return { ...rest, status: await status(m.id, preferred_status) };
        }),
      ),
    };
  });
  app.post('/api/guilds/:id/invites', async (req) => {
    const guild = param(req, 'id'),
      body = z
        .object({
          maxUses: z.number().int().positive().max(10000).nullable().default(null),
          expiresHours: z.number().int().min(1).max(720).default(168),
        })
        .parse(req.body ?? {});
    const a = await guildAccess(req.user.sub, guild);
    ensure((a.permissions & P.CREATE_INVITE) !== 0n, 403, 'Sem permissão para criar convites.');
    const code = randomBytes(24).toString('base64url');
    await pool.query(
      "INSERT INTO guild_invites(guild_id,created_by,code_hash,max_uses,expires_at) VALUES($1,$2,$3,$4,now()+$5*interval '1 hour')",
      [guild, req.user.sub, digest(code), body.maxUses, body.expiresHours],
    );
    return { code, url: `${configOrigin()}/?invite=${code}` };
  });
  app.post('/api/invites/:code/join', async (req) => {
    const code = z
      .string()
      .min(20)
      .max(100)
      .parse((req.params as { code: string }).code);
    const guild = await tx(async (db) => {
      const invite = (
        await db.query(
          'SELECT i.*,g.deleted_at FROM guild_invites i JOIN guilds g ON g.id=i.guild_id WHERE code_hash=$1 FOR UPDATE OF i',
          [digest(code)],
        )
      ).rows[0];
      ensure(
        invite &&
          !invite.deleted_at &&
          !invite.revoked_at &&
          (!invite.expires_at || new Date(invite.expires_at).getTime() > Date.now()),
        404,
        'Convite inválido ou expirado.',
      );
      ensure(
        !(
          await db.query(
            'SELECT 1 FROM guild_bans WHERE guild_id=$1 AND user_id=$2 AND (expires_at IS NULL OR expires_at>now())',
            [invite.guild_id, req.user.sub],
          )
        ).rowCount,
        403,
        'Você está banido deste servidor.',
      );
      const existing = (
        await db.query('SELECT 1 FROM guild_members WHERE guild_id=$1 AND user_id=$2', [
          invite.guild_id,
          req.user.sub,
        ])
      ).rowCount;
      if (!existing) {
        ensure(
          !invite.max_uses || invite.uses < invite.max_uses,
          410,
          'O convite já atingiu o limite de usos.',
        );
        await db.query('INSERT INTO guild_members(guild_id,user_id) VALUES($1,$2)', [
          invite.guild_id,
          req.user.sub,
        ]);
        await db.query('UPDATE guild_invites SET uses=uses+1 WHERE id=$1', [invite.id]);
        await event(db, 'guild.changed', invite.guild_id, { guildId: invite.guild_id });
      }
      return (await db.query('SELECT * FROM guilds WHERE id=$1', [invite.guild_id])).rows[0];
    });
    return { guild };
  });
  app.delete('/api/guilds/:id/membership', async (req) => {
    const guild = param(req, 'id');
    await tx(async (db) => {
      const a = await guildAccess(req.user.sub, guild, db);
      ensure(
        a.owner_id !== req.user.sub,
        400,
        'O dono precisa transferir o servidor antes de sair.',
      );
      await db.query('DELETE FROM guild_members WHERE guild_id=$1 AND user_id=$2', [
        guild,
        req.user.sub,
      ]);
      await event(db, 'guild.changed', guild, { guildId: guild, userId: req.user.sub });
    });
    return { ok: true };
  });
  app.get('/api/guilds/:id/roles', async (req) => {
    const guild = param(req, 'id');
    await guildAccess(req.user.sub, guild);
    return {
      roles: (
        await pool.query('SELECT * FROM roles WHERE guild_id=$1 ORDER BY position DESC,id', [guild])
      ).rows,
    };
  });
  app.post('/api/guilds/:id/roles', async (req, reply) => {
    const guild = param(req, 'id'),
      body = z
        .object({
          name: z.string().trim().min(1).max(100),
          color: z.string().regex(/^#[0-9a-f]{6}$/i),
          mentionable: z.boolean().default(true),
        })
        .parse(req.body);
    const role = await tx(async (db) => {
      const a = await guildAccess(req.user.sub, guild, db);
      ensure((a.permissions & P.MANAGE_ROLES) !== 0n, 403, 'Sem permissão para gerenciar cargos.');
      await db.query('SELECT id FROM guilds WHERE id=$1 FOR UPDATE', [guild]);
      const role = (
        await db.query(
          'INSERT INTO roles(guild_id,name,color,position,mentionable) VALUES($1,$2,$3,(SELECT COALESCE(max(position),0)+1 FROM roles WHERE guild_id=$1),$4) RETURNING *',
          [guild, body.name, body.color, body.mentionable],
        )
      ).rows[0];
      if (a.owner_id !== req.user.sub) {
        const top = Math.max(...a.roles.map((r) => r.position), 0);
        ensure(top > 1, 403, 'Sem espaço na hierarquia.');
        await db.query('UPDATE roles SET position=$2 WHERE id=$1', [role.id, top - 1]);
      }
      await audit(db, guild, req.user.sub, 'role.create', role.id);
      await event(db, 'guild.changed', guild, { guildId: guild });
      return role;
    });
    return reply.code(201).send({ role });
  });
  app.put('/api/guilds/:id/members/:user/roles/:role', async (req) => {
    const guild = param(req, 'id'),
      user = param(req, 'user'),
      role = param(req, 'role');
    await tx(async (db) => {
      const a = await guildAccess(req.user.sub, guild, db);
      ensure((a.permissions & P.MANAGE_ROLES) !== 0n, 403, 'Sem permissão para gerenciar cargos.');
      const r = (await db.query('SELECT * FROM roles WHERE id=$1 AND guild_id=$2', [role, guild]))
        .rows[0];
      ensure(r && !r.is_everyone, 404, 'Cargo não encontrado.');
      const target = await guildAccess(user, guild, db);
      if (a.owner_id !== req.user.sub) {
        const top = Math.max(...a.roles.map((r) => r.position), 0);
        ensure(
          r.position < top &&
            Math.max(...target.roles.map((r) => r.position), 0) < top &&
            (BigInt(r.permissions) & ~a.permissions) === 0n,
          403,
          'Essa atribuição viola a hierarquia.',
        );
      }
      ensure(
        (
          await db.query('SELECT 1 FROM roles WHERE id=$1 AND guild_id=$2 AND NOT is_everyone', [
            role,
            guild,
          ])
        ).rowCount,
        404,
        'Cargo não encontrado.',
      );
      await guildAccess(user, guild, db);
      await db.query(
        'INSERT INTO guild_member_roles(guild_id,user_id,role_id,assigned_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [guild, user, role, req.user.sub],
      );
      await audit(db, guild, req.user.sub, 'role.assign', user);
      await event(db, 'guild.changed', guild, { guildId: guild });
    });
    return { ok: true };
  });
  app.delete('/api/guilds/:id/members/:user/roles/:role', async (req) => {
    const guild = param(req, 'id'),
      user = param(req, 'user'),
      role = param(req, 'role');
    await tx(async (db) => {
      const a = await guildAccess(req.user.sub, guild, db);
      ensure((a.permissions & P.MANAGE_ROLES) !== 0n, 403, 'Sem permissão para gerenciar cargos.');
      const r = (await db.query('SELECT * FROM roles WHERE id=$1 AND guild_id=$2', [role, guild]))
        .rows[0];
      ensure(r && !r.is_everyone, 404, 'Cargo não encontrado.');
      const target = await guildAccess(user, guild, db);
      if (a.owner_id !== req.user.sub) {
        const top = Math.max(...a.roles.map((r) => r.position), 0);
        ensure(
          r.position < top &&
            Math.max(...target.roles.map((r) => r.position), 0) < top &&
            (BigInt(r.permissions) & ~a.permissions) === 0n,
          403,
          'Essa atribuição viola a hierarquia.',
        );
      }
      await db.query(
        'DELETE FROM guild_member_roles WHERE guild_id=$1 AND user_id=$2 AND role_id=$3',
        [guild, user, role],
      );
      await audit(db, guild, req.user.sub, 'role.unassign', user);
      await event(db, 'guild.changed', guild, { guildId: guild });
    });
    return { ok: true };
  });
  app.get('/api/channels/:id/messages', async (req) => {
    const channel = param(req, 'id');
    await channelAccess(req.user.sub, channel, P.READ_MESSAGE_HISTORY);
    const query = z.object({ before: z.uuid().optional() }).parse(req.query);
    const cursor = query.before
      ? (
          await pool.query('SELECT created_at,id FROM messages WHERE id=$1 AND channel_id=$2', [
            query.before,
            channel,
          ])
        ).rows[0]
      : null;
    if (query.before) ensure(cursor, 400, 'Cursor inválido.');
    const rows = (
      await pool.query(
        'SELECT id FROM messages WHERE channel_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51',
        [channel, cursor?.created_at ?? null, cursor?.id ?? null],
      )
    ).rows;
    return {
      messages: await Promise.all(
        rows
          .slice(0, 50)
          .reverse()
          .map((r) => hydrateMessage(r.id)),
      ),
      hasMore: rows.length > 50,
    };
  });
  app.post(
    '/api/channels/:id/messages',
    { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } },
    async (req, reply) =>
      reply.code(201).send({
        message: await sendMessage(req.user.sub, param(req, 'id'), messageBody.parse(req.body)),
      }),
  );
  app.patch('/api/messages/:id', async (req) => {
    const body = z
      .object({ content: z.string().trim().max(4000), version: z.string().regex(/^\d+$/) })
      .parse(req.body);
    return { message: await changeMessage(req.user.sub, param(req, 'id'), body) };
  });
  app.delete('/api/messages/:id', async (req) => {
    const body = z.object({ version: z.string().regex(/^\d+$/) }).parse(req.body);
    return { message: await changeMessage(req.user.sub, param(req, 'id'), body, true) };
  });
  app.put('/api/channels/:id/read', async (req) => {
    const channel = param(req, 'id'),
      body = z.object({ messageId: z.uuid() }).parse(req.body);
    await channelAccess(req.user.sub, channel, P.READ_MESSAGE_HISTORY);
    const m = (
      await pool.query('SELECT * FROM messages WHERE id=$1 AND channel_id=$2', [
        body.messageId,
        channel,
      ])
    ).rows[0];
    ensure(m, 404, 'Mensagem não encontrada.');
    await pool.query(
      'INSERT INTO channel_read_states(channel_id,user_id,last_read_message_id,last_read_at) VALUES($1,$2,$3,$4) ON CONFLICT(channel_id,user_id) DO UPDATE SET last_read_message_id=EXCLUDED.last_read_message_id,last_read_at=EXCLUDED.last_read_at,updated_at=now() WHERE channel_read_states.last_read_at IS NULL OR channel_read_states.last_read_at<=EXCLUDED.last_read_at',
      [channel, req.user.sub, m.id, m.created_at],
    );
    await pool.query(
      'UPDATE notifications SET read_at=now() WHERE recipient_id=$1 AND channel_id=$2 AND created_at<=$3 AND read_at IS NULL',
      [req.user.sub, channel, m.created_at],
    );
    return { ok: true };
  });
  app.get('/api/notifications', async (req) => {
    const rows = (
      await pool.query(
        'SELECT n.*,m.content,u.username FROM notifications n LEFT JOIN messages m ON m.id=n.message_id LEFT JOIN users u ON u.id=n.actor_id WHERE n.recipient_id=$1 AND n.read_at IS NULL AND (m.id IS NULL OR m.deleted_at IS NULL) ORDER BY n.created_at DESC LIMIT 100',
        [req.user.sub],
      )
    ).rows;
    const notifications = [];
    for (const n of rows) {
      try {
        if (n.channel_id) await channelAccess(req.user.sub, n.channel_id, P.READ_MESSAGE_HISTORY);
        notifications.push(n);
      } catch {}
    }
    return { notifications };
  });
}
import { config } from './config.js';
const configOrigin = () => config.APP_ORIGIN;
