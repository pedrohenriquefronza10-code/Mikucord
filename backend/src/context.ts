import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx, ensure, event, audit } from './db.js';
import { channelAccess, guildAccess, P } from './permissions.js';
import { hydrateMessage } from './messages.js';
export async function contextRoutes(app: FastifyInstance) {
  app.get('/api/guilds/:id/bans', async (req) => {
    const id = z.uuid().parse((req.params as { id: string }).id);
    const a = await guildAccess(req.user.sub, id);
    ensure((a.permissions & P.BAN_MEMBERS) !== 0n, 403, 'Sem permissão para ver banimentos.');
    return {
      bans: (
        await pool.query(
          'SELECT b.user_id,u.username,u.tag,b.reason FROM guild_bans b JOIN users u ON u.id=b.user_id WHERE b.guild_id=$1 ORDER BY u.username',
          [id],
        )
      ).rows,
    };
  });
  app.put('/api/guilds/:id/owner', async (req) => {
    const id = z.uuid().parse((req.params as { id: string }).id);
    const { userId } = z.object({ userId: z.uuid() }).parse(req.body);
    await tx(async (db) => {
      const a = await guildAccess(req.user.sub, id, db);
      ensure(a.owner_id === req.user.sub, 403, 'Apenas o dono pode transferir o servidor.');
      await guildAccess(userId, id, db);
      ensure(userId !== req.user.sub, 400, 'Escolha outro membro.');
      await db.query('UPDATE guilds SET owner_id=$2,updated_at=now() WHERE id=$1', [id, userId]);
      await audit(db, id, req.user.sub, 'guild.owner.transfer', userId);
      await event(db, 'guild.changed', id, { guildId: id });
    });
    return { ok: true };
  });
  app.delete('/api/guilds/:id', async (req) => {
    const id = z.uuid().parse((req.params as { id: string }).id);
    await tx(async (db) => {
      const a = await guildAccess(req.user.sub, id, db);
      ensure(a.owner_id === req.user.sub, 403, 'Apenas o dono pode excluir o servidor.');
      await db.query(
        'UPDATE channels SET deleted_at=now() WHERE guild_id=$1 AND deleted_at IS NULL',
        [id],
      );
      await db.query('UPDATE guilds SET deleted_at=now() WHERE id=$1', [id]);
      await audit(db, id, req.user.sub, 'guild.delete', id);
      const members = (await db.query('SELECT user_id FROM guild_members WHERE guild_id=$1', [id]))
        .rows;
      for (const member of members)
        await event(db, 'profile.updated', member.user_id, { userId: member.user_id });
    });
    return { ok: true };
  });
  app.get('/api/channels/:id', async (req) => {
    const id = z.uuid().parse((req.params as { id: string }).id),
      a = await channelAccess(req.user.sub, id);
    return { channel: { ...a.channel, permissions: a.permissions.toString() } };
  });
  app.get('/api/messages/:id/context', async (req) => {
    const id = z.uuid().parse((req.params as { id: string }).id),
      m = (await pool.query('SELECT * FROM messages WHERE id=$1', [id])).rows[0];
    ensure(m, 404, 'Mensagem não encontrada.');
    const a = await channelAccess(req.user.sub, m.channel_id, P.READ_MESSAGE_HISTORY);
    const before = (
      await pool.query(
        'SELECT id FROM messages WHERE channel_id=$1 AND (created_at,id)<=($2,$3) ORDER BY created_at DESC,id DESC LIMIT 30',
        [m.channel_id, m.created_at, id],
      )
    ).rows.reverse();
    const after = (
      await pool.query(
        'SELECT id FROM messages WHERE channel_id=$1 AND (created_at,id)>($2,$3) ORDER BY created_at,id LIMIT 20',
        [m.channel_id, m.created_at, id],
      )
    ).rows;
    return {
      channel: { ...a.channel, permissions: a.permissions.toString() },
      messages: await Promise.all([...before, ...after].map((r) => hydrateMessage(r.id))),
      hasMore: before.length === 30,
    };
  });
  app.delete('/api/channels/:id', async (req) => {
    const id = z.uuid().parse((req.params as { id: string }).id);
    await tx(async (db) => {
      const a = await channelAccess(req.user.sub, id, P.MANAGE_CHANNELS, db);
      ensure(a.channel.guild_id, 400, 'Use a opção de sair da conversa.');
      await db.query(
        'WITH RECURSIVE children AS(SELECT id FROM channels WHERE id=$1 UNION ALL SELECT c.id FROM channels c JOIN children p ON c.parent_id=p.id) UPDATE channels SET deleted_at=now() WHERE id IN(SELECT id FROM children)',
        [id],
      );
      await audit(db, a.channel.guild_id, req.user.sub, 'channel.delete', id);
      await event(db, 'guild.changed', a.channel.guild_id, { guildId: a.channel.guild_id });
    });
    return { ok: true };
  });
}
