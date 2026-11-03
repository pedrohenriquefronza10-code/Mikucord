import { pool, ensure, type DB } from './db.js';
export const P = Object.fromEntries(
  [
    'VIEW_CHANNEL',
    'READ_MESSAGE_HISTORY',
    'SEND_MESSAGES',
    'MANAGE_MESSAGES',
    'ATTACH_FILES',
    'ADD_REACTIONS',
    'MENTION_EVERYONE',
    'MANAGE_CHANNELS',
    'MANAGE_GUILD',
    'MANAGE_ROLES',
    'CREATE_INVITE',
    'KICK_MEMBERS',
    'BAN_MEMBERS',
    'MODERATE_MEMBERS',
    'VIEW_AUDIT_LOG',
    'CONNECT',
    'SPEAK',
    'VIDEO',
    'STREAM',
    'MUTE_MEMBERS',
    'DEAFEN_MEMBERS',
    'MOVE_MEMBERS',
    'USE_SOUNDBOARD',
    'MANAGE_EXPRESSIONS',
    'CHANGE_NICKNAME',
    'MANAGE_NICKNAMES',
    'ADMINISTRATOR',
  ].map((n, i) => [n, 1n << BigInt(i)]),
) as Record<string, bigint>;
export const ALL = (1n << 27n) - 1n;
export const BASIC =
  P.VIEW_CHANNEL |
  P.READ_MESSAGE_HISTORY |
  P.SEND_MESSAGES |
  P.ATTACH_FILES |
  P.ADD_REACTIONS |
  P.CREATE_INVITE |
  P.CHANGE_NICKNAME |
  P.CONNECT |
  P.SPEAK |
  P.VIDEO |
  P.STREAM |
  P.USE_SOUNDBOARD;
export type GuildMembership = {
  owner_id: string;
  timeout_until: Date | null;
  roles: Array<{
    id: string;
    permissions: string;
    position: number;
    is_everyone: boolean;
    name: string;
    color: string | null;
  }>;
  permissions: bigint;
};
export async function guildAccess(
  user: string,
  guild: string,
  db: DB = pool,
): Promise<GuildMembership> {
  const m = (
    await db.query(
      'SELECT g.owner_id,m.timeout_until FROM guild_members m JOIN guilds g ON g.id=m.guild_id WHERE m.user_id=$1 AND m.guild_id=$2 AND g.deleted_at IS NULL',
      [user, guild],
    )
  ).rows[0];
  ensure(m, 403, 'Você não participa deste servidor.');
  const roles = (
    await db.query(
      'SELECT r.* FROM roles r WHERE r.guild_id=$1 AND (r.is_everyone OR EXISTS(SELECT 1 FROM guild_member_roles mr WHERE mr.role_id=r.id AND mr.user_id=$2))',
      [guild, user],
    )
  ).rows;
  let permissions: bigint = roles.reduce((p, r) => p | BigInt(r.permissions), 0n);
  if (m.owner_id === user || (permissions & P.ADMINISTRATOR) !== 0n) permissions = ALL;
  return { ...m, roles, permissions };
}
export async function channelAccess(user: string, id: string, needed = 0n, db: DB = pool) {
  const channel = (
    await db.query('SELECT * FROM channels WHERE id=$1 AND deleted_at IS NULL', [id])
  ).rows[0];
  ensure(channel, 404, 'Canal não encontrado.');
  if (!channel.guild_id) {
    const member = (
      await db.query(
        'SELECT 1 FROM channel_members WHERE channel_id=$1 AND user_id=$2 AND left_at IS NULL',
        [id, user],
      )
    ).rowCount;
    ensure(member, 403, 'Você não participa desta conversa.');
    ensure((BASIC & needed) === needed, 403, 'Sem permissão para esta ação na conversa.');
    const blocked =
      channel.type === 'dm' &&
      (
        await db.query(
          'SELECT 1 FROM user_blocks WHERE (blocker_id=$1 AND blocked_id IN($2,$3)) OR (blocked_id=$1 AND blocker_id IN($2,$3))',
          [user, channel.dm_user_low_id, channel.dm_user_high_id],
        )
      ).rowCount;
    ensure(!blocked || (needed & P.SEND_MESSAGES) === 0n, 403, 'Esta conversa está bloqueada.');
    return {
      channel,
      member: {
        roles: [],
        permissions: BASIC,
        owner_id: channel.group_owner_id,
        timeout_until: null,
      },
      permissions: BASIC,
    };
  }
  const member = await guildAccess(user, channel.guild_id, db);
  let permissions = member.permissions;
  if (permissions !== ALL) {
    // A synchronized forum can itself inherit a category. Follow the complete
    // chain so a thread cannot bypass the private category above its forum.
    let inherited = channel;
    for (let depth = 0; inherited.permissions_synced && inherited.parent_id && depth < 4; depth++) {
      const parent = (
        await db.query(
          'SELECT * FROM channels WHERE id=$1 AND guild_id=$2 AND deleted_at IS NULL',
          [inherited.parent_id, channel.guild_id],
        )
      ).rows[0];
      ensure(parent, 403, 'Categoria indisponível.');
      inherited = parent;
    }
    const source = inherited.id;
    const rules = (
      await db.query(
        'SELECT o.*,r.is_everyone FROM channel_role_overwrites o JOIN roles r ON r.id=o.role_id WHERE o.channel_id=$1',
        [source],
      )
    ).rows;
    const apply = (deny: bigint, allow: bigint) => {
      permissions = (permissions & ~deny) | allow;
    };
    for (const rule of rules.filter((r) => r.is_everyone))
      apply(BigInt(rule.deny), BigInt(rule.allow));
    const relevant = rules.filter(
      (r) => !r.is_everyone && member.roles.some((m: { id: string }) => m.id === r.role_id),
    );
    apply(
      relevant.reduce((p, r) => p | BigInt(r.deny), 0n),
      relevant.reduce((p, r) => p | BigInt(r.allow), 0n),
    );
    const own = (
      await db.query('SELECT * FROM channel_member_overwrites WHERE channel_id=$1 AND user_id=$2', [
        source,
        user,
      ])
    ).rows[0];
    if (own) apply(BigInt(own.deny), BigInt(own.allow));
  }
  ensure(
    (permissions & P.VIEW_CHANNEL) !== 0n && (permissions & needed) === needed,
    403,
    'Sem permissão para este canal.',
  );
  if ((needed & P.SEND_MESSAGES) !== 0n)
    ensure(
      !member.timeout_until || new Date(member.timeout_until).getTime() < Date.now(),
      403,
      'Você está temporariamente silenciado.',
    );
  return { channel, member, permissions };
}
