import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx, ensure, event } from './db.js';
import { channelAccess, P } from './permissions.js';
import { hydrateMessage } from './messages.js';
import { status } from './redis.js';
const param = (p: unknown, key = 'id') => z.uuid().parse((p as Record<string, string>)[key]);
export async function socialRoutes(app: FastifyInstance) {
  app.get('/api/people', async (req) => {
    const { q } = z.object({ q: z.string().trim().min(2).max(40) }).parse(req.query);
    return {
      users: (
        await pool.query(
          `SELECT u.id,u.username,u.tag,u.avatar_asset_id,u.accent_color FROM users u WHERE u.deleted_at IS NULL AND u.disabled_at IS NULL AND u.id<>$1 AND (lower(u.username||'#'||u.tag)=lower($2) OR (u.username ILIKE $3 AND (EXISTS(SELECT 1 FROM guild_members a JOIN guild_members b ON a.guild_id=b.guild_id WHERE a.user_id=$1 AND b.user_id=u.id) OR EXISTS(SELECT 1 FROM friendships f WHERE least($1::uuid,u.id)=f.user_low_id AND greatest($1::uuid,u.id)=f.user_high_id)))) LIMIT 30`,
          [req.user.sub, q, `%${q.replace(/[%_\\]/g, '\\$&')}%`],
        )
      ).rows,
    };
  });
  app.get('/api/friends', async (req) => {
    const friends = (
      await pool.query(
        `SELECT u.id,u.username,u.tag,u.avatar_asset_id,u.accent_color,u.preferred_status,u.custom_status_text FROM friendships f JOIN users u ON u.id=CASE WHEN f.user_low_id=$1 THEN f.user_high_id ELSE f.user_low_id END WHERE $1 IN(f.user_low_id,f.user_high_id)`,
        [req.user.sub],
      )
    ).rows;
    const requests = (
      await pool.query(
        `SELECT r.*,s.username AS sender_name,s.tag AS sender_tag,t.username AS recipient_name,t.tag AS recipient_tag FROM friend_requests r JOIN users s ON s.id=r.sender_id JOIN users t ON t.id=r.recipient_id WHERE r.status='pending' AND $1 IN(r.sender_id,r.recipient_id)`,
        [req.user.sub],
      )
    ).rows;
    const blocks = (
      await pool.query(
        'SELECT u.id,u.username,u.tag FROM user_blocks b JOIN users u ON u.id=b.blocked_id WHERE b.blocker_id=$1',
        [req.user.sub],
      )
    ).rows;
    return {
      friends: await Promise.all(
        friends.map(async (f) => {
          const { preferred_status, ...rest } = f;
          return { ...rest, status: await status(f.id, preferred_status) };
        }),
      ),
      requests,
      blocks,
    };
  });
  app.post('/api/friends/requests', async (req, reply) => {
    const { userId } = z.object({ userId: z.uuid() }).parse(req.body);
    ensure(userId !== req.user.sub, 400, 'Escolha outra pessoa.');
    const request = await tx(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        [req.user.sub, userId].sort().join(':'),
      ]);
      ensure(
        (
          await db.query(
            'SELECT 1 FROM users WHERE id=$1 AND disabled_at IS NULL AND deleted_at IS NULL',
            [userId],
          )
        ).rowCount,
        404,
        'Pessoa não encontrada.',
      );
      ensure(
        !(
          await db.query(
            'SELECT 1 FROM user_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)',
            [req.user.sub, userId],
          )
        ).rowCount,
        403,
        'Não é possível enviar esse pedido.',
      );
      ensure(
        !(
          await db.query(
            'SELECT 1 FROM friendships WHERE user_low_id=least($1::uuid,$2::uuid) AND user_high_id=greatest($1::uuid,$2::uuid)',
            [req.user.sub, userId],
          )
        ).rowCount,
        409,
        'Vocês já são amigos.',
      );
      const pending = (
        await db.query(
          "SELECT * FROM friend_requests WHERE status='pending' AND ((sender_id=$1 AND recipient_id=$2) OR (sender_id=$2 AND recipient_id=$1))",
          [req.user.sub, userId],
        )
      ).rows[0];
      if (pending) return pending;
      const row = (
        await db.query(
          'INSERT INTO friend_requests(sender_id,recipient_id) VALUES($1,$2) RETURNING *',
          [req.user.sub, userId],
        )
      ).rows[0];
      await db.query(
        "INSERT INTO notifications(recipient_id,actor_id,kind,friend_request_id,event_key) VALUES($1,$2,'friend_request',$3,$4)",
        [userId, req.user.sub, row.id, `friend:${row.id}`],
      );
      await event(db, 'social.changed', userId, { userId });
      return row;
    });
    return reply.code(201).send({ request });
  });
  app.patch('/api/friends/requests/:id', async (req) => {
    const id = param(req.params),
      { action } = z.object({ action: z.enum(['accept', 'decline', 'cancel']) }).parse(req.body);
    await tx(async (db) => {
      const r = (await db.query('SELECT * FROM friend_requests WHERE id=$1 FOR UPDATE', [id]))
        .rows[0];
      ensure(r && r.status === 'pending', 404, 'Pedido não encontrado.');
      ensure(
        action === 'cancel' ? r.sender_id === req.user.sub : r.recipient_id === req.user.sub,
        403,
        'Este pedido não é seu.',
      );
      ensure(
        !(
          await db.query(
            'SELECT 1 FROM user_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)',
            [r.sender_id, r.recipient_id],
          )
        ).rowCount,
        403,
        'Pedido bloqueado.',
      );
      await db.query('UPDATE friend_requests SET status=$2,responded_at=now() WHERE id=$1', [
        id,
        { accept: 'accepted', decline: 'declined', cancel: 'cancelled' }[action],
      ]);
      if (action === 'accept')
        await db.query(
          'INSERT INTO friendships(user_low_id,user_high_id) VALUES(least($1::uuid,$2::uuid),greatest($1::uuid,$2::uuid)) ON CONFLICT DO NOTHING',
          [r.sender_id, r.recipient_id],
        );
      await db.query('UPDATE notifications SET read_at=now() WHERE friend_request_id=$1', [id]);
      for (const userId of [r.sender_id, r.recipient_id])
        await event(db, 'social.changed', userId, { userId });
    });
    return { ok: true };
  });
  app.delete('/api/friends/:id', async (req) => {
    const id = param(req.params);
    await pool.query(
      'DELETE FROM friendships WHERE user_low_id=least($1::uuid,$2::uuid) AND user_high_id=greatest($1::uuid,$2::uuid)',
      [id, req.user.sub],
    );
    return { ok: true };
  });
  app.put('/api/people/:id/block', async (req) => {
    const id = param(req.params);
    ensure(id !== req.user.sub, 400, 'Você não pode bloquear a si mesmo.');
    await tx(async (db) => {
      await db.query(
        'INSERT INTO user_blocks(blocker_id,blocked_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [req.user.sub, id],
      );
      await db.query(
        'DELETE FROM friendships WHERE user_low_id=least($1::uuid,$2::uuid) AND user_high_id=greatest($1::uuid,$2::uuid)',
        [id, req.user.sub],
      );
      await db.query(
        "UPDATE friend_requests SET status='cancelled',responded_at=now() WHERE status='pending' AND ((sender_id=$1 AND recipient_id=$2) OR (sender_id=$2 AND recipient_id=$1))",
        [id, req.user.sub],
      );
      await event(db, 'social.changed', req.user.sub, { userId: req.user.sub });
    });
    return { ok: true };
  });
  app.delete('/api/people/:id/block', async (req) => {
    await pool.query('DELETE FROM user_blocks WHERE blocker_id=$1 AND blocked_id=$2', [
      req.user.sub,
      param(req.params),
    ]);
    return { ok: true };
  });
  app.get('/api/conversations', async (req) => {
    const channels = (
      await pool.query(
        `SELECT c.* FROM channels c JOIN channel_members m ON m.channel_id=c.id WHERE m.user_id=$1 AND m.left_at IS NULL AND c.guild_id IS NULL AND c.deleted_at IS NULL ORDER BY c.updated_at DESC`,
        [req.user.sub],
      )
    ).rows;
    for (const c of channels)
      c.members = (
        await pool.query(
          'SELECT u.id,u.username,u.tag,u.avatar_asset_id,u.accent_color FROM channel_members m JOIN users u ON u.id=m.user_id WHERE m.channel_id=$1 AND m.left_at IS NULL',
          [c.id],
        )
      ).rows;
    return { channels };
  });
  app.post('/api/conversations', async (req, reply) => {
    const body = z
        .object({
          members: z.array(z.uuid()).min(1).max(24),
          name: z.string().trim().min(1).max(100).optional(),
        })
        .parse(req.body),
      users = [...new Set([req.user.sub, ...body.members])].sort();
    ensure(users.length >= 2, 400, 'Escolha pelo menos outra pessoa.');
    const channel = await tx(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `dm:${users.join(':')}`,
      ]);
      for (const user of users.filter((u) => u !== req.user.sub)) {
        ensure(
          (
            await db.query(
              `SELECT 1 FROM users u WHERE id=$2 AND deleted_at IS NULL AND disabled_at IS NULL AND (EXISTS(SELECT 1 FROM friendships WHERE user_low_id=least($1::uuid,$2::uuid) AND user_high_id=greatest($1::uuid,$2::uuid)) OR EXISTS(SELECT 1 FROM guild_members a JOIN guild_members b ON a.guild_id=b.guild_id WHERE a.user_id=$1 AND b.user_id=$2))`,
              [req.user.sub, user],
            )
          ).rowCount,
          403,
          'Convide apenas amigos ou membros de um servidor compartilhado.',
        );
        ensure(
          !(
            await db.query(
              'SELECT 1 FROM user_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)',
              [req.user.sub, user],
            )
          ).rowCount,
          403,
          'Não é possível conversar com essa pessoa.',
        );
      }
      let c =
        users.length === 2 && !body.name
          ? (
              await db.query(
                "SELECT * FROM channels WHERE type='dm' AND dm_user_low_id=$1 AND dm_user_high_id=$2",
                users,
              )
            ).rows[0]
          : null;
      if (!c)
        c = (
          await db.query(
            'INSERT INTO channels(type,name,created_by,dm_user_low_id,dm_user_high_id,group_owner_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
            [
              users.length === 2 && !body.name ? 'dm' : 'group_dm',
              body.name ?? 'Conversa',
              req.user.sub,
              users.length === 2 && !body.name ? users[0] : null,
              users.length === 2 && !body.name ? users[1] : null,
              users.length === 2 && !body.name ? null : req.user.sub,
            ],
          )
        ).rows[0];
      for (const user of users) {
        await db.query(
          'INSERT INTO channel_members(channel_id,user_id) VALUES($1,$2) ON CONFLICT(channel_id,user_id) DO UPDATE SET left_at=NULL',
          [c.id, user],
        );
        await event(db, 'social.changed', user, { userId: user });
      }
      return c;
    });
    return reply.code(201).send({ channel });
  });
  app.get('/api/conversations/:id', async (req) => {
    const id = param(req.params),
      a = await channelAccess(req.user.sub, id);
    ensure(!a.channel.guild_id, 400, 'Esta conversa é de um servidor.');
    const members = (
      await pool.query(
        'SELECT u.id,u.username,u.tag,u.avatar_asset_id,u.banner_asset_id,u.about_me,u.accent_color,u.custom_status_text,u.preferred_status FROM channel_members m JOIN users u ON u.id=m.user_id WHERE m.channel_id=$1 AND m.left_at IS NULL',
        [id],
      )
    ).rows;
    return {
      channel: { ...a.channel, permissions: a.permissions.toString() },
      members: await Promise.all(
        members.map(async (m) => {
          const { preferred_status, ...rest } = m;
          return { ...rest, roles: [], status: await status(m.id, preferred_status) };
        }),
      ),
    };
  });
  app.delete('/api/conversations/:id/membership', async (req) => {
    const id = param(req.params);
    await tx(async (db) => {
      const a = await channelAccess(req.user.sub, id, 0n, db);
      ensure(!a.channel.guild_id, 400, 'Conversa inválida.');
      await db.query(
        'UPDATE channel_members SET left_at=now() WHERE channel_id=$1 AND user_id=$2',
        [id, req.user.sub],
      );
      if (a.channel.group_owner_id === req.user.sub) {
        const next = (
          await db.query(
            'SELECT user_id FROM channel_members WHERE channel_id=$1 AND left_at IS NULL ORDER BY joined_at LIMIT 1',
            [id],
          )
        ).rows[0];
        if (next)
          await db.query('UPDATE channels SET group_owner_id=$2 WHERE id=$1', [id, next.user_id]);
      }
      await event(db, 'social.changed', req.user.sub, { userId: req.user.sub });
    });
    return { ok: true };
  });
  app.get('/api/search', async (req) => {
    const q = z
      .object({
        q: z.string().trim().min(1).max(200),
        guild: z.uuid().optional(),
        channel: z.uuid().optional(),
        author: z.uuid().optional(),
        before: z.iso.datetime().optional(),
        after: z.iso.datetime().optional(),
      })
      .parse(req.query);
    const rows = (
      await pool.query(
        `SELECT m.id,m.channel_id,c.name AS channel_name,c.guild_id FROM messages m JOIN channels c ON c.id=m.channel_id WHERE m.deleted_at IS NULL AND c.deleted_at IS NULL AND to_tsvector('simple',m.content) @@ websearch_to_tsquery('simple',$1) AND ($2::uuid IS NULL OR c.guild_id=$2) AND ($3::uuid IS NULL OR m.channel_id=$3) AND ($4::uuid IS NULL OR m.author_id=$4) AND ($5::timestamptz IS NULL OR m.created_at<$5) AND ($6::timestamptz IS NULL OR m.created_at>$6) AND (EXISTS(SELECT 1 FROM guild_members g WHERE g.guild_id=c.guild_id AND g.user_id=$7) OR EXISTS(SELECT 1 FROM channel_members cm WHERE cm.channel_id=c.id AND cm.user_id=$7 AND cm.left_at IS NULL)) ORDER BY m.created_at DESC,m.id DESC LIMIT 500`,
        [
          q.q,
          q.guild ?? null,
          q.channel ?? null,
          q.author ?? null,
          q.before ?? null,
          q.after ?? null,
          req.user.sub,
        ],
      )
    ).rows;
    const results = [];
    for (const row of rows) {
      try {
        await channelAccess(req.user.sub, row.channel_id, P.READ_MESSAGE_HISTORY);
        results.push({
          ...(await hydrateMessage(row.id)),
          channel_name: row.channel_name,
          guild_id: row.guild_id,
        });
        if (results.length === 40) break;
      } catch {}
    }
    return { results };
  });
  app.put('/api/messages/:id/reactions', async (req) => {
    const id = param(req.params),
      body = z
        .object({ emoji: z.string().min(1).max(64).optional(), customEmojiId: z.uuid().optional() })
        .refine((b) => !!b.emoji !== !!b.customEmojiId)
        .parse(req.body);
    await tx(async (db) => {
      const m = (
        await db.query('SELECT * FROM messages WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id])
      ).rows[0];
      ensure(m, 404, 'Mensagem não encontrada.');
      const a = await channelAccess(req.user.sub, m.channel_id, P.ADD_REACTIONS, db);
      if (body.emoji)
        ensure(
          /\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u.test(body.emoji),
          400,
          'Selecione um emoji válido.',
        );
      if (body.customEmojiId)
        ensure(
          (
            await db.query(
              'SELECT 1 FROM custom_emojis WHERE id=$1 AND guild_id=$2 AND deleted_at IS NULL',
              [body.customEmojiId, a.channel.guild_id],
            )
          ).rowCount,
          403,
          'Emoji indisponível.',
        );
      const unicode = body.emoji?.normalize('NFC'),
        key = body.customEmojiId ? `c:${body.customEmojiId}` : `u:${unicode}`;
      const removed = await db.query(
        'DELETE FROM message_reactions WHERE message_id=$1 AND user_id=$2 AND emoji_key=$3',
        [id, req.user.sub, key],
      );
      if (!removed.rowCount)
        await db.query(
          'INSERT INTO message_reactions(message_id,user_id,emoji_key,unicode_emoji,custom_emoji_id) VALUES($1,$2,$3,$4,$5)',
          [id, req.user.sub, key, unicode ?? null, body.customEmojiId ?? null],
        );
      await event(
        db,
        'message.updated',
        id,
        { channelId: m.channel_id, guildId: a.channel.guild_id, messageId: id },
        m.version,
      );
    });
    return { ok: true };
  });
}
