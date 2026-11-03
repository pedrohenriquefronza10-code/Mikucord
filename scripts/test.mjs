import { config } from 'dotenv';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
config({ quiet: true });
const suffix = randomBytes(6).toString('hex'),
  dbName = `tetocord_test_${suffix}`,
  admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = new URL(process.env.DATABASE_URL),
  redis = new URL(process.env.REDIS_URL);
db.pathname = `/${dbName}`;
redis.pathname = '/15';
try {
  await admin.query(`CREATE DATABASE ${dbName}`);
  const child = spawn('npm', ['run', 'test', '-w', 'backend'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL: db.href,
      REDIS_URL: redis.href,
      NODE_ENV: 'test',
      RATE_LIMIT_NAMESPACE: `tetocord-test-${suffix}:`,
      S3_BUCKET: `tetocord-test-${suffix}`,
    },
  });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  process.exitCode = code ?? 1;
} finally {
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
}
