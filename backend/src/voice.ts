import type { FastifyInstance } from 'fastify';
import { randomUUID, createHmac } from 'node:crypto';
import { AccessToken, RoomServiceClient, WebhookReceiver, TrackSource } from 'livekit-server-sdk';
import { z } from 'zod';
import { config } from './config.js';
import { pool, tx, ensure, event, audit } from './db.js';
import { channelAccess, guildAccess, P } from './permissions.js';
import { validSession } from './auth.js';
const param = (p: unknown) => z.uuid().parse((p as { id: string }).id);
export const roomService = () =>
  new RoomServiceClient(
    config.LIVEKIT_INTERNAL_URL,
    config.LIVEKIT_API_KEY,
    config.LIVEKIT_API_SECRET,
    { requestTimeout: 10 },
  );
function sources(p: bigint, muted = false) {
  const list: TrackSource[] = [];
  if ((p & P.SPEAK) !== 0n && !muted) list.push(TrackSource.MICROPHONE);
  if ((p & P.VIDEO) !== 0n) list.push(TrackSource.CAMERA);
  if ((p & P.STREAM) !== 0n) list.push(TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO);
  return list;
}
export function turnCredentials(user: string) {
  const username = `${Math.floor(Date.now() / 1000) + 14400}:${user}`,
    credential = createHmac('sha1', config.TURN_SHARED_SECRET).update(username).digest('base64');
  const urls = [
    `turn:${config.TURN_HOST}:${config.TURN_PORT}?transport=udp`,
    `turn:${config.TURN_HOST}:${config.TURN_PORT}?transport=tcp`,
  ];
  if (config.TURN_TLS_PORT)
    urls.push(`turns:${config.TURN_HOST}:${config.TURN_TLS_PORT}?transport=tcp`);
  return [{ urls: `stun:${config.TURN_HOST}:${config.TURN_PORT}` }, { urls, username, credential }];
}
async function finishParticipant(identity: string) {
  await tx(async (db) => {
    const p = (
      await db.query(
        'UPDATE voice_participants SET left_at=COALESCE(left_at,now()) WHERE provider_participant_identity=$1 RETURNING *',
        [identity],
      )
    ).rows[0];
    if (!p) return;
    await db.query(
      'UPDATE voice_tracks SET ended_at=COALESCE(ended_at,now()) WHERE participant_id=$1',
      [p.id],
    );
    const s = (
      await db.query(
        'SELECT s.*,c.guild_id FROM voice_sessions s JOIN channels c ON c.id=s.channel_id WHERE s.id=$1',
        [p.voice_session_id],
      )
    ).rows[0];
    await event(db, 'voice.changed', s.id, { guildId: s.guild_id, channelId: s.channel_id });
  });
}
export async function voiceWebhook(app: FastifyInstance) {
  app.addContentTypeParser('application/webhook+json', { parseAs: 'string' }, (_req, body, done) =>
    done(null, body),
  );
  app.post('/api/livekit/webhook', async (req, reply) => {
    ensure(config.LIVEKIT_API_KEY && config.LIVEKIT_API_SECRET, 503, 'Mídia não configurada.');
    let e;
    try {
      e = await new WebhookReceiver(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET).receive(
        req.body as string,
        req.headers.authorization,
      );
    } catch {
      return reply.code(401).send({ error: 'Webhook inválido.' });
    }
    const identity = e.participant?.identity;
    const p = identity
      ? (
          await pool.query(
            'SELECT p.*,s.provider_room_name,s.channel_id,c.guild_id FROM voice_participants p JOIN voice_sessions s ON s.id=p.voice_session_id JOIN channels c ON c.id=s.channel_id WHERE p.provider_participant_identity=$1',
            [identity],
          )
        ).rows[0]
      : null;
    if (identity && e.event === 'participant_joined') {
      let allowed = !!p && !p.left_at && p.provider_room_name === e.room?.name;
      try {
        if (allowed) {
          await channelAccess(p.user_id, p.channel_id, P.CONNECT);
          allowed = await validSession(p.auth_session_id, p.user_id);
        }
      } catch {
        allowed = false;
      }
      if (!allowed) {
        if (e.room?.name)
          await roomService()
            .removeParticipant(e.room.name, identity)
            .catch(() => {});
        return { ok: true };
      }
    }
    await tx(async (db) => {
      if (
        e.id &&
        !(
          await db.query(
            'INSERT INTO processed_webhooks(id) VALUES($1) ON CONFLICT DO NOTHING RETURNING id',
            [e.id],
          )
        ).rowCount
      )
        return;
      if (p) {
        if (e.event === 'participant_joined')
          await db.query('UPDATE voice_participants SET connected_at=now() WHERE id=$1', [p.id]);
        if (['participant_left', 'participant_connection_aborted'].includes(e.event)) {
          await db.query(
            'UPDATE voice_participants SET left_at=COALESCE(left_at,now()) WHERE id=$1',
            [p.id],
          );
          await db.query(
            'UPDATE voice_tracks SET ended_at=COALESCE(ended_at,now()) WHERE participant_id=$1',
            [p.id],
          );
        }
        if (e.event === 'track_published' && e.track) {
          const source = e.track.name.startsWith('soundboard-')
            ? 'soundboard'
            : (
                {
                  [TrackSource.MICROPHONE]: 'microphone',
                  [TrackSource.CAMERA]: 'camera',
                  [TrackSource.SCREEN_SHARE]: 'screen_video',
                  [TrackSource.SCREEN_SHARE_AUDIO]: 'screen_audio',
                } as Record<number, string>
              )[e.track.source];
          if (source) {
            await db.query(
              'UPDATE voice_tracks SET ended_at=now() WHERE participant_id=$1 AND source=$2 AND ended_at IS NULL',
              [p.id, source],
            );
            await db.query(
              'INSERT INTO voice_tracks(participant_id,provider_track_sid,source,width,height) VALUES($1,$2,$3,$4,$5) ON CONFLICT(provider_track_sid) DO NOTHING',
              [p.id, e.track.sid, source, e.track.width || null, e.track.height || null],
            );
          }
        }
        if (e.event === 'track_unpublished' && e.track)
          await db.query(
            'UPDATE voice_tracks SET ended_at=COALESCE(ended_at,now()) WHERE provider_track_sid=$1',
            [e.track.sid],
          );
        await event(db, 'voice.changed', p.voice_session_id, {
          guildId: p.guild_id,
          channelId: p.channel_id,
        });
      }
      if (e.event === 'room_finished' && e.room) {
        const room = (
          await db.query(
            'UPDATE voice_sessions SET ended_at=COALESCE(ended_at,now()) WHERE provider_room_name=$1 RETURNING *',
            [e.room.name],
          )
        ).rows[0];
        if (room)
          await db.query(
            'UPDATE voice_participants SET left_at=COALESCE(left_at,now()) WHERE voice_session_id=$1',
            [room.id],
          );
      }
    });
    return { ok: true };
  });
}
export async function voiceRoutes(app: FastifyInstance) {
  app.get('/api/voice/health', async () => {
    ensure(
      config.LIVEKIT_API_KEY && config.TURN_SHARED_SECRET,
      503,
      'SFU/TURN ainda não configurados.',
    );
    await roomService().listRooms();
    return { status: 'ok', turn: !!config.TURN_HOST };
  });
  app.get('/api/guilds/:id/voice', async (req) => {
    const guild = param(req.params);
    await guildAccess(req.user.sub, guild);
    const rooms = (
      await pool.query(
        `SELECT s.* FROM voice_sessions s JOIN channels c ON c.id=s.channel_id WHERE c.guild_id=$1 AND s.ended_at IS NULL`,
        [guild],
      )
    ).rows;
    const visible = [];
    for (const room of rooms) {
      try {
        await channelAccess(req.user.sub, room.channel_id, P.CONNECT);
        room.participants = (
          await pool.query(
            `SELECT p.id,p.user_id,p.connected_at,p.self_muted,p.self_deafened,p.server_muted,p.server_deafened,u.username,u.avatar_asset_id,u.accent_color,COALESCE((SELECT json_agg(t.source) FROM voice_tracks t WHERE t.participant_id=p.id AND t.ended_at IS NULL),'[]') AS tracks FROM voice_participants p JOIN users u ON u.id=p.user_id WHERE p.voice_session_id=$1 AND p.left_at IS NULL`,
            [room.id],
          )
        ).rows;
        visible.push(room);
      } catch {}
    }
    return { rooms: visible };
  });
  app.post('/api/channels/:id/voice/join', async (req) => {
    const channel = param(req.params);
    ensure(
      config.LIVEKIT_API_KEY && config.LIVEKIT_API_SECRET && config.TURN_SHARED_SECRET,
      503,
      'As chamadas ainda não foram configuradas pelo administrador.',
    );
    const a = await channelAccess(req.user.sub, channel, P.CONNECT);
    ensure(['voice', 'video'].includes(a.channel.type), 400, 'Escolha um canal de voz.');
    ensure(
      !a.member.timeout_until || new Date(a.member.timeout_until).getTime() < Date.now(),
      403,
      'Você está silenciado.',
    );
    const previous = (
      await pool.query(
        'SELECT p.*,s.provider_room_name FROM voice_participants p JOIN voice_sessions s ON s.id=p.voice_session_id WHERE p.user_id=$1 AND p.left_at IS NULL',
        [req.user.sub],
      )
    ).rows;
    for (const p of previous) {
      await roomService()
        .removeParticipant(p.provider_room_name, p.provider_participant_identity)
        .catch(() => {});
      await finishParticipant(p.provider_participant_identity);
    }
    const room = await tx(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`voice:${channel}`]);
      let row = (
        await db.query('SELECT * FROM voice_sessions WHERE channel_id=$1 AND ended_at IS NULL', [
          channel,
        ])
      ).rows[0];
      if (!row)
        row = (
          await db.query(
            'INSERT INTO voice_sessions(channel_id,provider_room_name,started_by) VALUES($1,$2,$3) RETURNING *',
            [channel, `tetocord-${randomUUID()}`, req.user.sub],
          )
        ).rows[0];
      return row;
    });
    await roomService().createRoom({
      name: room.provider_room_name,
      emptyTimeout: 90,
      departureTimeout: 30,
    });
    const participantId = randomUUID(),
      identity = `${req.user.sub}:${participantId}`,
      user = (await pool.query('SELECT username FROM users WHERE id=$1', [req.user.sub])).rows[0];
    const token = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, {
      identity,
      name: user.username,
      ttl: '5m',
      metadata: JSON.stringify({ userId: req.user.sub, sessionId: room.id }),
    });
    token.addGrant({
      roomJoin: true,
      room: room.provider_room_name,
      canPublish: sources(a.permissions).length > 0,
      canPublishSources: sources(a.permissions),
      canSubscribe: true,
      canPublishData: false,
    });
    await pool.query(
      'INSERT INTO voice_participants(id,voice_session_id,user_id,provider_participant_identity,auth_session_id) VALUES($1,$2,$3,$4,$5)',
      [participantId, room.id, req.user.sub, identity, req.user.sid],
    );
    const preferences = (
      await pool.query('SELECT * FROM user_voice_preferences WHERE user_id=$1', [req.user.sub])
    ).rows;
    return {
      token: await token.toJwt(),
      url: config.LIVEKIT_URL,
      iceServers: turnCredentials(req.user.sub),
      sessionId: room.id,
      participantId,
      identity,
      preferences,
      permissions: a.permissions.toString(),
    };
  });
  app.post('/api/voice/:id/leave', async (req) => {
    const p = (
      await pool.query(
        'SELECT p.*,s.provider_room_name FROM voice_participants p JOIN voice_sessions s ON s.id=p.voice_session_id WHERE p.id=$1 AND p.user_id=$2',
        [param(req.params), req.user.sub],
      )
    ).rows[0];
    if (p) {
      await roomService()
        .removeParticipant(p.provider_room_name, p.provider_participant_identity)
        .catch(() => {});
      await finishParticipant(p.provider_participant_identity);
    }
    return { ok: true };
  });
  app.patch('/api/voice/:id/self', async (req) => {
    const body = z.object({ muted: z.boolean(), deafened: z.boolean() }).parse(req.body),
      p = (
        await pool.query(
          'SELECT p.*,s.channel_id FROM voice_participants p JOIN voice_sessions s ON s.id=p.voice_session_id WHERE p.id=$1 AND p.user_id=$2 AND p.left_at IS NULL',
          [param(req.params), req.user.sub],
        )
      ).rows[0];
    ensure(p, 404, 'Você não está nesta chamada.');
    await channelAccess(req.user.sub, p.channel_id, P.CONNECT);
    await pool.query('UPDATE voice_participants SET self_muted=$2,self_deafened=$3 WHERE id=$1', [
      p.id,
      body.muted,
      body.deafened,
    ]);
    await tx((db) => event(db, 'voice.changed', p.voice_session_id, { channelId: p.channel_id }));
    return { ok: true };
  });
  app.put('/api/me/voice/:id', async (req) => {
    const target = param(req.params),
      body = z
        .object({ volume: z.number().min(0).max(2), muted_locally: z.boolean() })
        .parse(req.body);
    ensure(target !== req.user.sub, 400, 'Escolha outro participante.');
    await pool.query(
      'INSERT INTO user_voice_preferences(user_id,target_user_id,volume,muted_locally) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,target_user_id) DO UPDATE SET volume=EXCLUDED.volume,muted_locally=EXCLUDED.muted_locally,updated_at=now()',
      [req.user.sub, target, body.volume, body.muted_locally],
    );
    return { ok: true };
  });
  app.post('/api/voice/:id/moderate', async (req) => {
    const p = (
      await pool.query(
        'SELECT p.*,s.channel_id,s.provider_room_name,c.guild_id FROM voice_participants p JOIN voice_sessions s ON s.id=p.voice_session_id JOIN channels c ON c.id=s.channel_id WHERE p.id=$1 AND p.left_at IS NULL',
        [param(req.params)],
      )
    ).rows[0];
    ensure(p, 404, 'Participante não encontrado.');
    const body = z
      .object({
        muted: z.boolean().optional(),
        deafened: z.boolean().optional(),
        moveTo: z.uuid().optional(),
      })
      .parse(req.body);
    const a = await channelAccess(
      req.user.sub,
      p.channel_id,
      body.moveTo
        ? P.MOVE_MEMBERS
        : body.deafened !== undefined
          ? P.DEAFEN_MEMBERS
          : P.MUTE_MEMBERS,
    );
    ensure(
      a.member.owner_id !== p.user_id || p.user_id === req.user.sub,
      403,
      'O dono do servidor é protegido.',
    );
    if (a.member.owner_id !== req.user.sub && p.user_id !== req.user.sub) {
      const target = await guildAccess(p.user_id, p.guild_id);
      ensure(
        Math.max(...target.roles.map((r) => r.position), 0) <
          Math.max(...a.member.roles.map((r) => r.position), 0),
        403,
        'Esse membro está acima da sua hierarquia.',
      );
    }
    if (body.moveTo) {
      const target = await channelAccess(p.user_id, body.moveTo, P.CONNECT);
      ensure(
        target.channel.guild_id === p.guild_id && ['voice', 'video'].includes(target.channel.type),
        400,
        'Canal de destino inválido.',
      );
      await roomService().removeParticipant(p.provider_room_name, p.provider_participant_identity);
      await finishParticipant(p.provider_participant_identity);
      await tx((db) =>
        event(db, 'voice.move', p.user_id, {
          userId: p.user_id,
          channelId: body.moveTo,
          guildId: p.guild_id,
        }),
      );
    } else {
      const muted = body.muted ?? (body.deafened === true ? true : p.server_muted),
        deafened = body.deafened ?? p.server_deafened;
      await pool.query(
        'UPDATE voice_participants SET server_muted=$2,server_deafened=$3 WHERE id=$1',
        [p.id, muted, deafened],
      );
      const own = await channelAccess(p.user_id, p.channel_id, P.CONNECT);
      await roomService().updateParticipant(p.provider_room_name, p.provider_participant_identity, {
        permission: {
          canSubscribe: !deafened,
          canPublish: !muted,
          canPublishData: false,
          canPublishSources: sources(own.permissions, muted),
        },
      });
      if (muted) {
        const state = await roomService().getParticipant(
          p.provider_room_name,
          p.provider_participant_identity,
        );
        for (const t of state.tracks)
          if (t.source === TrackSource.MICROPHONE)
            await roomService().mutePublishedTrack(
              p.provider_room_name,
              p.provider_participant_identity,
              t.sid,
              true,
            );
      }
    }
    await tx(async (db) => {
      await audit(db, p.guild_id, req.user.sub, 'voice.moderate', p.user_id);
      await event(db, 'voice.changed', p.voice_session_id, {
        guildId: p.guild_id,
        channelId: p.channel_id,
      });
    });
    return { ok: true };
  });
  app.post('/api/voice/:id/soundboard', async (req) => {
    const body = z.object({ soundId: z.uuid(), clientNonce: z.uuid() }).parse(req.body),
      p = (
        await pool.query(
          'SELECT p.*,s.channel_id,c.guild_id FROM voice_participants p JOIN voice_sessions s ON s.id=p.voice_session_id JOIN channels c ON c.id=s.channel_id WHERE p.id=$1 AND p.user_id=$2 AND p.left_at IS NULL AND p.connected_at IS NOT NULL',
          [param(req.params), req.user.sub],
        )
      ).rows[0];
    ensure(p && !p.server_muted, 403, 'Entre no canal com permissão para falar.');
    await channelAccess(req.user.sub, p.channel_id, P.USE_SOUNDBOARD | P.SPEAK);
    const sound = (
      await pool.query(
        'SELECT * FROM custom_sound_effects WHERE id=$1 AND guild_id=$2 AND deleted_at IS NULL',
        [body.soundId, p.guild_id],
      )
    ).rows[0];
    ensure(sound, 404, 'Efeito não disponível.');
    await pool.query(
      'INSERT INTO soundboard_events(voice_session_id,sound_effect_id,triggered_by,client_nonce) VALUES($1,$2,$3,$4) ON CONFLICT(triggered_by,client_nonce) DO NOTHING',
      [p.voice_session_id, sound.id, req.user.sub, body.clientNonce],
    );
    return { sound };
  });
}
export async function reconcileVoice(app: FastifyInstance) {
  if (!config.LIVEKIT_API_KEY) return;
  const rows = (
    await pool.query(
      'SELECT p.*,s.provider_room_name,s.channel_id FROM voice_participants p JOIN voice_sessions s ON s.id=p.voice_session_id WHERE p.left_at IS NULL',
    )
  ).rows;
  for (const p of rows) {
    let access;
    try {
      access = await channelAccess(p.user_id, p.channel_id, P.CONNECT);
      ensure(await validSession(p.auth_session_id, p.user_id), 401, 'Sessão encerrada.');
      ensure(
        !access.member.timeout_until ||
          new Date(access.member.timeout_until).getTime() < Date.now(),
        403,
        'Timeout.',
      );
    } catch {
      await roomService()
        .removeParticipant(p.provider_room_name, p.provider_participant_identity)
        .catch(() => {});
      await finishParticipant(p.provider_participant_identity);
      continue;
    }
    try {
      const actual = await roomService().getParticipant(
        p.provider_room_name,
        p.provider_participant_identity,
      );
      if (!p.connected_at)
        await pool.query('UPDATE voice_participants SET connected_at=now() WHERE id=$1', [p.id]);
      await roomService().updateParticipant(p.provider_room_name, p.provider_participant_identity, {
        permission: {
          canPublish: !p.server_muted,
          canSubscribe: !p.server_deafened,
          canPublishData: false,
          canPublishSources: sources(access.permissions, p.server_muted),
        },
      });
    } catch (error) {
      const code = (error as { code?: string; status?: number }).code;
      if (
        code === 'not_found' &&
        (p.connected_at || Date.now() - new Date(p.joined_at).getTime() > 90000)
      )
        await finishParticipant(p.provider_participant_identity);
      else if (code !== 'not_found')
        app.log.warn('SFU temporariamente indisponível; estado preservado para reconciliação.');
    }
  }
}
export function startVoiceReconciliation(app: FastifyInstance) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await reconcileVoice(app);
    } catch {
      app.log.warn('Reconciliação de mídia pendente.');
    } finally {
      running = false;
    }
  }, 15000);
  return async () => {
    clearInterval(timer);
    while (running) await new Promise((r) => setTimeout(r, 20));
  };
}
