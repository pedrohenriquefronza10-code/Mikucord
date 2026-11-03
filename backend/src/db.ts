import pg from 'pg';
import { config } from './config.js';
export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 12 });
export type DB = Pick<pg.PoolClient, 'query'>;
export async function tx<T>(fn: (db: DB) => Promise<T>) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const result = await fn(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export function ensure(ok: unknown, status: number, message: string): asserts ok {
  if (!ok) throw new HttpError(status, message);
}
export async function event(db: DB, type: string, id: string, payload: object, version?: string) {
  await db.query(
    'INSERT INTO outbox_events(aggregate_type,aggregate_id,aggregate_version,event_type,payload) VALUES($1,$2,$3,$4,$5)',
    [type.split('.')[0], id, version ?? null, type, JSON.stringify(payload)],
  );
}
export async function audit(db: DB, guild: string, actor: string, action: string, target: string) {
  await db.query(
    'INSERT INTO audit_logs(guild_id,actor_id,action,target_type,target_id) VALUES($1,$2,$3,$4,$5)',
    [guild, actor, action, action.split('.')[0], target],
  );
}
