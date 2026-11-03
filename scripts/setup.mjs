import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { parse } from 'dotenv';
import webpush from 'web-push';
if (existsSync('.env')) {
  console.log('.env existente preservado.');
  extend();
  process.exit(0);
}
const db = randomBytes(24).toString('hex'),
  s3 = randomBytes(24).toString('hex');
writeFileSync(
  '.env',
  `NODE_ENV=development\nPORT=3000\nAPP_ORIGIN=http://localhost:5173\nAPP_DOMAIN=localhost\nACME_EMAIL=\nPOSTGRES_USER=tetocord\nPOSTGRES_DB=tetocord\nPOSTGRES_PASSWORD=${db}\nDATABASE_URL=postgresql://tetocord:${db}@127.0.0.1:5432/tetocord\nREDIS_URL=redis://127.0.0.1:6379\nJWT_SECRET=${randomBytes(48).toString('hex')}\nS3_ENDPOINT=http://127.0.0.1:9000\nS3_REGION=us-east-1\nS3_BUCKET=tetocord\nS3_ACCESS_KEY=tetocord\nS3_SECRET_KEY=${s3}\n`,
  { mode: 0o600, flag: 'wx' },
);
console.log('.env criado com segredos aleatórios. Nunca versione esse arquivo.');

function extend() {
  const current = parse(readFileSync('.env')),
    vapid = webpush.generateVAPIDKeys();
  const additions = {
    ...(process.env.CODEX_PROXY_CERT
      ? { BUILD_CA_FILE: '/etc/ssl/certs/ca-certificates.crt' }
      : {}),
    LIVEKIT_URL: 'ws://localhost:7880',
    LIVEKIT_INTERNAL_URL: 'http://127.0.0.1:7880',
    LIVEKIT_API_KEY: randomBytes(12).toString('hex'),
    LIVEKIT_API_SECRET: randomBytes(32).toString('hex'),
    MEDIA_PUBLIC_IP: '127.0.0.1',
    TURN_HOST: 'localhost',
    TURN_PORT: '3478',
    TURN_TLS_PORT: '0',
    TURN_REALM: 'tetocord',
    TURN_SHARED_SECRET: randomBytes(32).toString('hex'),
    GIF_API_KEY: '',
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_SUBJECT: 'mailto:admin@example.invalid',
  };
  const lines = Object.entries(additions)
    .filter(([key]) => !(key in current))
    .map(([key, value]) => `${key}=${value}`);
  if (lines.length) appendFileSync('.env', '\n' + lines.join('\n') + '\n', { mode: 0o600 });
  console.log('Configurações de mídia/push adicionadas; valores existentes preservados.');
}
extend();
