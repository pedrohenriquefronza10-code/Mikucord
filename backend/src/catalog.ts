import type { FastifyInstance } from 'fastify';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { parseBuffer } from 'music-metadata';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { fetch as remoteFetch, EnvHttpProxyAgent } from 'undici';
import { s3 } from './media.js';
import { config } from './config.js';
import { pool, tx, ensure, event, audit, type DB } from './db.js';
import { manageGuild } from './customization.js';
import { channelAccess, guildAccess, P } from './permissions.js';
import { assetInfo, safeFilename } from './uploads.js';
import { getUser } from './auth.js';
const id = (p: unknown, k = 'id') => z.uuid().parse((p as Record<string, string>)[k]);
const tableNames = {
  emoji: 'custom_emojis',
  sticker: 'custom_stickers',
  sound: 'custom_sound_effects',
} as const;
type Kind = keyof typeof tableNames;
export async function storeBytes(db: DB, bytes: Buffer, mime: string) {
  const sha = createHash('sha256').update(bytes).digest('hex');
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`blob:${sha}`]);
  let row = (await db.query('SELECT * FROM storage_objects WHERE sha256=$1', [sha])).rows[0];
  if (!row) {
    const key = `media/${sha}`;
    await s3.send(
      new PutObjectCommand({
        Bucket: config.S3_BUCKET,
        Key: key,
        Body: bytes,
        ContentType: mime,
        ContentLength: bytes.length,
      }),
    );
    row = (
      await db.query(
        "INSERT INTO storage_objects(sha256,bucket,object_key,size_bytes,detected_mime,state,verified_at) VALUES($1,$2,$3,$4,$5,'ready',now()) RETURNING *",
        [sha, config.S3_BUCKET, key, bytes.length, mime],
      )
    ).rows[0];
  }
  return row;
}
async function validateMedia(bytes: Buffer, kind: string) {
  const detected = await fileTypeFromBuffer(bytes);
  ensure(detected, 415, 'Formato de mídia não reconhecido.');
  let width: number | undefined,
    height: number | undefined,
    duration: number | undefined,
    animated = false;
  if (kind === 'sound' || kind === 'notification_sound') {
    ensure(
      detected.mime.startsWith('audio/') ||
        detected.mime === 'video/mp4' ||
        detected.mime === 'video/webm',
      415,
      'Envie um arquivo de áudio.',
    );
    const metadata = await parseBuffer(bytes, { mimeType: detected.mime }, { duration: true });
    duration = Math.round((metadata.format.duration ?? 0) * 1000);
    ensure(
      duration > 0 && duration <= (kind === 'sound' ? 10000 : 30000),
      400,
      kind === 'sound'
        ? 'Efeitos devem ter até 10 segundos.'
        : 'Sons de notificação devem ter até 30 segundos.',
    );
  } else {
    ensure(
      ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(detected.mime),
      415,
      'Use PNG, JPEG, GIF ou WebP.',
    );
    const m = await sharp(bytes, { animated: true, limitInputPixels: 40_000_000 }).metadata();
    width = m.width;
    height = m.height;
    animated = (m.pages ?? 1) > 1;
    ensure(width && height, 415, 'Imagem inválida.');
  }
  return {
    mime: detected.mime,
    width: width ?? null,
    height: height ?? null,
    duration: duration ?? null,
    animated,
  };
}
export async function catalogRoutes(app: FastifyInstance) {
  app.post('/api/guilds/:id/roles/:role/icon', async (req) => {
    const guild = id(req.params),
      role = id(req.params, 'role'),
      a = await manageGuild(req.user.sub, guild, P.MANAGE_ROLES),
      r = (await pool.query('SELECT * FROM roles WHERE id=$1 AND guild_id=$2', [role, guild]))
        .rows[0];
    ensure(r, 404, 'Cargo não encontrado.');
    ensure(
      a.owner_id === req.user.sub || r.position < Math.max(...a.roles.map((r) => r.position), 0),
      403,
      'Este cargo está acima da sua hierarquia.',
    );
    const file = await req.file();
    ensure(file, 400, 'Selecione uma imagem.');
    const bytes = await file.toBuffer(),
      media = await validateMedia(bytes, 'role_icon');
    await tx(async (db) => {
      await manageGuild(req.user.sub, guild, P.MANAGE_ROLES, db);
      const blob = await storeBytes(db, bytes, media.mime),
        asset = (
          await db.query(
            "INSERT INTO media_assets(storage_object_id,owner_id,scope,guild_id,purpose,original_filename,width,height) VALUES($1,$2,'guild',$3,'role_icon',$4,$5,$6) RETURNING id",
            [blob.id, req.user.sub, guild, safeFilename(file.filename), media.width, media.height],
          )
        ).rows[0];
      await db.query('UPDATE roles SET icon_asset_id=$2,updated_at=now() WHERE id=$1', [
        role,
        asset.id,
      ]);
      await event(db, 'guild.changed', guild, { guildId: guild });
    });
    return { ok: true };
  });
  app.get('/api/guilds/:id/catalog', async (req) => {
    const guild = id(req.params);
    await guildAccess(req.user.sub, guild);
    const result: Record<string, unknown> = {};
    for (const [kind, table] of Object.entries(tableNames))
      result[kind] = (
        await pool.query(
          `SELECT * FROM ${table} WHERE guild_id=$1 AND deleted_at IS NULL ORDER BY lower(name),id`,
          [guild],
        )
      ).rows;
    return result;
  });
  app.post(
    '/api/guilds/:id/catalog/:kind',
    { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const guild = id(req.params),
        kind = z.enum(['emoji', 'sticker', 'sound']).parse((req.params as { kind: string }).kind),
        body = z
          .object({
            name: z
              .string()
              .trim()
              .min(kind === 'emoji' ? 2 : 1)
              .max(kind === 'emoji' ? 32 : 64),
            category: z.string().max(64).default('Geral'),
            shortcut: z.string().max(64).optional(),
            tags: z.string().max(500).default(''),
          })
          .parse(req.query);
      if (kind === 'emoji')
        ensure(
          /^[A-Za-z0-9_]+$/.test(body.name),
          400,
          'Nome de emoji: letras, números e sublinhado.',
        );
      await manageGuild(req.user.sub, guild, P.MANAGE_EXPRESSIONS);
      const file = await req.file();
      ensure(file, 400, 'Selecione um arquivo.');
      const bytes = await file.toBuffer(),
        media = await validateMedia(bytes, kind);
      const item = await tx(async (db) => {
        await manageGuild(req.user.sub, guild, P.MANAGE_EXPRESSIONS, db);
        const blob = await storeBytes(db, bytes, media.mime),
          asset = (
            await db.query(
              "INSERT INTO media_assets(storage_object_id,owner_id,scope,guild_id,purpose,original_filename,declared_mime,width,height,duration_ms) VALUES($1,$2,'guild',$3,$4,$5,$6,$7,$8,$9) RETURNING id",
              [
                blob.id,
                req.user.sub,
                guild,
                kind,
                safeFilename(file.filename),
                media.mime,
                media.width,
                media.height,
                media.duration,
              ],
            )
          ).rows[0];
        let row;
        if (kind === 'emoji')
          row = (
            await db.query(
              'INSERT INTO custom_emojis(guild_id,name,asset_id,created_by,animated) VALUES($1,$2,$3,$4,$5) RETURNING *',
              [guild, body.name, asset.id, req.user.sub, media.animated],
            )
          ).rows[0];
        else if (kind === 'sticker')
          row = (
            await db.query(
              'INSERT INTO custom_stickers(guild_id,name,asset_id,created_by,tags) VALUES($1,$2,$3,$4,$5) RETURNING *',
              [
                guild,
                body.name,
                asset.id,
                req.user.sub,
                body.tags
                  .split(',')
                  .map((t) => t.trim())
                  .filter(Boolean),
              ],
            )
          ).rows[0];
        else
          row = (
            await db.query(
              'INSERT INTO custom_sound_effects(guild_id,name,asset_id,created_by,category,default_shortcut,duration_ms) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
              [
                guild,
                body.name,
                asset.id,
                req.user.sub,
                body.category,
                body.shortcut ?? null,
                media.duration,
              ],
            )
          ).rows[0];
        await audit(db, guild, req.user.sub, `${kind}.create`, row.id);
        await event(db, 'guild.changed', guild, { guildId: guild });
        return row;
      });
      return reply.code(201).send({ item });
    },
  );
  app.patch('/api/guilds/:id/catalog/:kind/:item', async (req) => {
    const guild = id(req.params),
      item = id(req.params, 'item'),
      kind = z.enum(['emoji', 'sticker', 'sound']).parse((req.params as { kind: string }).kind),
      body = z
        .object({
          name: z
            .string()
            .trim()
            .min(1)
            .max(kind === 'emoji' ? 32 : 64)
            .optional(),
          category: z.string().max(64).optional(),
          default_shortcut: z.string().max(64).nullable().optional(),
          tags: z.array(z.string().max(32)).max(20).optional(),
        })
        .strict()
        .parse(req.body);
    if (kind === 'emoji' && body.name)
      ensure(/^[A-Za-z0-9_]{2,32}$/.test(body.name), 400, 'Nome de emoji inválido.');
    await tx(async (db) => {
      await manageGuild(req.user.sub, guild, P.MANAGE_EXPRESSIONS, db);
      for (const [key, value] of Object.entries(body)) {
        ensure(
          key === 'name' ||
            (kind === 'sound' && ['category', 'default_shortcut'].includes(key)) ||
            (kind === 'sticker' && key === 'tags'),
          400,
          'Campo inválido para esse item.',
        );
        await db.query(
          `UPDATE ${tableNames[kind]} SET ${key}=$3,updated_at=now() WHERE id=$1 AND guild_id=$2 AND deleted_at IS NULL`,
          [item, guild, value],
        );
      }
      await audit(db, guild, req.user.sub, `${kind}.update`, item);
      await event(db, 'guild.changed', guild, { guildId: guild });
    });
    return { ok: true };
  });
  app.delete('/api/guilds/:id/catalog/:kind/:item', async (req) => {
    const guild = id(req.params),
      item = id(req.params, 'item'),
      kind = z.enum(['emoji', 'sticker', 'sound']).parse((req.params as { kind: string }).kind);
    await tx(async (db) => {
      await manageGuild(req.user.sub, guild, P.MANAGE_EXPRESSIONS, db);
      await db.query(
        `UPDATE ${tableNames[kind]} SET deleted_at=now() WHERE guild_id=$1 AND id=$2`,
        [guild, item],
      );
      await audit(db, guild, req.user.sub, `${kind}.delete`, item);
      await event(db, 'guild.changed', guild, { guildId: guild });
    });
    return { ok: true };
  });
  app.post('/api/guilds/:id/media/:purpose', async (req) => {
    const guild = id(req.params),
      purpose = z
        .enum(['guild_icon', 'guild_banner'])
        .parse((req.params as { purpose: string }).purpose);
    await manageGuild(req.user.sub, guild, P.MANAGE_GUILD);
    const file = await req.file();
    ensure(file, 400, 'Selecione uma imagem.');
    const bytes = await file.toBuffer(),
      media = await validateMedia(bytes, purpose);
    await tx(async (db) => {
      await manageGuild(req.user.sub, guild, P.MANAGE_GUILD, db);
      const blob = await storeBytes(db, bytes, media.mime),
        asset = (
          await db.query(
            "INSERT INTO media_assets(storage_object_id,owner_id,scope,guild_id,purpose,original_filename,width,height) VALUES($1,$2,'guild',$3,$4,$5,$6,$7) RETURNING id",
            [
              blob.id,
              req.user.sub,
              guild,
              purpose,
              safeFilename(file.filename),
              media.width,
              media.height,
            ],
          )
        ).rows[0];
      await db.query(
        `UPDATE guilds SET ${purpose === 'guild_icon' ? 'icon_asset_id' : 'banner_asset_id'}=$2,updated_at=now() WHERE id=$1`,
        [guild, asset.id],
      );
      await event(db, 'guild.changed', guild, { guildId: guild });
    });
    return { ok: true };
  });
  app.post('/api/me/sounds/:sound', async (req) => {
    const sound = z
        .enum(['message', 'call_join', 'call_leave'])
        .parse((req.params as { sound: string }).sound),
      file = await req.file();
    ensure(file, 400, 'Selecione um áudio.');
    const bytes = await file.toBuffer(),
      media = await validateMedia(bytes, 'notification_sound');
    await tx(async (db) => {
      const blob = await storeBytes(db, bytes, media.mime),
        asset = (
          await db.query(
            "INSERT INTO media_assets(storage_object_id,owner_id,scope,purpose,original_filename,duration_ms) VALUES($1,$2,'profile','notification_sound',$3,$4) RETURNING id",
            [blob.id, req.user.sub, safeFilename(file.filename), media.duration],
          )
        ).rows[0];
      await db.query(
        'INSERT INTO user_notification_sounds(user_id,event,asset_id) VALUES($1,$2,$3) ON CONFLICT(user_id,event) DO UPDATE SET asset_id=EXCLUDED.asset_id',
        [req.user.sub, sound, asset.id],
      );
    });
    return { ok: true };
  });
  app.put('/api/me/soundboard/:id', async (req) => {
    const sound = id(req.params),
      body = z.object({ shortcut: z.string().min(1).max(64) }).parse(req.body),
      row = (
        await pool.query(
          'SELECT guild_id FROM custom_sound_effects WHERE id=$1 AND deleted_at IS NULL',
          [sound],
        )
      ).rows[0];
    ensure(row, 404, 'Som não encontrado.');
    await guildAccess(req.user.sub, row.guild_id);
    await pool.query(
      'INSERT INTO user_soundboard_shortcuts(user_id,sound_effect_id,shortcut) VALUES($1,$2,$3) ON CONFLICT(user_id,sound_effect_id) DO UPDATE SET shortcut=EXCLUDED.shortcut',
      [req.user.sub, sound, body.shortcut],
    );
    return { ok: true };
  });
  app.get('/api/me/soundboard', async (req) => ({
    shortcuts: (
      await pool.query('SELECT * FROM user_soundboard_shortcuts WHERE user_id=$1', [req.user.sub])
    ).rows,
  }));
  const dispatcher = new EnvHttpProxyAgent();
  app.addHook('onClose', async () => {
    await dispatcher.close();
  });
  async function tenor(path: string) {
    ensure(
      config.GIF_API_KEY,
      503,
      'A busca de GIFs ainda não foi configurada pelo administrador.',
    );
    const url = new URL(`https://tenor.googleapis.com/v2/${path}`);
    url.searchParams.set('key', config.GIF_API_KEY);
    url.searchParams.set('client_key', 'tetocord');
    url.searchParams.set('media_filter', 'gif,tinygif');
    url.searchParams.set('limit', '24');
    const response = await remoteFetch(url, { dispatcher, signal: AbortSignal.timeout(10000) });
    ensure(response.ok, 502, 'O provedor de GIFs está indisponível.');
    return (await response.json()) as {
      results: Array<{
        id: string;
        content_description: string;
        media_formats: Record<string, { url: string }>;
      }>;
    };
  }
  app.get('/api/gifs', async (req) => {
    const { q } = z.object({ q: z.string().max(100).default('') }).parse(req.query);
    const result = await tenor(q ? `search?q=${encodeURIComponent(q)}` : 'featured');
    return {
      gifs: result.results.map((g) => ({
        id: g.id,
        name: g.content_description,
        preview: g.media_formats.tinygif?.url ?? g.media_formats.gif?.url,
      })),
    };
  });
  app.post('/api/channels/:id/gifs', async (req) => {
    const channel = id(req.params),
      { gifId } = z.object({ gifId: z.string().regex(/^\d+$/).max(40) }).parse(req.body);
    await channelAccess(req.user.sub, channel, P.SEND_MESSAGES | P.ATTACH_FILES);
    const result = await tenor(`posts?ids=${gifId}`),
      gif = result.results.find((g) => g.id === gifId);
    ensure(gif?.media_formats.gif, 404, 'GIF não encontrado.');
    const url = new URL(gif.media_formats.gif.url);
    ensure(
      url.protocol === 'https:' && url.hostname === 'media.tenor.com',
      400,
      'Origem de GIF inválida.',
    );
    const response = await remoteFetch(url, {
      dispatcher,
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    ensure(response.ok, 502, 'Não foi possível importar esse GIF.');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const part of response.body!) {
      const chunk = Buffer.from(part);
      size += chunk.length;
      ensure(size <= 20 * 1024 ** 2, 413, 'Este GIF é grande demais para o catálogo.');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks),
      media = await validateMedia(bytes, 'emoji');
    const asset = await tx(async (db) => {
      await channelAccess(req.user.sub, channel, P.SEND_MESSAGES | P.ATTACH_FILES, db);
      const blob = await storeBytes(db, bytes, media.mime),
        a = (
          await db.query(
            "INSERT INTO media_assets(storage_object_id,owner_id,scope,channel_id,purpose,original_filename,width,height) VALUES($1,$2,'channel',$3,'attachment',$4,$5,$6) RETURNING id",
            [blob.id, req.user.sub, channel, `tenor-${gifId}.gif`, media.width, media.height],
          )
        ).rows[0];
      return assetInfo(a.id, db);
    });
    return { asset };
  });
}
