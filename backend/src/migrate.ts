import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { pool } from './db.js';
export async function migrate() {
  const db = await pool.connect();
  try {
    await db.query('SELECT pg_advisory_lock(734118901)');
    await db.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const dir = new URL('../migrations/', import.meta.url);
    for (const name of (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort()) {
      const sql = await readFile(new URL(name, dir), 'utf8'),
        checksum = createHash('sha256').update(sql).digest('hex');
      const previous = (
        await db.query('SELECT checksum FROM schema_migrations WHERE name=$1', [name])
      ).rows[0];
      if (previous) {
        if (previous.checksum !== checksum) throw new Error(`Migração alterada: ${name}`);
        continue;
      }
      await db.query('BEGIN');
      try {
        await db.query(sql);
        await db.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [
          name,
          checksum,
        ]);
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
      console.log(`Migração aplicada: ${name}`);
    }
  } finally {
    await db.query('SELECT pg_advisory_unlock(734118901)');
    db.release();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await migrate();
  } finally {
    await pool.end();
  }
}
