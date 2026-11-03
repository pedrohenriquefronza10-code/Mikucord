import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash, createHmac } from 'node:crypto';
import sharp from 'sharp';
import { TokenVerifier, AccessToken } from 'livekit-server-sdk';
import { pool } from '../src/db.js';
import { config } from '../src/config.js';
import { inQuietHours } from '../src/notifications.js';
export function registerFeatureTests(context: () => any) {
  const upload = async (client: any, channel: string, bytes: Buffer, name: string) => {
    const created = await client.req('POST', `/api/channels/${channel}/uploads`, {
      filename: name,
      size: String(bytes.length),
      clientNonce: randomUUID(),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const session = created.body.upload;
    const state = (await client.req('GET', `/api/uploads/${session.id}`)).body.upload;
    for (let offset = 0, part = 1; offset < bytes.length; offset += state.partSize, part++) {
      const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + state.partSize));
      const result = await client.req('PUT', `/api/uploads/${session.id}/parts/${part}`, chunk, {
        'content-type': 'application/octet-stream',
        'content-length': String(chunk.length),
      });
      assert.equal(result.status, 200, JSON.stringify(result.body));
    }
    const result = await client.req('POST', `/api/uploads/${session.id}/complete`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return { asset: result.body.asset, session: session.id };
  };
  const catalogFile = async (
    client: any,
    guild: string,
    kind: string,
    name: string,
    bytes: Buffer,
    extension: string,
  ) => {
    const boundary = `part-${randomUUID()}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}.${extension}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return client.req(
      'POST',
      `/api/guilds/${guild}/catalog/${kind}?name=${encodeURIComponent(name)}`,
      body,
      { 'content-type': `multipart/form-data; boundary=${boundary}` },
    );
  };
  function wav(seconds: number) {
    const samples = Math.floor(8000 * seconds),
      buffer = Buffer.alloc(44 + samples * 2);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(buffer.length - 8, 4);
    buffer.write('WAVEfmt ', 8);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(8000, 24);
    buffer.writeUInt32LE(16000, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(samples * 2, 40);
    for (let i = 0; i < samples; i++)
      buffer.writeInt16LE(Math.round(Math.sin((i / 8000) * 440 * Math.PI * 2) * 6000), 44 + i * 2);
    return buffer;
  }
  test('multipart files larger than profile limits stream, resume, deduplicate and support ranges', async () => {
    const { alice, bob, eve, channel } = context(),
      bytes = Buffer.alloc(25 * 1024 ** 2 + 17, 71);
    bytes.write('Tetocord test binary');
    const first = await upload(alice, channel.id, bytes, 'memorias.bin'),
      second = await upload(bob, channel.id, bytes, 'copia.bin');
    assert.notEqual(first.asset.id, second.asset.id);
    const count = (
      await pool.query('SELECT count(*)::int AS n FROM storage_objects WHERE sha256=$1', [
        createHash('sha256').update(bytes).digest('hex'),
      ])
    ).rows[0].n;
    assert.equal(count, 1);
    assert.equal((await bob.req('GET', `/api/uploads/${first.session}`)).status, 404);
    const message = (
      await alice.req('POST', `/api/channels/${channel.id}/messages`, {
        content: '',
        clientNonce: randomUUID(),
        attachmentIds: [first.asset.id],
      })
    ).body.message;
    assert.ok(message.attachments.length);
    const attachment = message.attachments[0];
    assert.equal((await eve.req('GET', `/api/attachments/${attachment.id}/download`)).status, 403);
    const range = await bob.req('GET', `/api/attachments/${attachment.id}/content`, undefined, {
      range: 'bytes=0-31',
    });
    assert.equal(range.status, 206);
    assert.deepEqual(range.result.rawPayload, bytes.subarray(0, 32));
    assert.equal(range.result.headers['content-type'], 'application/octet-stream');
    assert.match(range.result.headers['content-disposition'] as string, /attachment/);
    assert.equal(
      (
        await bob.req('GET', `/api/attachments/${attachment.id}/content`, undefined, {
          range: 'bytes=999999999-',
        })
      ).status,
      416,
    );
    assert.equal((await alice.req('GET', `/api/media/${first.asset.id}`)).status, 404);
    const forged = await alice.req('POST', `/api/channels/${channel.id}/messages`, {
      content: '',
      clientNonce: randomUUID(),
      attachmentIds: [second.asset.id],
    });
    assert.equal(forged.status, 403);
    assert.equal(
      (await alice.req('DELETE', `/api/messages/${message.id}`, { version: message.version }))
        .status,
      200,
    );
    assert.equal((await bob.req('GET', `/api/attachments/${attachment.id}/download`)).status, 404);
  });
  test('incomplete uploads cannot complete and cancellation revokes further parts', async () => {
    const { alice, channel } = context(),
      nonce = randomUUID(),
      body = { filename: 'incompleto.bin', size: '10', clientNonce: nonce };
    const first = await alice.req('POST', `/api/channels/${channel.id}/uploads`, body),
      again = await alice.req('POST', `/api/channels/${channel.id}/uploads`, body);
    assert.equal(first.body.upload.id, again.body.upload.id);
    const id = first.body.upload.id;
    assert.equal((await alice.req('POST', `/api/uploads/${id}/complete`)).status, 400);
    assert.equal((await alice.req('DELETE', `/api/uploads/${id}`)).status, 200);
    assert.equal(
      (
        await alice.req('PUT', `/api/uploads/${id}/parts/1`, Buffer.alloc(10), {
          'content-type': 'application/octet-stream',
          'content-length': '10',
        })
      ).status,
      409,
    );
  });
  test('catalogs validate images/audio duration and messages carry stickers, custom emoji and reactions', async () => {
    const { alice, bob, eve, channel, guild } = context(),
      png = await sharp({ create: { width: 12, height: 12, channels: 4, background: '#e0b1cb' } })
        .png()
        .toBuffer();
    const emoji = await catalogFile(alice, guild.id, 'emoji', 'cafe', png, 'png'),
      sticker = await catalogFile(alice, guild.id, 'sticker', 'abraço', png, 'png'),
      sound = await catalogFile(alice, guild.id, 'sound', 'plim', wav(0.15), 'wav');
    assert.equal(emoji.status, 201);
    assert.equal(sticker.status, 201);
    assert.equal(sound.status, 201);
    assert.equal(
      (await catalogFile(alice, guild.id, 'sound', 'longo', wav(11), 'wav')).status,
      400,
    );
    assert.equal(
      (await catalogFile(bob, guild.id, 'emoji', 'sem_permissao', png, 'png')).status,
      403,
    );
    const message = (
      await alice.req('POST', `/api/channels/${channel.id}/messages`, {
        content: ':cafe: Oi!',
        stickerIds: [sticker.body.item.id],
        clientNonce: randomUUID(),
      })
    ).body.message;
    assert.equal(message.emojis[0].id, emoji.body.item.id);
    assert.equal(message.stickers[0].id, sticker.body.item.id);
    assert.equal(
      (await bob.req('PUT', `/api/messages/${message.id}/reactions`, { emoji: '💜' })).status,
      200,
    );
    assert.equal(
      (
        await bob.req('PUT', `/api/messages/${message.id}/reactions`, {
          customEmojiId: emoji.body.item.id,
        })
      ).status,
      200,
    );
    const history = (
      await alice.req('GET', `/api/channels/${channel.id}/messages`)
    ).body.messages.find((m: any) => m.id === message.id);
    assert.equal(history.reactions.length, 2);
    assert.equal(history.reactions[0].count, 1);
    assert.equal(
      (await bob.req('PUT', `/api/messages/${message.id}/reactions`, { emoji: '💜' })).status,
      200,
    );
    assert.equal(
      (
        await alice.req('PATCH', `/api/guilds/${guild.id}/catalog/emoji/${emoji.body.item.id}`, {
          name: 'cafe_novo',
        })
      ).status,
      200,
    );
    const renamed = (
      await alice.req('GET', `/api/channels/${channel.id}/messages`)
    ).body.messages.find((m: any) => m.id === message.id);
    assert.equal(renamed.emojis[0].name, 'cafe');
    const stable = await alice.req('POST', `/api/channels/${channel.id}/messages`, {
      content: `<:${emoji.body.item.id}:cafe:>`,
      clientNonce: randomUUID(),
    });
    assert.equal(stable.status, 201);
    assert.equal(stable.body.message.emojis[0].id, emoji.body.item.id);
    assert.equal(
      (
        await eve.req('POST', `/api/channels/${context().privateChannel.id}/messages`, {
          content: `<:${emoji.body.item.id}:cafe:>`,
          clientNonce: randomUUID(),
        })
      ).status,
      403,
    );
  });
  test('forum posts inherit category privacy and regular members can post in an accessible forum', async () => {
    const { alice, bob, guild } = context();
    const category = (
      await alice.req('POST', `/api/guilds/${guild.id}/channels`, {
        name: 'Assuntos',
        type: 'category',
      })
    ).body.channel;
    const forum = (
      await alice.req('POST', `/api/guilds/${guild.id}/channels`, {
        name: 'Fórum',
        type: 'forum',
        parentId: category.id,
      })
    ).body.channel;
    const thread = await bob.req('POST', `/api/guilds/${guild.id}/channels`, {
      name: 'Um assunto',
      type: 'thread',
      parentId: forum.id,
    });
    assert.equal(thread.status, 201, JSON.stringify(thread.body));
    const roles = (await alice.req('GET', `/api/guilds/${guild.id}/roles`)).body.roles;
    assert.equal(
      (
        await alice.req('PUT', `/api/channels/${category.id}/overwrites`, {
          target: 'role',
          targetId: roles.find((r: any) => r.is_everyone).id,
          allow: '0',
          deny: '1',
        })
      ).status,
      200,
    );
    assert.equal(
      (await bob.req('GET', `/api/channels/${thread.body.channel.id}/messages`)).status,
      403,
    );
    assert.equal(
      (
        await bob.req('POST', `/api/guilds/${guild.id}/channels`, {
          name: 'Tentativa',
          type: 'thread',
          parentId: forum.id,
        })
      ).status,
      403,
    );
  });
  test('themes persist palette, enforce ownership and share only with guild members', async () => {
    const { alice, bob, eve, guild } = context(),
      palette = {
        primary: '#112233',
        secondary: '#223344',
        background: '#101020',
        surface: '#334455',
        text: '#eeeeff',
        accent: '#b59aef',
      };
    const theme = (
      await alice.req('POST', '/api/themes', {
        name: 'Jardim',
        base_mode: 'dark',
        palette,
        guild_id: guild.id,
      })
    ).body.theme;
    assert.ok(theme.id);
    assert.equal(
      (await bob.req('PUT', '/api/me/theme', { mode: 'custom', theme_id: theme.id })).status,
      200,
    );
    assert.equal(
      (await eve.req('PUT', '/api/me/theme', { mode: 'custom', theme_id: theme.id })).status,
      403,
    );
    assert.equal((await bob.req('DELETE', `/api/themes/${theme.id}`)).status, 403);
    assert.equal((await bob.req('GET', '/api/me')).body.user.preferences.palette.accent, '#b59aef');
    assert.equal(
      (
        await alice.req('POST', '/api/themes', {
          name: 'Invalid',
          base_mode: 'dark',
          palette: { ...palette, accent: 'url(javascript:alert(1))' },
        })
      ).status,
      400,
    );
    assert.equal((await alice.req('DELETE', `/api/themes/${theme.id}`)).status, 200);
    assert.equal((await bob.req('GET', '/api/me')).body.user.preferences.theme_mode, 'dark');
  });
  test('friend requests, direct/group conversations, blocks and departure enforce membership', async () => {
    const { alice, bob, eve, channel } = context();
    const request = (await alice.req('POST', '/api/friends/requests', { userId: eve.user.id })).body
      .request;
    assert.ok(request.id);
    assert.equal(
      (await eve.req('PATCH', `/api/friends/requests/${request.id}`, { action: 'accept' })).status,
      200,
    );
    const dm = (await alice.req('POST', '/api/conversations', { members: [eve.user.id] })).body
      .channel;
    assert.ok(dm.id);
    assert.equal(
      (await eve.req('POST', '/api/conversations', { members: [alice.user.id] })).body.channel.id,
      dm.id,
    );
    assert.equal(
      (
        await alice.req('POST', `/api/channels/${dm.id}/messages`, {
          content: 'Café secreto das amigas',
          clientNonce: randomUUID(),
        })
      ).status,
      201,
    );
    assert.equal((await bob.req('GET', `/api/channels/${dm.id}/messages`)).status, 403);
    const group = (
      await alice.req('POST', '/api/conversations', {
        name: 'A turma',
        members: [bob.user.id, eve.user.id],
      })
    ).body.channel;
    assert.equal(group.type, 'group_dm');
    assert.equal(
      (await eve.req('DELETE', `/api/conversations/${group.id}/membership`)).status,
      200,
    );
    assert.equal((await eve.req('GET', `/api/channels/${group.id}/messages`)).status, 403);
    assert.equal((await eve.req('PUT', `/api/people/${alice.user.id}/block`)).status, 200);
    assert.equal(
      (
        await alice.req('POST', `/api/channels/${dm.id}/messages`, {
          content: 'blocked',
          clientNonce: randomUUID(),
        })
      ).status,
      403,
    );
    assert.equal(
      (await bob.req('DELETE', `/api/conversations/${group.id}/membership`)).status,
      200,
    );
    const searches = (await bob.req('GET', '/api/search?q=secreto')).body.results;
    assert.ok(!searches.some((m: any) => m.channel_id === dm.id));
    assert.ok(
      (await alice.req('GET', '/api/search?q=secreto')).body.results.some(
        (m: any) => m.channel_id === dm.id,
      ),
    );
  });
  test('permission overwrites, protected owner, moderation and audit apply server-side', async () => {
    const { alice, bob, eve, guild, privateChannel } = context(),
      roles = (await alice.req('GET', `/api/guilds/${guild.id}/roles`)).body.roles,
      everyone = roles.find((r: any) => r.is_everyone);
    assert.equal(
      (
        await alice.req('PUT', `/api/channels/${privateChannel.id}/overwrites`, {
          target: 'member',
          targetId: bob.user.id,
          allow: '1',
          deny: '0',
        })
      ).status,
      200,
    );
    assert.equal((await bob.req('GET', `/api/channels/${privateChannel.id}/messages`)).status, 200);
    assert.equal(
      (
        await alice.req('PUT', `/api/channels/${privateChannel.id}/overwrites`, {
          target: 'member',
          targetId: bob.user.id,
          allow: '0',
          deny: '1',
        })
      ).status,
      200,
    );
    assert.equal((await bob.req('GET', `/api/channels/${privateChannel.id}/messages`)).status, 403);
    assert.equal(
      (
        await bob.req('PATCH', `/api/guilds/${guild.id}/roles/${everyone.id}`, {
          permissions: '67108864',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await alice.req('POST', `/api/guilds/${guild.id}/moderation`, {
          userId: alice.user.id,
          action: 'ban',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await alice.req('POST', `/api/guilds/${guild.id}/moderation`, {
          userId: bob.user.id,
          action: 'timeout',
          minutes: 1,
        })
      ).status,
      200,
    );
    const ch = (await alice.req('GET', `/api/guilds/${guild.id}/channels`)).body.channels.find(
      (c: any) => c.type === 'text' && c.id !== privateChannel.id,
    );
    assert.equal(
      (
        await bob.req('POST', `/api/channels/${ch.id}/messages`, {
          content: 'timeout',
          clientNonce: randomUUID(),
        })
      ).status,
      403,
    );
    await alice.req('POST', `/api/guilds/${guild.id}/moderation`, {
      userId: bob.user.id,
      action: 'timeout',
      minutes: 0,
    });
    assert.equal((await eve.req('GET', `/api/guilds/${guild.id}/audit`)).status, 403);
    assert.ok((await alice.req('GET', `/api/guilds/${guild.id}/audit`)).body.logs.length > 0);
  });
  test('voice tokens are room-scoped, permissioned and include expiring authenticated TURN', async () => {
    const { alice, eve, guild } = context();
    const channel = (
      await alice.req('POST', `/api/guilds/${guild.id}/channels`, {
        name: 'Café com a turma',
        type: 'voice',
      })
    ).body.channel;
    assert.ok(channel.id);
    assert.equal((await eve.req('POST', `/api/channels/${channel.id}/voice/join`)).status, 403);
    const joined = await alice.req('POST', `/api/channels/${channel.id}/voice/join`);
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    const verified = await new TokenVerifier(
      config.LIVEKIT_API_KEY,
      config.LIVEKIT_API_SECRET,
    ).verify(joined.body.token);
    assert.equal(verified.video?.roomJoin, true);
    assert.ok(verified.video?.room?.startsWith('tetocord-'));
    assert.equal(verified.video?.roomAdmin, undefined);
    const turn = joined.body.iceServers[1];
    assert.equal(
      turn.credential,
      createHmac('sha1', config.TURN_SHARED_SECRET).update(turn.username).digest('base64'),
    );
    assert.ok(Number(turn.username.split(':')[0]) > Date.now() / 1000);
    const me = (await alice.req('GET', '/api/me')).body.user;
    assert.equal(me.LIVEKIT_API_SECRET, undefined);
    assert.equal(
      (await alice.req('POST', `/api/voice/${joined.body.participantId}/leave`)).status,
      200,
    );
  });
  test('webhooks reject forged signatures and accept signed delivery once', async () => {
    const { app } = context(),
      body = JSON.stringify({
        id: randomUUID(),
        event: 'room_started',
        room: { name: 'webhook-test' },
      });
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/livekit/webhook',
          headers: { 'content-type': 'application/webhook+json', authorization: 'invalid' },
          payload: body,
        })
      ).statusCode,
      401,
    );
    const token = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET);
    token.sha256 = createHash('sha256').update(body).digest('base64');
    const jwt = await token.toJwt();
    for (let i = 0; i < 2; i++)
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/livekit/webhook',
            headers: { 'content-type': 'application/webhook+json', authorization: jwt },
            payload: body,
          })
        ).statusCode,
        200,
      );
  });
  test('quiet hours validate overlap/timezone, and push rejects arbitrary network endpoints', async () => {
    const { alice } = context();
    assert.equal(
      inQuietHours(
        'America/Sao_Paulo',
        [{ weekday: 1, start_local: '22:00:00', end_local: '23:00:00' }],
        new Date('2026-11-03T01:30:00Z'),
      ),
      true,
    );
    assert.equal(
      (
        await alice.req('PATCH', '/api/me/notification-settings', {
          quiet_hours_enabled: true,
          timezone: 'America/Sao_Paulo',
          schedules: [{ weekday: 1, start: '22:00', end: '23:00' }],
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await alice.req('PATCH', '/api/me/notification-settings', {
          schedules: [
            { weekday: 1, start: '22:00', end: '23:00' },
            { weekday: 1, start: '22:30', end: '23:30' },
          ],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await alice.req('POST', '/api/push/subscriptions', {
          endpoint: 'https://127.0.0.1/internal',
          keys: { p256dh: 'abc', auth: 'abc' },
        })
      ).status,
      400,
    );
  });
  test(
    'GIF integration reports a missing provider key explicitly',
    { skip: !!config.GIF_API_KEY },
    async () => {
      const { alice } = context();
      assert.equal((await alice.req('GET', '/api/gifs?q=cafe')).status, 503);
    },
  );
}
