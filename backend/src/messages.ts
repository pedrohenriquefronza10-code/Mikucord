import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pool, tx, ensure, event, audit, type DB } from './db.js';
import { channelAccess, P, ALL } from './permissions.js';
export const messageBody = z.object({
  content: z.string().trim().max(4000).default(''),
  attachmentIds: z.array(z.uuid()).max(20).default([]),
  stickerIds: z.array(z.uuid()).max(3).default([]),
  clientNonce: z.uuid(),
  replyTo: z.uuid().nullable().optional(),
});
export async function hydrateMessage(id: string, db: DB = pool) {
  return (
    await db.query(
      `SELECT m.*,json_build_object('id',u.id,'username',u.username,'tag',u.tag,'avatar_asset_id',u.avatar_asset_id,'accent_color',u.accent_color) AS author,
 COALESCE((SELECT json_agg(json_build_object('id',ma.id,'filename',a.original_filename,'size_bytes',o.size_bytes::text,'mime',o.detected_mime) ORDER BY ma.position) FROM message_attachments ma JOIN media_assets a ON a.id=ma.asset_id JOIN storage_objects o ON o.id=a.storage_object_id WHERE ma.message_id=m.id),'[]') AS attachments,
 COALESCE((SELECT json_agg(json_build_object('id',s.id,'name',s.name,'asset_id',s.asset_id)) FROM message_stickers ms JOIN custom_stickers s ON s.id=ms.sticker_id WHERE ms.message_id=m.id AND s.deleted_at IS NULL),'[]') AS stickers,
 COALESCE((SELECT json_agg(json_build_object('id',e.id,'name',COALESCE(me.input_name,e.name),'asset_id',e.asset_id)) FROM message_custom_emojis me JOIN custom_emojis e ON e.id=me.emoji_id WHERE me.message_id=m.id AND e.deleted_at IS NULL),'[]') AS emojis,
 COALESCE((SELECT json_agg(t) FROM(SELECT emoji_key,unicode_emoji,custom_emoji_id,count(*)::int AS count,array_agg(user_id) AS users FROM message_reactions WHERE message_id=m.id GROUP BY emoji_key,unicode_emoji,custom_emoji_id)t),'[]') AS reactions,
 CASE WHEN p.id IS NOT NULL THEN json_build_object('id',p.id,'content',p.content,'deleted_at',p.deleted_at,'username',pu.username) ELSE NULL END AS reply
 FROM messages m JOIN users u ON u.id=m.author_id LEFT JOIN messages p ON p.id=m.reply_to_message_id LEFT JOIN users pu ON pu.id=p.author_id WHERE m.id=$1`,
      [id],
    )
  ).rows[0];
}
async function mentions(
  db: DB,
  message: Record<string, any>,
  user: string,
  notify: boolean,
  permissions: bigint,
) {
  const { channel } = await channelAccess(user, message.channel_id, 0n, db);
  const members = (
    await db.query(
      channel.guild_id
        ? 'SELECT u.id,u.username,u.tag FROM guild_members gm JOIN users u ON u.id=gm.user_id WHERE gm.guild_id=$1'
        : 'SELECT u.id,u.username,u.tag FROM channel_members cm JOIN users u ON u.id=cm.user_id WHERE cm.channel_id=$1 AND cm.left_at IS NULL',
      [channel.guild_id ?? channel.id],
    )
  ).rows;
  const selected = new Set<string>();
  for (const match of message.content.matchAll(
    /<@([0-9a-f-]{36})>|@([\p{L}\p{N}_.-]+)#([0-9]{4})/giu,
  )) {
    const member = members.find(
      (m) =>
        m.id === match[1] ||
        (m.username.toLowerCase() === match[2]?.toLowerCase() && m.tag === match[3]),
    );
    if (member) selected.add(member.id);
  }
  const roleIDs = new Set<string>();
  for (const match of message.content.matchAll(/<@&([0-9a-f-]{36})>/gi)) roleIDs.add(match[1]);
  const roles = (
    await db.query('SELECT * FROM roles WHERE guild_id=$1 AND id=ANY($2::uuid[])', [
      channel.guild_id,
      [...roleIDs],
    ])
  ).rows;
  for (const role of roles)
    ensure(
      role.mentionable || (permissions & P.MENTION_EVERYONE) !== 0n,
      403,
      'Você não pode mencionar esse cargo.',
    );
  const everyone = /(^|\s)@everyone\b/.test(message.content);
  ensure(
    !everyone || (permissions & P.MENTION_EVERYONE) !== 0n,
    403,
    'Você não pode mencionar @everyone.',
  );
  await db.query('UPDATE messages SET mentions_everyone=$2 WHERE id=$1', [message.id, everyone]);
  await db.query('DELETE FROM message_user_mentions WHERE message_id=$1', [message.id]);
  await db.query('DELETE FROM message_role_mentions WHERE message_id=$1', [message.id]);
  for (const id of selected) {
    try {
      await channelAccess(id, message.channel_id, P.READ_MESSAGE_HISTORY, db);
    } catch {
      continue;
    }
    await db.query('INSERT INTO message_user_mentions VALUES($1,$2)', [message.id, id]);
  }
  for (const role of roles)
    await db.query('INSERT INTO message_role_mentions VALUES($1,$2,$3)', [
      message.id,
      channel.guild_id,
      role.id,
    ]);
  if (!notify) return;
  const recipients = new Map<string, string>();
  if (!channel.guild_id) for (const m of members) recipients.set(m.id, 'direct_message');
  if (everyone) for (const m of members) recipients.set(m.id, 'everyone_mention');
  for (const role of roles) {
    const assigned = role.is_everyone
      ? members
      : (await db.query('SELECT user_id AS id FROM guild_member_roles WHERE role_id=$1', [role.id]))
          .rows;
    for (const m of assigned) recipients.set(m.id, 'role_mention');
  }
  for (const id of selected) recipients.set(id, 'mention');
  for (const [recipient, kind] of recipients) {
    if (recipient === user) continue;
    try {
      await channelAccess(recipient, message.channel_id, P.READ_MESSAGE_HISTORY, db);
    } catch {
      continue;
    }
    await db.query(
      'INSERT INTO notifications(recipient_id,actor_id,kind,guild_id,channel_id,message_id,event_key) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
      [
        recipient,
        user,
        kind,
        channel.guild_id,
        message.channel_id,
        message.id,
        `mention:${message.id}`,
      ],
    );
  }
}
export async function sendMessage(
  user: string,
  channelId: string,
  body: z.infer<typeof messageBody>,
) {
  return tx(async (db) => {
    const { channel, permissions } = await channelAccess(user, channelId, P.SEND_MESSAGES, db);
    ensure(!['category', 'forum'].includes(channel.type), 400, 'Escolha uma conversa de texto.');
    if (channel.type === 'announcement')
      ensure(
        (permissions & P.MANAGE_GUILD) !== 0n,
        403,
        'Apenas a administração publica anúncios.',
      );
    ensure(
      body.content.trim() || body.attachmentIds.length || body.stickerIds.length,
      400,
      'Envie texto, um arquivo ou uma figurinha.',
    );
    if (body.attachmentIds.length)
      ensure((permissions & P.ATTACH_FILES) !== 0n, 403, 'Sem permissão para anexos.');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `message:${user}:${channelId}`,
    ]);
    const existing = (
      await db.query('SELECT id,channel_id FROM messages WHERE author_id=$1 AND client_nonce=$2', [
        user,
        body.clientNonce,
      ])
    ).rows[0];
    if (existing) {
      ensure(existing.channel_id === channelId, 409, 'Identificador já utilizado em outro canal.');
      return hydrateMessage(existing.id, db);
    }
    if (channel.slowmode_seconds > 0 && permissions !== ALL) {
      const recent = await db.query(
        "SELECT 1 FROM messages WHERE channel_id=$1 AND author_id=$2 AND created_at>now()-($3 * interval '1 second') LIMIT 1",
        [channelId, user, channel.slowmode_seconds],
      );
      ensure(!recent.rowCount, 429, `Aguarde ${channel.slowmode_seconds}s entre mensagens.`);
    }
    if (body.replyTo)
      ensure(
        (
          await db.query(
            'SELECT 1 FROM messages WHERE id=$1 AND channel_id=$2 AND deleted_at IS NULL',
            [body.replyTo, channelId],
          )
        ).rowCount,
        400,
        'Resposta inválida.',
      );
    const row = (
      await db.query(
        'INSERT INTO messages(id,channel_id,author_id,client_nonce,content,reply_to_message_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
        [randomUUID(), channelId, user, body.clientNonce, body.content, body.replyTo ?? null],
      )
    ).rows[0];
    for (const [index, asset] of [...new Set(body.attachmentIds)].entries()) {
      ensure(
        (
          await db.query(
            "SELECT 1 FROM media_assets a JOIN storage_objects o ON o.id=a.storage_object_id WHERE a.id=$1 AND a.owner_id=$2 AND a.channel_id=$3 AND a.purpose='attachment' AND a.deleted_at IS NULL AND o.state='ready'",
            [asset, user, channelId],
          )
        ).rowCount,
        403,
        'Anexo inválido ou de outro canal.',
      );
      await db.query(
        'INSERT INTO message_attachments(message_id,asset_id,position) VALUES($1,$2,$3)',
        [row.id, asset, index],
      );
    }
    for (const [index, sticker] of [...new Set(body.stickerIds)].entries()) {
      ensure(
        (
          await db.query(
            'SELECT 1 FROM custom_stickers WHERE id=$1 AND guild_id=$2 AND deleted_at IS NULL',
            [sticker, channel.guild_id],
          )
        ).rowCount,
        403,
        'Figurinha não disponível neste servidor.',
      );
      await db.query('INSERT INTO message_stickers VALUES($1,$2,$3)', [row.id, sticker, index]);
    }
    await resolveEmojis(db, row, channel.guild_id);
    await mentions(db, row, user, true, permissions);
    await event(
      db,
      'message.created',
      row.id,
      { guildId: channel.guild_id, channelId, messageId: row.id },
      row.version,
    );
    return hydrateMessage(row.id, db);
  });
}
export async function changeMessage(
  user: string,
  id: string,
  body: { content?: string; version: string },
  remove = false,
) {
  return tx(async (db) => {
    const row = (await db.query('SELECT * FROM messages WHERE id=$1 FOR UPDATE', [id])).rows[0];
    ensure(row && !row.deleted_at, 404, 'Mensagem não encontrada.');
    const { channel, permissions } = await channelAccess(
      user,
      row.channel_id,
      remove ? 0n : P.SEND_MESSAGES,
      db,
    );
    ensure(
      row.author_id === user || (remove && (permissions & P.MANAGE_MESSAGES) !== 0n),
      403,
      'Você não pode alterar essa mensagem.',
    );
    ensure(row.version === body.version, 409, 'A mensagem mudou. Atualize e tente novamente.');
    if (remove) {
      await db.query(
        "UPDATE messages SET content='',deleted_at=now(),deleted_by=$2,mentions_everyone=false,version=version+1,updated_at=now() WHERE id=$1",
        [id, user],
      );
      await db.query('DELETE FROM message_user_mentions WHERE message_id=$1', [id]);
      await db.query('DELETE FROM message_role_mentions WHERE message_id=$1', [id]);
      await db.query('DELETE FROM message_attachments WHERE message_id=$1', [id]);
      await db.query('DELETE FROM message_stickers WHERE message_id=$1', [id]);
      await db.query('DELETE FROM message_custom_emojis WHERE message_id=$1', [id]);
      await db.query('DELETE FROM message_reactions WHERE message_id=$1', [id]);
      await db.query('DELETE FROM notifications WHERE message_id=$1', [id]);
      if (channel.guild_id)
        await audit(db, channel.guild_id, user, 'message.moderation_delete', id);
    } else {
      await db.query(
        'UPDATE messages SET content=$2,edited_at=now(),updated_at=now(),version=version+1 WHERE id=$1',
        [id, body.content],
      );
      await resolveEmojis(db, { ...row, content: body.content }, channel.guild_id);
      await mentions(db, { ...row, content: body.content }, user, false, permissions);
    }
    const updated = await hydrateMessage(id, db);
    await event(
      db,
      remove ? 'message.deleted' : 'message.updated',
      id,
      { guildId: channel.guild_id, channelId: row.channel_id, messageId: id },
      updated.version,
    );
    return updated;
  });
}

async function resolveEmojis(db: DB, message: Record<string, any>, guild: string | null) {
  await db.query('DELETE FROM message_custom_emojis WHERE message_id=$1', [message.id]);
  const tokens = [
    ...message.content.matchAll(
      /<:([0-9a-f-]{36}):([A-Za-z0-9_]{2,32}):>|:([A-Za-z0-9_]{2,32}):/gi,
    ),
  ] as RegExpMatchArray[];
  for (const token of tokens) {
    if (!guild) {
      ensure(!token[1], 403, 'Emojis personalizados pertencem ao servidor.');
      continue;
    }
    const name = token[2] ?? token[3];
    const emoji = (
      await db.query(
        'SELECT id,name FROM custom_emojis WHERE guild_id=$1 AND deleted_at IS NULL AND ' +
          (token[1] ? 'id=$2::uuid' : 'lower(name)=lower($2)'),
        [guild, token[1] ?? name],
      )
    ).rows[0];
    if (token[1]) ensure(emoji, 403, 'Emoji indisponível neste servidor.');
    if (emoji)
      await db.query(
        'INSERT INTO message_custom_emojis(message_id,emoji_id,input_name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [message.id, emoji.id, name],
      );
  }
}
