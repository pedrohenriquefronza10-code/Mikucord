import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import type { FastifyInstance } from 'fastify';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileTypeFromFile } from 'file-type';
import sharp, { type Metadata } from 'sharp';
import { config } from './config.js';
import { pool, tx, ensure, event } from './db.js';
import { getUser } from './auth.js';
import { channelAccess, guildAccess, P } from './permissions.js';
export const s3 = new S3Client({
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION,
  forcePathStyle: true,
  credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
  maxAttempts: 3,
  requestHandler: { connectionTimeout: 2000, requestTimeout: 15000 },
});
export async function initStorage() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET }));
  } catch (error) {
    if ((error as { $metadata?: { httpStatusCode: number } }).$metadata?.httpStatusCode !== 404)
      throw error;
    try {
      await s3.send(new CreateBucketCommand({ Bucket: config.S3_BUCKET }));
    } catch (e) {
      if ((e as Error).name !== 'BucketAlreadyOwnedByYou') throw e;
    }
  }
}
export async function mediaRoutes(app: FastifyInstance) {
  app.post(
    '/api/me/media/:purpose',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const { purpose } = req.params as { purpose: string };
      ensure(['avatar', 'banner'].includes(purpose), 400, 'Tipo de imagem inválido.');
      const file = await req.file();
      ensure(file, 400, 'Selecione uma imagem.');
      const dir = await mkdtemp(join(tmpdir(), 'tetocord-')),
        path = join(dir, 'upload'),
        hash = createHash('sha256');
      let size = 0;
      const id = randomUUID();
      await pool.query(
        "INSERT INTO upload_sessions(id,uploader_id,purpose,filename,declared_mime,staging_object_key,state,expires_at) VALUES($1,$2,$3,$4,$5,$6,'uploading',now()+interval '1 hour')",
        [id, req.user.sub, purpose, file.filename.slice(0, 255), file.mimetype, `staging/${id}`],
      );
      try {
        await pipeline(
          file.file,
          new Transform({
            transform(chunk, _encoding, cb) {
              size += chunk.length;
              hash.update(chunk);
              cb(null, chunk);
            },
          }),
          createWriteStream(path),
        );
        ensure(!file.file.truncated, 413, 'Imagem de perfil deve ter até 20 MB.');
        const type = await fileTypeFromFile(path);
        ensure(
          type && ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(type.mime),
          415,
          'Use PNG, JPEG, GIF ou WebP.',
        );
        let metadata: Metadata;
        try {
          metadata = await sharp(path, { animated: true, limitInputPixels: 40_000_000 }).metadata();
        } catch {
          throw Object.assign(new Error('Imagem inválida ou grande demais para processar.'), {
            statusCode: 415,
          });
        }
        ensure(metadata.width && metadata.height, 415, 'Imagem inválida.');
        const sha = hash.digest('hex'),
          key = `profiles/${sha}`;
        await pool.query(
          "UPDATE upload_sessions SET state='verifying',received_size_bytes=$2 WHERE id=$1",
          [id, size],
        );
        await tx(async (db) => {
          await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [sha]);
          const existing = (
            await db.query("SELECT id FROM storage_objects WHERE sha256=$1 AND state='ready'", [
              sha,
            ])
          ).rows[0];
          if (!existing)
            await s3.send(
              new PutObjectCommand({
                Bucket: config.S3_BUCKET,
                Key: key,
                Body: await readFile(path),
                ContentLength: size,
                ContentType: type.mime,
              }),
            );
          const blob = (
            await db.query(
              "INSERT INTO storage_objects(sha256,bucket,object_key,size_bytes,detected_mime,state,verified_at) VALUES($1,$2,$3,$4,$5,'ready',now()) ON CONFLICT(sha256) DO UPDATE SET sha256=EXCLUDED.sha256 RETURNING id",
              [sha, config.S3_BUCKET, key, size, type.mime],
            )
          ).rows[0];
          const asset = (
            await db.query(
              "INSERT INTO media_assets(storage_object_id,owner_id,scope,purpose,original_filename,declared_mime,width,height) VALUES($1,$2,'profile',$3,$4,$5,$6,$7) RETURNING id",
              [
                blob.id,
                req.user.sub,
                purpose,
                file.filename.slice(0, 255),
                type.mime,
                metadata.width,
                metadata.height,
              ],
            )
          ).rows[0];
          const col = purpose === 'avatar' ? 'avatar_asset_id' : 'banner_asset_id';
          await db.query(
            `UPDATE media_assets SET deleted_at=now() WHERE id=(SELECT ${col} FROM users WHERE id=$1)`,
            [req.user.sub],
          );
          await db.query(`UPDATE users SET ${col}=$2,updated_at=now() WHERE id=$1`, [
            req.user.sub,
            asset.id,
          ]);
          await db.query(
            "UPDATE upload_sessions SET state='complete',result_asset_id=$2,completed_at=now() WHERE id=$1",
            [id, asset.id],
          );
          await event(db, 'profile.updated', req.user.sub, { userId: req.user.sub });
        });
        return { user: await getUser(req.user.sub) };
      } catch (error) {
        await pool.query("UPDATE upload_sessions SET state='failed' WHERE id=$1", [id]);
        throw error;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
  app.get('/api/media/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    ensure(/^[0-9a-f-]{36}$/i.test(id), 404, 'Imagem não encontrada.');
    const asset = (
      await pool.query(
        `SELECT a.owner_id,a.scope,a.purpose,a.guild_id,a.channel_id,o.* FROM media_assets a JOIN storage_objects o ON o.id=a.storage_object_id WHERE a.id=$1 AND a.deleted_at IS NULL AND o.state='ready'`,
        [id],
      )
    ).rows[0];
    ensure(asset, 404, 'Mídia não encontrada.');
    ensure(asset.purpose !== 'attachment', 404, 'Use o download do anexo da mensagem.');
    if (asset.scope === 'guild') await guildAccess(req.user.sub, asset.guild_id);
    else if (asset.scope === 'channel')
      await channelAccess(req.user.sub, asset.channel_id, P.READ_MESSAGE_HISTORY);
    else if (asset.owner_id !== req.user.sub)
      ensure(
        (
          await pool.query(
            'SELECT 1 WHERE EXISTS(SELECT 1 FROM guild_members a JOIN guild_members b ON a.guild_id=b.guild_id JOIN guilds g ON g.id=a.guild_id WHERE a.user_id=$1 AND b.user_id=$2 AND g.deleted_at IS NULL) OR EXISTS(SELECT 1 FROM friendships WHERE user_low_id=least($1::uuid,$2::uuid) AND user_high_id=greatest($1::uuid,$2::uuid)) OR EXISTS(SELECT 1 FROM channel_members a JOIN channel_members b ON a.channel_id=b.channel_id WHERE a.user_id=$1 AND b.user_id=$2 AND a.left_at IS NULL AND b.left_at IS NULL)',
            [asset.owner_id, req.user.sub],
          )
        ).rowCount,
        404,
        'Mídia não encontrada.',
      );
    const result = await s3.send(
      new GetObjectCommand({ Bucket: asset.bucket, Key: asset.object_key }),
    );
    return reply
      .header('Content-Type', asset.detected_mime)
      .header('Cache-Control', 'private, max-age=60')
      .header('X-Content-Type-Options', 'nosniff')
      .send(result.Body);
  });
}
