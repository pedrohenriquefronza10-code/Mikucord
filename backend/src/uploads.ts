import type { FastifyInstance } from 'fastify';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, statfs } from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { z } from 'zod';
import {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { s3 } from './media.js';
import { config } from './config.js';
import { pool, tx, ensure, HttpError, type DB } from './db.js';
import { channelAccess, P } from './permissions.js';
const uuid = (params: unknown) => z.object({ id: z.uuid() }).passthrough().parse(params).id;
export const safeFilename = (name: string) =>
  name.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 255) || 'arquivo';
export const inlineMime = (mime: string) =>
  /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm|quicktime)|audio\/(mpeg|ogg|wav|x-wav|flac|mp4|webm))$/.test(
    mime,
  );
export async function assetInfo(id: string, db: DB = pool) {
  return (
    await db.query(
      "SELECT a.id,a.original_filename AS filename,o.size_bytes,o.detected_mime AS mime,a.width,a.height FROM media_assets a JOIN storage_objects o ON o.id=a.storage_object_id WHERE a.id=$1 AND a.deleted_at IS NULL AND o.state='ready'",
      [id],
    )
  ).rows[0];
}
async function session(user: string, id: string, db: DB = pool, lock = false) {
  const row = (
    await db.query(
      `SELECT * FROM upload_sessions WHERE id=$1 AND uploader_id=$2 ${lock ? 'FOR UPDATE' : ''}`,
      [id, user],
    )
  ).rows[0];
  ensure(row && row.scope === 'channel', 404, 'Upload não encontrado.');
  await channelAccess(user, row.channel_id, P.SEND_MESSAGES | P.ATTACH_FILES, db);
  ensure(
    new Date(row.expires_at).getTime() > Date.now(),
    410,
    'Upload expirado. Selecione o arquivo novamente.',
  );
  return row;
}
export async function uploadRoutes(app: FastifyInstance) {
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) =>
    done(null, payload),
  );
  app.get('/api/me/uploads', async (req) => ({
    uploads: (
      await pool.query(
        "SELECT id,filename,state,expected_size_bytes,created_at FROM upload_sessions WHERE uploader_id=$1 AND scope='channel' AND state IN('uploading','verifying') ORDER BY created_at DESC LIMIT 100",
        [req.user.sub],
      )
    ).rows,
  }));
  app.post(
    '/api/channels/:id/uploads',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const channel = uuid(req.params),
        body = z
          .object({
            filename: z.string().min(1).max(255),
            size: z.string().regex(/^[1-9]\d*$/),
            clientNonce: z.uuid(),
          })
          .parse(req.body);
      // S3's 5 TiB object / 10,000 part protocol limits, not a subscription or application quota.
      const bytes = BigInt(body.size);
      ensure(bytes <= 5n * 1024n ** 4n, 400, 'O armazenamento S3 suporta objetos de até 5 TiB.');
      const partSize = Math.max(
        8 * 1024 ** 2,
        Math.ceil(Number(bytes) / 9999 / 1024 ** 2) * 1024 ** 2,
      );
      const result = await tx(async (db) => {
        await channelAccess(req.user.sub, channel, P.SEND_MESSAGES | P.ATTACH_FILES, db);
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `uploads:${req.user.sub}`,
        ]);
        const previous = (
          await db.query('SELECT * FROM upload_sessions WHERE uploader_id=$1 AND client_nonce=$2', [
            req.user.sub,
            body.clientNonce,
          ])
        ).rows[0];
        if (previous) {
          ensure(
            previous.channel_id === channel && previous.expected_size_bytes === body.size,
            409,
            'Identificador de upload já utilizado.',
          );
          return previous;
        }
        const active = (
          await db.query(
            "SELECT count(*)::int AS n FROM upload_sessions WHERE uploader_id=$1 AND scope='channel' AND state IN ('uploading','verifying') AND expires_at>now()",
            [req.user.sub],
          )
        ).rows[0].n;
        ensure(active < 5, 429, 'Há cinco uploads em andamento. Conclua ou cancele um deles.');
        const id = randomUUID(),
          key = `uploads/${id}`;
        const multipart = await s3.send(
          new CreateMultipartUploadCommand({
            Bucket: config.S3_BUCKET,
            Key: key,
            ContentType: 'application/octet-stream',
          }),
        );
        return (
          await db.query(
            "INSERT INTO upload_sessions(id,uploader_id,scope,channel_id,purpose,filename,expected_size_bytes,staging_object_key,multipart_upload_id,part_size_bytes,client_nonce,state,expires_at) VALUES($1,$2,'channel',$3,'attachment',$4,$5,$6,$7,$8,$9,'uploading',now()+interval '24 hours') RETURNING *",
            [
              id,
              req.user.sub,
              channel,
              safeFilename(body.filename),
              body.size,
              key,
              multipart.UploadId,
              partSize,
              body.clientNonce,
            ],
          )
        ).rows[0];
      });
      return reply.code(201).send({
        upload: { id: result.id, partSize: Number(result.part_size_bytes), state: result.state },
      });
    },
  );
  app.get('/api/uploads/:id', async (req) => {
    const row = await session(req.user.sub, uuid(req.params));
    const parts = (
      await pool.query(
        'SELECT part_number,size_bytes FROM upload_parts WHERE upload_id=$1 ORDER BY part_number',
        [row.id],
      )
    ).rows;
    return {
      upload: {
        id: row.id,
        state: row.state,
        parts,
        partSize: Number(row.part_size_bytes),
        asset: row.result_asset_id ? await assetInfo(row.result_asset_id) : null,
      },
    };
  });
  app.put(
    '/api/uploads/:id/parts/:part',
    { config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } },
    async (req) => {
      const id = uuid(req.params),
        part = z.coerce
          .number()
          .int()
          .min(1)
          .max(10000)
          .parse((req.params as { part: string }).part);
      const length = Number(req.headers['content-length']);
      ensure(
        Number.isSafeInteger(length) && length > 0,
        411,
        'Envie Content-Length para cada parte.',
      );
      return tx(async (db) => {
        const row = await session(req.user.sub, id, db, true);
        ensure(row.state === 'uploading', 409, 'Este upload não aceita novas partes.');
        const expected = Number(row.expected_size_bytes),
          partSize = Number(row.part_size_bytes),
          offset = (part - 1) * partSize;
        ensure(
          offset < expected && length === Math.min(partSize, expected - offset),
          400,
          'Tamanho ou número de parte inválido.',
        );
        const disk = await statfs(tmpdir(), { bigint: true });
        ensure(
          disk.bavail * disk.bsize > BigInt(length) + 16n * 1024n ** 2n,
          507,
          'Sem espaço temporário para esta parte.',
        );
        const dir = await mkdtemp(join(tmpdir(), 'tetocord-part-')),
          path = join(dir, 'part'),
          hash = createHash('sha256');
        let size = 0;
        try {
          await pipeline(
            req.body as Readable,
            new Transform({
              transform(chunk, _enc, cb) {
                size += chunk.length;
                if (size > length) {
                  cb(new HttpError(413, 'Parte maior que o tamanho declarado.'));
                  return;
                }
                hash.update(chunk);
                cb(null, chunk);
              },
            }),
            createWriteStream(path),
          );
          ensure(size === length, 400, 'Parte incompleta. Tente novamente.');
          const uploaded = await s3.send(
            new UploadPartCommand({
              Bucket: config.S3_BUCKET,
              Key: row.staging_object_key,
              UploadId: row.multipart_upload_id,
              PartNumber: part,
              Body: createReadStream(path),
              ContentLength: length,
            }),
          );
          await db.query(
            'INSERT INTO upload_parts(upload_id,part_number,etag,size_bytes,sha256) VALUES($1,$2,$3,$4,$5) ON CONFLICT(upload_id,part_number) DO UPDATE SET etag=EXCLUDED.etag,size_bytes=EXCLUDED.size_bytes,sha256=EXCLUDED.sha256',
            [id, part, uploaded.ETag, length, hash.digest('hex')],
          );
          await db.query(
            'UPDATE upload_sessions SET received_size_bytes=(SELECT COALESCE(sum(size_bytes),0) FROM upload_parts WHERE upload_id=$1) WHERE id=$1',
            [id],
          );
          return { ok: true, part };
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
    },
  );
  app.post('/api/uploads/:id/complete', async (req) => {
    const id = uuid(req.params);
    let duplicateKey: string | null = null;
    const result = await tx(async (db) => {
      const row = await session(req.user.sub, id, db, true);
      if (row.state === 'complete') return assetInfo(row.result_asset_id, db);
      ensure(['uploading', 'verifying'].includes(row.state), 409, 'Upload cancelado ou inválido.');
      const parts = (
        await db.query('SELECT * FROM upload_parts WHERE upload_id=$1 ORDER BY part_number', [id])
      ).rows;
      ensure(
        parts.length === Math.ceil(Number(row.expected_size_bytes) / Number(row.part_size_bytes)) &&
          parts.reduce((n, p) => n + BigInt(p.size_bytes), 0n) ===
            BigInt(row.expected_size_bytes) &&
          parts.every((p, i) => p.part_number === i + 1),
        400,
        'Existem partes pendentes. Retome o envio.',
      );
      await db.query("UPDATE upload_sessions SET state='verifying' WHERE id=$1", [id]);
      // Retry after a crash between S3 completion and the database commit is safe.
      try {
        await s3.send(
          new CompleteMultipartUploadCommand({
            Bucket: config.S3_BUCKET,
            Key: row.staging_object_key,
            UploadId: row.multipart_upload_id,
            MultipartUpload: {
              Parts: parts.map((p) => ({ PartNumber: p.part_number, ETag: p.etag })),
            },
          }),
        );
      } catch (e) {
        if ((e as Error).name !== 'NoSuchUpload') throw e;
        await s3.send(
          new HeadObjectCommand({ Bucket: config.S3_BUCKET, Key: row.staging_object_key }),
        );
      }
      const object = await s3.send(
        new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: row.staging_object_key }),
      );
      const hash = createHash('sha256');
      let size = 0;
      const prefix: Buffer[] = [];
      let prefixSize = 0;
      for await (const chunk of object.Body as Readable) {
        const b = Buffer.from(chunk);
        hash.update(b);
        size += b.length;
        if (prefixSize < 8192) {
          const slice = b.subarray(0, 8192 - prefixSize);
          prefix.push(slice);
          prefixSize += slice.length;
        }
      }
      ensure(BigInt(size) === BigInt(row.expected_size_bytes), 400, 'Arquivo final incompleto.');
      const sha = hash.digest('hex'),
        detected = await fileTypeFromBuffer(Buffer.concat(prefix)),
        mime = detected?.mime ?? 'application/octet-stream';
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`blob:${sha}`]);
      const blob = (
        await db.query(
          "INSERT INTO storage_objects(sha256,bucket,object_key,size_bytes,detected_mime,state,verified_at) VALUES($1,$2,$3,$4,$5,'ready',now()) ON CONFLICT(sha256) DO UPDATE SET sha256=EXCLUDED.sha256 RETURNING *",
          [sha, config.S3_BUCKET, row.staging_object_key, size, mime],
        )
      ).rows[0];
      if (blob.object_key !== row.staging_object_key) duplicateKey = row.staging_object_key;
      const asset = (
        await db.query(
          "INSERT INTO media_assets(storage_object_id,owner_id,scope,channel_id,purpose,original_filename,declared_mime) VALUES($1,$2,'channel',$3,'attachment',$4,$5) RETURNING id",
          [blob.id, req.user.sub, row.channel_id, row.filename, mime],
        )
      ).rows[0];
      await db.query(
        "UPDATE upload_sessions SET state='complete',result_asset_id=$2,received_size_bytes=$3,completed_at=now() WHERE id=$1",
        [id, asset.id, size],
      );
      return assetInfo(asset.id, db);
    });
    if (duplicateKey)
      await s3
        .send(new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key: duplicateKey }))
        .catch(() => {});
    return { asset: result };
  });
  app.delete('/api/uploads/:id', async (req) => {
    await tx(async (db) => {
      const row = (
        await db.query(
          "SELECT * FROM upload_sessions WHERE id=$1 AND uploader_id=$2 AND scope='channel' FOR UPDATE",
          [uuid(req.params), req.user.sub],
        )
      ).rows[0];
      ensure(row, 404, 'Upload não encontrado.');
      if (['aborted', 'complete'].includes(row.state)) return;
      await s3
        .send(
          new AbortMultipartUploadCommand({
            Bucket: config.S3_BUCKET,
            Key: row.staging_object_key,
            UploadId: row.multipart_upload_id,
          }),
        )
        .catch((e) => {
          if ((e as Error).name !== 'NoSuchUpload') throw e;
        });
      await db.query("UPDATE upload_sessions SET state='aborted' WHERE id=$1", [row.id]);
    });
    return { ok: true };
  });
  app.get('/api/attachments/:id/:action', async (req, reply) => {
    const id = uuid(req.params),
      action = z.enum(['content', 'download']).parse((req.params as { action: string }).action);
    const attachment = (
      await pool.query(
        `SELECT a.original_filename,a.channel_id,o.* FROM message_attachments ma JOIN messages m ON m.id=ma.message_id JOIN media_assets a ON a.id=ma.asset_id JOIN storage_objects o ON o.id=a.storage_object_id WHERE ma.id=$1 AND m.deleted_at IS NULL AND a.deleted_at IS NULL AND o.state='ready'`,
        [id],
      )
    ).rows[0];
    ensure(attachment, 404, 'Arquivo não encontrado.');
    await channelAccess(req.user.sub, attachment.channel_id, P.READ_MESSAGE_HISTORY);
    const range = req.headers.range,
      size = BigInt(attachment.size_bytes);
    let normalized: string | undefined;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2]))
        return reply.code(416).header('Content-Range', `bytes */${size}`).send();
      let start = match[1] ? BigInt(match[1]) : size - BigInt(match[2]);
      if (start < 0n) start = 0n;
      let end = match[1] ? (match[2] ? BigInt(match[2]) : size - 1n) : size - 1n;
      if (end >= size) end = size - 1n;
      if (start >= size || end < start)
        return reply.code(416).header('Content-Range', `bytes */${size}`).send();
      normalized = `bytes=${start}-${end}`;
    }
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: attachment.bucket,
        Key: attachment.object_key,
        Range: normalized,
      }),
    );
    const disposition =
      action === 'content' && inlineMime(attachment.detected_mime) ? 'inline' : 'attachment';
    reply
      .code(normalized ? 206 : 200)
      .header(
        'Content-Type',
        inlineMime(attachment.detected_mime)
          ? attachment.detected_mime
          : 'application/octet-stream',
      )
      .header('Accept-Ranges', 'bytes')
      .header('Content-Length', String(result.ContentLength))
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header(
        'Content-Disposition',
        `${disposition}; filename="download"; filename*=UTF-8''${encodeURIComponent(safeFilename(attachment.original_filename))}`,
      );
    if (result.ContentRange) reply.header('Content-Range', result.ContentRange);
    if (req.method === 'HEAD') {
      (result.Body as Readable).destroy();
      return reply.send();
    }
    return reply.send(result.Body);
  });
}
