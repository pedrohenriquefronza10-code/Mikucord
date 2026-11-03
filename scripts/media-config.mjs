import { config } from 'dotenv';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
config({ quiet: true });
const e = { ...process.env };
if (e.MEDIA_PUBLIC_IP === '127.0.0.1' && e.NODE_ENV !== 'production') {
  const local = Object.values(networkInterfaces())
    .flat()
    .find((a) => a?.family === 'IPv4' && !a.internal);
  if (local) e.MEDIA_PUBLIC_IP = local.address;
}
if (e.NODE_ENV === 'production' && (!e.MEDIA_PUBLIC_IP || e.MEDIA_PUBLIC_IP === '127.0.0.1'))
  throw new Error('Configure MEDIA_PUBLIC_IP com o IPv4 público do SFU/TURN.');
for (const key of ['LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'TURN_SHARED_SECRET'])
  if (!/^[a-f0-9]{24,}$/.test(e[key] ?? ''))
    throw new Error(
      `${key} precisa ser hexadecimal com pelo menos 24 caracteres. Execute npm run setup ou configure .env.`,
    );
if (isIP(e.MEDIA_PUBLIC_IP ?? '') !== 4)
  throw new Error('MEDIA_PUBLIC_IP deve ser o IPv4 alcançável do servidor SFU/TURN.');
if (!/^[A-Za-z0-9.-]+$/.test(e.TURN_HOST ?? '') || !/^[A-Za-z0-9.-]+$/.test(e.TURN_REALM ?? ''))
  throw new Error('TURN_HOST/REALM inválidos.');
mkdirSync('infra/livekit', { recursive: true });
mkdirSync('coturn', { recursive: true });
const hook =
  e.MEDIA_WEBHOOK_URL ||
  (e.NODE_ENV === 'production'
    ? 'http://backend:3000/api/livekit/webhook'
    : 'http://host.docker.internal:3000/api/livekit/webhook');
if (!/^https?:\/\/[a-zA-Z0-9.:-]+\/api\/livekit\/webhook$/.test(hook))
  throw new Error('MEDIA_WEBHOOK_URL inválida.');
writeFileSync(
  'infra/livekit/livekit.generated.yaml',
  `port: 7880\nrtc:\n  tcp_port: 7881\n  port_range_start: 50000\n  port_range_end: 50100\n  use_external_ip: false\n  node_ip: ${e.MEDIA_PUBLIC_IP}\n  advertise_internal_ip: true\nkeys:\n  ${e.LIVEKIT_API_KEY}: ${e.LIVEKIT_API_SECRET}\nwebhook:\n  api_key: ${e.LIVEKIT_API_KEY}\n  urls:\n    - ${hook}\nlogging:\n  level: warn\n`,
  { mode: 0o600 },
);
writeFileSync(
  'coturn/turnserver.generated.conf',
  `listening-port=${e.TURN_PORT ?? '3478'}\nlistening-ip=0.0.0.0\nexternal-ip=${e.MEDIA_PUBLIC_IP}\nrealm=${e.TURN_REALM}\nfingerprint\nuse-auth-secret\nstatic-auth-secret=${e.TURN_SHARED_SECRET}\nmin-port=49160\nmax-port=49200\nno-cli\n${Number(e.TURN_TLS_PORT) > 0 ? `tls-listening-port=${e.TURN_TLS_PORT}\ncert=/run/coturn/tls/fullchain.pem\npkey=/run/coturn/tls/privkey.pem` : 'no-tls'}\nno-dtls\nno-multicast-peers\ndenied-peer-ip=0.0.0.0-255.255.255.255\nallowed-peer-ip=${e.MEDIA_PUBLIC_IP}\nallowed-peer-ip=${e.LIVEKIT_CONTAINER_IP ?? '172.29.0.10'}\nlog-file=stdout\nsimple-log\n`,
  { mode: 0o600 },
);
console.log(
  'Configurações de LiveKit/coturn geradas localmente; não versionar nem incluir no ZIP.',
);
if (e.MEDIA_PUBLIC_IP === '127.0.0.1')
  console.log(
    'MEDIA_PUBLIC_IP é loopback: ajuste para IP público antes de usar mídia entre redes.',
  );
