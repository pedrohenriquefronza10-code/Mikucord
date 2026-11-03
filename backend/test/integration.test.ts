import { registerFeatureTests } from './features.js';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';
import { pool } from '../src/db.js';
import { redis, status } from '../src/redis.js';
import { s3 } from '../src/media.js';
import { config } from '../src/config.js';
assert.match(
  config.DATABASE_URL,
  /tetocord_test_/,
  'Execute npm test na raiz para usar banco isolado.',
);
let app: Awaited<ReturnType<typeof buildApp>>,
  base: string,
  alice: any,
  bob: any,
  eve: any,
  guild: any,
  channel: any,
  privateChannel: any,
  original: any;
const sockets: Socket[] = [];
function client() {
  const jar = new Map<string, string>();
  return {
    jar,
    cookie: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    async req(
      method: string,
      url: string,
      payload?: unknown,
      headers: Record<string, string> = {},
    ) {
      const result = await app.inject({
        method: method as 'GET',
        url,
        payload: payload as object,
        headers: { cookie: this.cookie(), ...headers },
      });
      for (const c of result.cookies)
        if (c.value) jar.set(c.name, c.value);
        else jar.delete(c.name);
      let body: any;
      try {
        body = result.json();
      } catch {
        body = null;
      }
      return { status: result.statusCode, body, result };
    },
  };
}
async function socketFor(c: ReturnType<typeof client>) {
  const s = io(base, {
    transports: ['websocket'],
    extraHeaders: { cookie: c.cookie() },
    reconnection: false,
  });
  sockets.push(s);
  await new Promise<void>((resolve, reject) => {
    s.once('connect', resolve);
    s.once('connect_error', reject);
  });
  return s;
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
before(async () => {
  await migrate();
  app = await buildApp();
  base = await app.listen({ host: '127.0.0.1', port: 0 });
  alice = client();
  bob = client();
  eve = client();
  for (const [c, username] of [
    [alice, 'Alice'],
    [bob, 'Bia'],
    [eve, 'Eva'],
  ]) {
    const r = await c.req('POST', '/api/auth/register', {
      username,
      password: 'a-strong-test-password',
    });
    assert.equal(r.status, 201);
    c.user = r.body.user;
  }
});
after(async () => {
  for (const s of sockets) s.disconnect();
  if (app) await app.close();
  if (!process.env.TEST_WITHOUT_STORAGE) {
    const objects = await s3.send(new ListObjectsV2Command({ Bucket: config.S3_BUCKET }));
    if (objects.Contents?.length)
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: config.S3_BUCKET,
          Delete: { Objects: objects.Contents.map((o) => ({ Key: o.Key })) },
        }),
      );
    await s3.send(new DeleteBucketCommand({ Bucket: config.S3_BUCKET }));
  }
  await pool.end();
  await redis.quit();
  s3.destroy();
});
test('profile rejects SVG disguised as PNG before contacting storage', async () => {
  const boundary = `boundary-${randomUUID()}`;
  const payload = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="avatar.png"\r\nContent-Type: image/png\r\n\r\n<svg onload="alert(1)"></svg>\r\n--${boundary}--\r\n`,
  );
  const result = await alice.req('POST', '/api/me/media/avatar', payload, {
    'content-type': `multipart/form-data; boundary=${boundary}`,
  });
  assert.equal(result.status, 415);
});
test(
  'health exercises PostgreSQL, Redis and private object storage',
  { skip: !!process.env.TEST_WITHOUT_STORAGE },
  async () => {
    assert.equal((await app.inject('/api/health')).statusCode, 200);
  },
);
test('registration hides secrets and validates bcrypt byte limit', async () => {
  assert.equal(alice.user.password_hash, undefined);
  assert.match(alice.user.tag, /^[0-9]{4}$/);
  assert.equal((await client().req('GET', '/api/me')).status, 401);
  assert.equal(
    (
      await client().req('POST', '/api/auth/register', {
        username: 'LongPassword',
        password: '😀'.repeat(20),
      })
    ).status,
    400,
  );
  const c = client();
  assert.equal(
    (
      await c.req('POST', '/api/auth/login', {
        handle: `Alice#${alice.user.tag}`,
        password: 'wrong-password',
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await c.req('POST', '/api/auth/login', {
        handle: `Alice#${alice.user.tag}`,
        password: 'a-strong-test-password',
      })
    ).status,
    200,
  );
});
test('origin checks reject cross-site cookie requests', async () => {
  assert.equal(
    (
      await alice.req(
        'POST',
        '/api/guilds',
        { name: 'Blocked' },
        { origin: 'https://attacker.invalid' },
      )
    ).status,
    403,
  );
});
test('guild creation is atomic and access is membership-scoped', async () => {
  const r = await alice.req('POST', '/api/guilds', {
    name: 'Nosso cantinho',
    description: 'Só a turma.',
  });
  assert.equal(r.status, 201);
  guild = r.body.guild;
  const list = await alice.req('GET', `/api/guilds/${guild.id}/channels`);
  channel = list.body.channels.find((c: any) => c.type === 'text');
  assert.ok(channel);
  assert.equal((await eve.req('GET', `/api/guilds/${guild.id}/channels`)).status, 403);
  assert.equal((await eve.req('GET', `/api/channels/${channel.id}/messages`)).status, 403);
});
test('single-use invite is consumed once and retries are idempotent', async () => {
  const invite = (await alice.req('POST', `/api/guilds/${guild.id}/invites`, { maxUses: 1 })).body;
  assert.equal((await bob.req('POST', `/api/invites/${invite.code}/join`)).status, 200);
  assert.equal((await bob.req('POST', `/api/invites/${invite.code}/join`)).status, 200);
  assert.equal((await eve.req('POST', `/api/invites/${invite.code}/join`)).status, 410);
  assert.equal(
    (await pool.query('SELECT uses,code_hash FROM guild_invites WHERE guild_id=$1', [guild.id]))
      .rows[0].uses,
    1,
  );
});
test('categories, private channels and cross-guild parents enforce access', async () => {
  privateChannel = (
    await alice.req('POST', `/api/guilds/${guild.id}/channels`, { name: 'privado', private: true })
  ).body.channel;
  assert.equal((await bob.req('GET', `/api/channels/${privateChannel.id}/messages`)).status, 403);
  const visible = (await bob.req('GET', `/api/guilds/${guild.id}/channels`)).body.channels;
  assert.ok(!visible.some((c: any) => c.id === privateChannel.id));
  assert.equal(
    (await bob.req('POST', `/api/guilds/${guild.id}/channels`, { name: 'nope' })).status,
    403,
  );
  assert.equal(
    (
      await alice.req('POST', `/api/guilds/${guild.id}/channels`, {
        name: 'invalid',
        parentId: channel.id,
      })
    ).status,
    400,
  );
});
test('Socket.IO delivers persisted messages to authorized clients only', async () => {
  const a = await socketFor(alice),
    b = await socketFor(bob),
    e = await socketFor(eve);
  assert.equal((await b.emitWithAck('channel.join', { channelId: channel.id })).ok, true);
  assert.equal((await e.emitWithAck('channel.join', { channelId: channel.id })).ok, false);
  const seen: any[] = [];
  b.on('message.created', (v) => seen.push(v));
  const leaks: any[] = [];
  e.on('message.created', (v) => leaks.push(v));
  const nonce = randomUUID(),
    r = await a.emitWithAck('message.send', {
      channelId: channel.id,
      content: `Oi <@${bob.user.id}>!`,
      clientNonce: nonce,
    });
  assert.equal(r.ok, true);
  original = r.message;
  await pause(900);
  assert.ok(seen.some((v) => v.messageId === original.id));
  assert.equal(leaks.length, 0);
  assert.equal(
    (
      await a.emitWithAck('message.send', {
        channelId: channel.id,
        content: 'Retry',
        clientNonce: nonce,
      })
    ).message.id,
    original.id,
  );
  const history = await bob.req('GET', `/api/channels/${channel.id}/messages`);
  assert.equal(history.body.messages.filter((m: any) => m.id === original.id).length, 1);
  assert.equal((await bob.req('GET', '/api/notifications')).body.notifications.length, 1);
});
test('replies, edits, optimistic versions, mentions and tombstones work', async () => {
  const reply = (
    await bob.req('POST', `/api/channels/${channel.id}/messages`, {
      content: 'Cheguei!',
      clientNonce: randomUUID(),
      replyTo: original.id,
    })
  ).body.message;
  assert.equal(reply.reply.id, original.id);
  assert.equal(
    (
      await bob.req('PATCH', `/api/messages/${original.id}`, {
        content: 'Bad edit',
        version: original.version,
      })
    ).status,
    403,
  );
  const edited = await alice.req('PATCH', `/api/messages/${original.id}`, {
    content: 'Oi, turma! <script>window.pwned=1</script>',
    version: original.version,
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.message.version, '2');
  assert.equal(
    (await alice.req('PATCH', `/api/messages/${original.id}`, { content: 'Stale', version: '1' }))
      .status,
    409,
  );
  assert.equal(
    (
      await bob.req('POST', `/api/channels/${channel.id}/messages`, {
        content: '@everyone teste',
        clientNonce: randomUUID(),
      })
    ).status,
    403,
  );
  assert.equal(
    (await alice.req('DELETE', `/api/messages/${original.id}`, { version: '2' })).status,
    200,
  );
  const history = (await bob.req('GET', `/api/channels/${channel.id}/messages`)).body.messages;
  assert.equal(history.find((m: any) => m.id === original.id).content, '');
  assert.ok(history.find((m: any) => m.id === reply.id).reply.deleted_at);
});
test('role creation/assignment preserves guild scope and colored members', async () => {
  const role = (
    await alice.req('POST', `/api/guilds/${guild.id}/roles`, { name: 'Amigos', color: '#91D4BD' })
  ).body.role;
  assert.ok(role.id);
  assert.equal(
    (await alice.req('PUT', `/api/guilds/${guild.id}/members/${bob.user.id}/roles/${role.id}`))
      .status,
    200,
  );
  const member = (await bob.req('GET', `/api/guilds/${guild.id}/members`)).body.members.find(
    (m: any) => m.id === bob.user.id,
  );
  assert.equal(member.roles[0].color, '#91D4BD');
  assert.equal(member.preferred_status, undefined);
  assert.equal(
    (await bob.req('PUT', `/api/guilds/${guild.id}/members/${eve.user.id}/roles/${role.id}`))
      .status,
    403,
  );
  assert.equal(
    (await alice.req('DELETE', `/api/guilds/${guild.id}/members/${bob.user.id}/roles/${role.id}`))
      .status,
    200,
  );
});
test('presence aggregates multiple sockets and hides invisible status', async () => {
  const c: any = client();
  const registered = await c.req('POST', '/api/auth/register', {
    username: 'Presence',
    password: 'a-strong-test-password',
  });
  assert.equal(registered.status, 201);
  const user = registered.body.user;
  const b1 = await socketFor(c),
    b2 = await socketFor(c);
  await pause(200);
  assert.equal(await status(user.id, 'online'), 'online');
  b1.disconnect();
  await pause(200);
  assert.equal(await status(user.id, 'online'), 'online');
  assert.equal(await status(user.id, 'invisible'), 'offline');
  assert.equal((await c.req('PATCH', '/api/me', { preferred_status: 'dnd' })).status, 200);
  assert.equal(await status(user.id, 'dnd'), 'dnd');
  b2.disconnect();
  await pause(200);
  assert.equal(await status(user.id, 'online'), 'offline');
});
test(
  'profile images validate bytes, deduplicate blobs and restrict downloads',
  { skip: !!process.env.TEST_WITHOUT_STORAGE },
  async () => {
    const png = await sharp({
      create: { width: 10, height: 10, channels: 4, background: '#9b7aef' },
    })
      .png()
      .toBuffer();
    const upload = async (c: any, buffer: Buffer) => {
      const boundary = `boundary-${randomUUID()}`;
      const payload = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="avatar.png"\r\nContent-Type: image/png\r\n\r\n`,
        ),
        buffer,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      return c.req('POST', '/api/me/media/avatar', payload, {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      });
    };
    const a = await upload(alice, png),
      b = await upload(bob, png);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.notEqual(a.body.user.avatar_asset_id, b.body.user.avatar_asset_id);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM storage_objects')).rows[0].n, 1);
    assert.equal((await bob.req('GET', `/api/media/${a.body.user.avatar_asset_id}`)).status, 200);
    assert.equal((await eve.req('GET', `/api/media/${a.body.user.avatar_asset_id}`)).status, 404);
    assert.equal((await upload(alice, Buffer.from('<svg onload="alert(1)"></svg>'))).status, 415);
  },
);
test('refresh rotates, replay revokes the whole family, logout revokes access', async () => {
  const c = client();
  await c.req('POST', '/api/auth/login', {
    handle: `Alice#${alice.user.tag}`,
    password: 'a-strong-test-password',
  });
  const old = c.jar.get('refresh')!;
  assert.equal((await c.req('POST', '/api/auth/refresh')).status, 200);
  assert.notEqual(c.jar.get('refresh'), old);
  const fresh = c.cookie();
  const replay = client();
  replay.jar.set('refresh', old);
  assert.equal((await replay.req('POST', '/api/auth/refresh')).status, 401);
  assert.equal((await app.inject({ url: '/api/me', headers: { cookie: fresh } })).statusCode, 401);
  const valid = client();
  await valid.req('POST', '/api/auth/login', {
    handle: `Alice#${alice.user.tag}`,
    password: 'a-strong-test-password',
  });
  const cookies = valid.cookie();
  await valid.req('POST', '/api/auth/logout');
  assert.equal(
    (await app.inject({ url: '/api/me', headers: { cookie: cookies } })).statusCode,
    401,
  );
});
registerFeatureTests(() => ({ app, base, alice, bob, eve, guild, channel, privateChannel }));

test('leaving a guild immediately removes history and image access', async () => {
  assert.equal((await bob.req('DELETE', `/api/guilds/${guild.id}/membership`)).status, 200);
  assert.equal((await bob.req('GET', `/api/channels/${channel.id}/messages`)).status, 403);
  if (!process.env.TEST_WITHOUT_STORAGE) {
    const asset = (
      await pool.query('SELECT avatar_asset_id FROM users WHERE id=$1', [alice.user.id])
    ).rows[0].avatar_asset_id;
    assert.equal((await bob.req('GET', `/api/media/${asset}`)).status, 404);
  }
});
