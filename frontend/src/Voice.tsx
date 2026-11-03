import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import {
  Room,
  RoomEvent,
  Track,
  LocalAudioTrack,
  type Participant,
  type RemoteAudioTrack,
  type RemoteTrack,
  type LocalTrack,
  type RemoteTrackPublication,
} from 'livekit-client';
import {
  Camera,
  CameraOff,
  Headphones,
  Maximize,
  Mic,
  MicOff,
  Monitor,
  PhoneOff,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { api, post } from './api';
import { Avatar, IconButton } from './ui';
import { useStore } from './store';
import type { Catalog, Channel, Expression } from './types';
type VoiceState = {
  room: Room | null;
  channel: Channel | null;
  participantId: string | null;
  connecting: boolean;
  muted: boolean;
  deafened: boolean;
  version: number;
  speaking: string[];
  error: string;
  permissions: string;
  preferences: Record<string, { volume: number; muted_locally: boolean }>;
};
export const useVoice = create<VoiceState>(() => ({
  room: null,
  channel: null,
  participantId: null,
  connecting: false,
  muted: true,
  deafened: false,
  version: 0,
  speaking: [],
  error: '',
  permissions: '0',
  preferences: {},
}));
const audios = new Set<HTMLMediaElement>();
let meter: AudioContext | null = null,
  meterFrame = 0;
function changed() {
  useVoice.setState((s) => ({ version: s.version + 1 }));
}
export async function leaveVoice() {
  const state = useVoice.getState();
  useVoice.setState({
    room: null,
    channel: null,
    participantId: null,
    connecting: false,
    muted: true,
    deafened: false,
    speaking: [],
  });
  if (state.room) await state.room.disconnect();
  for (const a of audios) {
    a.pause();
    a.remove();
  }
  audios.clear();
  cancelAnimationFrame(meterFrame);
  if (meter) {
    await meter.close();
    meter = null;
  }
  if (state.participantId) await post(`/voice/${state.participantId}/leave`).catch(() => {});
  void playNotificationSound('call_leave');
}
function applyVolumes() {
  const state = useVoice.getState();
  for (const participant of state.room?.remoteParticipants.values() ?? []) {
    const userId = participant.identity.split(':')[0],
      pref = state.preferences[userId];
    for (const pub of participant.audioTrackPublications.values())
      if (pub.track)
        (pub.track as RemoteAudioTrack).setVolume(
          state.deafened || pref?.muted_locally ? 0 : (pref?.volume ?? 1),
        );
  }
}
export async function joinVoice(channel: Channel) {
  if (useVoice.getState().connecting) return;
  if (useVoice.getState().channel?.id === channel.id) return;
  await leaveVoice();
  useVoice.setState({ channel, connecting: true, error: '' });
  let participantId: string | undefined;
  try {
    const result = await post<{
      token: string;
      url: string;
      iceServers: RTCIceServer[];
      participantId: string;
      permissions: string;
      preferences: Array<{ target_user_id: string; volume: number; muted_locally: boolean }>;
    }>(`/channels/${channel.id}/voice/join`);
    participantId = result.participantId;
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      webAudioMix: true,
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const preferences = Object.fromEntries(
      result.preferences.map((p) => [
        p.target_user_id,
        { volume: p.volume, muted_locally: p.muted_locally },
      ]),
    );
    useVoice.setState({ room, participantId, permissions: result.permissions, preferences });
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Audio) {
        const audio = track.attach() as HTMLAudioElement;
        audio.hidden = true;
        document.body.appendChild(audio);
        audios.add(audio);
        applyVolumes();
      }
      changed();
    });
    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      for (const element of track.detach()) {
        audios.delete(element);
        element.remove();
      }
      changed();
    });
    for (const e of [
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected,
      RoomEvent.TrackPublished,
      RoomEvent.TrackUnpublished,
      RoomEvent.LocalTrackPublished,
      RoomEvent.LocalTrackUnpublished,
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
      RoomEvent.ParticipantPermissionsChanged,
    ])
      room.on(e, changed);
    room.on(RoomEvent.ActiveSpeakersChanged, (participants) =>
      useVoice.setState({ speaking: participants.map((p) => p.identity) }),
    );
    room.on(RoomEvent.Disconnected, (reason) => {
      console.info('Tetocord mídia: desconexão', reason);
      if (useVoice.getState().room === room) {
        useVoice.setState({
          error: 'A chamada foi encerrada.',
          room: null,
          channel: null,
          participantId: null,
        });
        for (const audio of audios) audio.remove();
        audios.clear();
      }
    });
    await room.connect(result.url, result.token, {
      rtcConfig: {
        iceServers: result.iceServers,
        iceTransportPolicy:
          new URLSearchParams(location.search).get('forceRelay') === '1' ? 'relay' : 'all',
      },
    });
    await room.startAudio();
    if ((BigInt(result.permissions) & (1n << 16n)) !== 0n) {
      try {
        await room.localParticipant.setMicrophoneEnabled(true);
        useVoice.setState({ muted: false });
        startMeter(room);
      } catch {
        useVoice.setState({
          muted: true,
          error: 'Microfone indisponível. Você pode continuar ouvindo.',
        });
      }
    }
    if (channel.type === 'video' && (BigInt(result.permissions) & (1n << 17n)) !== 0n)
      await room.localParticipant
        .setCameraEnabled(true)
        .catch(() => useVoice.setState({ error: 'Câmera indisponível.' }));
    useVoice.setState({ connecting: false });
    changed();
    void playNotificationSound('call_join');
  } catch (e) {
    await leaveVoice();
    if (participantId) await post(`/voice/${participantId}/leave`).catch(() => {});
    useVoice.setState({ error: (e as Error).message, connecting: false });
    useStore.getState().notify((e as Error).message);
  }
}
function startMeter(room: Room) {
  cancelAnimationFrame(meterFrame);
  if (meter) void meter.close();
  const mic = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
  if (!mic) return;
  meter = new AudioContext();
  const analyser = meter.createAnalyser();
  analyser.fftSize = 256;
  meter.createMediaStreamSource(new MediaStream([mic.mediaStreamTrack])).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let last = false;
  const tick = () => {
    if (!meter || useVoice.getState().room !== room) return;
    analyser.getFloatTimeDomainData(samples);
    const speaking =
      Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / samples.length) > 0.025 &&
      !useVoice.getState().muted;
    if (speaking !== last) {
      last = speaking;
      useVoice.setState((s) => ({
        speaking: [
          ...s.speaking.filter((id) => id !== room.localParticipant.identity),
          ...(speaking ? [room.localParticipant.identity] : []),
        ],
      }));
    }
    meterFrame = requestAnimationFrame(tick);
  };
  tick();
}
export async function toggleMic() {
  const state = useVoice.getState();
  if (!state.room) return;
  try {
    const muted = !state.muted;
    await state.room.localParticipant.setMicrophoneEnabled(!muted);
    useVoice.setState({ muted });
    if (!muted) startMeter(state.room);
    if (state.participantId)
      await api(`/voice/${state.participantId}/self`, {
        method: 'PATCH',
        body: JSON.stringify({ muted, deafened: state.deafened }),
      });
  } catch (e) {
    useStore.getState().notify((e as Error).message);
  }
}
export async function toggleDeafen() {
  const state = useVoice.getState();
  if (!state.room) return;
  const deafened = !state.deafened;
  if (deafened && !state.muted) await toggleMic();
  useVoice.setState({ deafened });
  applyVolumes();
  if (state.participantId)
    await api(`/voice/${state.participantId}/self`, {
      method: 'PATCH',
      body: JSON.stringify({ muted: useVoice.getState().muted, deafened }),
    });
}
export async function playNotificationSound(event: 'message' | 'call_join' | 'call_leave') {
  try {
    const user = useStore.getState().user;
    if (!user || user.preferred_status === 'dnd') return;
    const settings = await api<{
      preferences: { sound_enabled: boolean; quiet_hours_enabled: boolean };
      schedules: Array<{ weekday: number; start_local: string; end_local: string }>;
      sounds: Array<{ event: string; asset_id: string | null; enabled: boolean; volume: number }>;
    }>('/me/notification-settings');
    if (!settings.preferences.sound_enabled) return;
    if (settings.preferences.quiet_hours_enabled) {
      const zone = user.preferences.timezone ?? 'UTC',
        parts = new Intl.DateTimeFormat('en-US', {
          timeZone: zone,
          weekday: 'short',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).formatToParts(new Date()),
        get = (t: string) => parts.find((p) => p.type === t)?.value ?? '',
        day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')) + 1,
        time = `${get('hour')}:${get('minute')}:00`;
      if (
        settings.schedules.some(
          (s) => s.weekday === day && s.start_local <= time && time < s.end_local,
        )
      )
        return;
    }
    const custom = settings.sounds.find((s) => s.event === event);
    if (custom?.enabled === false) return;
    if (custom?.asset_id) {
      const audio = new Audio(`/api/media/${custom.asset_id}`);
      audio.volume = custom.volume;
      await audio.play();
      return;
    }
    const ctx = new AudioContext();
    const osc = ctx.createOscillator(),
      gain = ctx.createGain();
    osc.frequency.value = event === 'message' ? 740 : event === 'call_join' ? 880 : 440;
    gain.gain.setValueAtTime(0.045, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.16);
    osc.onended = () => void ctx.close();
  } catch {
    /* Autoplay/permissions may require another user gesture. */
  }
}
export function VoiceMiniPanel() {
  const state = useVoice();
  return state.channel ? (
    <div className="voice-panel live">
      <div>
        <strong>● {state.connecting ? 'Conectando…' : 'Voz conectada'}</strong>
        <span>{state.channel.name}</span>
      </div>
      <IconButton
        label={state.muted ? 'Ativar microfone' : 'Silenciar microfone'}
        onClick={() => void toggleMic()}
      >
        {state.muted ? <MicOff size={16} /> : <Mic size={16} />}
      </IconButton>
      <IconButton
        label={state.deafened ? 'Voltar a ouvir' : 'Ensurdecer'}
        onClick={() => void toggleDeafen()}
      >
        {state.deafened ? <VolumeX size={16} /> : <Headphones size={16} />}
      </IconButton>
      <IconButton label="Sair da chamada" onClick={() => void leaveVoice()}>
        <PhoneOff size={16} />
      </IconButton>
    </div>
  ) : (
    <div className="voice-panel">
      <Headphones size={18} />
      <div>
        <strong>Vamos colocar o papo em dia?</strong>
        <span>Escolha um canal de voz.</span>
      </div>
    </div>
  );
}
function VideoTile({ track, name, local }: { track: Track; name: string; local: boolean }) {
  const ref = useRef<HTMLVideoElement>(null),
    box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) track.attach(ref.current);
    return () => {
      if (ref.current) track.detach(ref.current);
    };
  }, [track]);
  return (
    <div className="video-tile" ref={box}>
      <video ref={ref} autoPlay playsInline muted={local} />
      <span>{name}</span>
      <IconButton
        label={`Tela cheia: ${name}`}
        onClick={() => void box.current?.requestFullscreen()}
      >
        <Maximize size={18} />
      </IconButton>
    </div>
  );
}
export function VoiceRoomPanel({ channel }: { channel: Channel }) {
  const state = useVoice(),
    [resolution, setResolution] = useState(1080),
    [fps, setFps] = useState(30),
    [catalog, setCatalog] = useState<Catalog>({ emoji: [], sticker: [], sound: [] }),
    [soundOpen, setSoundOpen] = useState(false),
    [playing, setPlaying] = useState(false),
    [shortcuts, setShortcuts] = useState<Array<{ sound_effect_id: string; shortcut: string }>>([]);
  const same = state.channel?.id === channel.id,
    room = same ? state.room : null;
  const [voiceRecords, setVoiceRecords] = useState<
      Array<{ id: string; user_id: string; server_muted: boolean; server_deafened: boolean }>
    >([]),
    [voiceChannels, setVoiceChannels] = useState<Channel[]>([]);
  useEffect(() => {
    if (!channel.guild_id) return;
    let active = true;
    const load = () => {
      void api<{ rooms: Array<{ channel_id: string; participants: typeof voiceRecords }> }>(
        `/guilds/${channel.guild_id}/voice`,
      )
        .then((r) => {
          if (active)
            setVoiceRecords(
              r.rooms.find((room) => room.channel_id === channel.id)?.participants ?? [],
            );
        })
        .catch(() => {});
    };
    load();
    void api<{ channels: Channel[] }>(`/guilds/${channel.guild_id}/channels`)
      .then((r) => {
        if (active) setVoiceChannels(r.channels.filter((c) => ['voice', 'video'].includes(c.type)));
      })
      .catch(() => {});
    const timer = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [channel.guild_id, channel.id, state.version]);
  async function moderate(id: string, body: object) {
    try {
      await post(`/voice/${id}/moderate`, body);
      changed();
    } catch (e) {
      useStore.getState().notify((e as Error).message);
    }
  }
  useEffect(() => {
    if (channel.guild_id)
      void api<Catalog>(`/guilds/${channel.guild_id}/catalog`)
        .then(setCatalog)
        .catch(() => {});
    void api<{ shortcuts: typeof shortcuts }>('/me/soundboard')
      .then((r) => setShortcuts(r.shortcuts))
      .catch(() => {});
  }, [channel.guild_id, soundOpen]);
  async function camera() {
    try {
      if (room)
        await room.localParticipant.setCameraEnabled(!room.localParticipant.isCameraEnabled);
      changed();
    } catch (e) {
      useStore.getState().notify((e as Error).message);
    }
  }
  async function screen() {
    try {
      if (room)
        await room.localParticipant.setScreenShareEnabled(
          !room.localParticipant.isScreenShareEnabled,
          {
            audio: true,
            resolution: {
              width: Math.round((resolution * 16) / 9),
              height: resolution,
              frameRate: fps,
            },
          },
          {
            screenShareEncoding: {
              maxBitrate: resolution >= 2160 ? 24000000 : resolution >= 1440 ? 14000000 : 8000000,
              maxFramerate: fps,
            },
          },
        );
      changed();
    } catch (e) {
      useStore.getState().notify((e as Error).message);
    }
  }
  async function sound(effect: Expression) {
    if (!room || !state.participantId || playing) return;
    setPlaying(true);
    let ctx: AudioContext | undefined, track: LocalAudioTrack | undefined;
    try {
      await post(`/voice/${state.participantId}/soundboard`, {
        soundId: effect.id,
        clientNonce: crypto.randomUUID(),
      });
      const response = await fetch(`/api/media/${effect.asset_id}`, { credentials: 'include' });
      if (!response.ok) throw new Error('Efeito indisponível.');
      ctx = new AudioContext();
      await ctx.resume();
      const buffer = await ctx.decodeAudioData(await response.arrayBuffer()),
        source = ctx.createBufferSource(),
        gain = ctx.createGain(),
        destination = ctx.createMediaStreamDestination();
      source.buffer = buffer;
      gain.gain.value = effect.volume ?? 1;
      source.connect(gain).connect(destination);
      if (!state.deafened) gain.connect(ctx.destination);
      track = new LocalAudioTrack(destination.stream.getAudioTracks()[0], undefined, true);
      await room.localParticipant.publishTrack(track, {
        source: Track.Source.Microphone,
        name: `soundboard-${effect.id}`,
      });
      await new Promise<void>((resolve) => {
        source.onended = () => resolve();
        source.start();
      });
    } catch (e) {
      useStore.getState().notify((e as Error).message);
    } finally {
      if (track) await room?.localParticipant.unpublishTrack(track);
      if (ctx) await ctx.close();
      setPlaying(false);
    }
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea,[contenteditable=true]')) return;
      const combo = [
        e.ctrlKey ? 'Ctrl' : '',
        e.altKey ? 'Alt' : '',
        e.shiftKey ? 'Shift' : '',
        e.code,
      ]
        .filter(Boolean)
        .join('+');
      const effect = catalog.sound.find(
        (s) =>
          (shortcuts.find((k) => k.sound_effect_id === s.id)?.shortcut ?? s.default_shortcut) ===
          combo,
      );
      if (effect && same) {
        e.preventDefault();
        void sound(effect);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [catalog, shortcuts, room, playing, same]);
  const participants: Participant[] = room
      ? [room.localParticipant, ...room.remoteParticipants.values()]
      : [],
    videos = participants.flatMap((p) =>
      [...p.videoTrackPublications.values()].flatMap((pub) =>
        pub.track && !pub.isMuted
          ? [
              {
                track: pub.track,
                name: `${p.name ?? p.identity}${pub.source === Track.Source.ScreenShare ? ' · tela' : ''}`,
                local: p === room?.localParticipant,
              },
            ]
          : [],
      ),
    );
  async function volume(userId: string, value: number) {
    useVoice.setState((s) => ({
      preferences: { ...s.preferences, [userId]: { volume: value, muted_locally: value === 0 } },
    }));
    applyVolumes();
    await api(`/me/voice/${userId}`, {
      method: 'PUT',
      body: JSON.stringify({ volume: value, muted_locally: value === 0 }),
    });
  }
  return (
    <div className="voice-room">
      <header>
        <div>
          <h1>
            <Headphones size={24} /> {channel.name}
          </h1>
          <p>Chega mais. A conversa fica melhor com você.</p>
        </div>
        {!same && (
          <button className="primary" onClick={() => void joinVoice(channel)}>
            Entrar no canal
          </button>
        )}
      </header>
      {state.error && <p className="error">{state.error}</p>}
      {same && state.connecting && <p className="muted">Conectando ao canal…</p>}
      <div className="video-grid">
        {videos.map((v) => (
          <VideoTile key={v.track.sid ?? v.name} {...v} />
        ))}
      </div>
      <div className="voice-people">
        {participants.map((p) => {
          const userId = p.identity.split(':')[0],
            local = p === room?.localParticipant;
          return (
            <div
              className={`voice-person ${state.speaking.includes(p.identity) ? 'speaking' : ''}`}
              key={p.identity}
            >
              <Avatar user={{ username: p.name ?? 'Amigo' }} size={65} />
              <strong>
                {p.name}
                {local ? ' (você)' : ''}
              </strong>
              <span>
                {p.isMicrophoneEnabled ? <Mic size={13} /> : <MicOff size={13} />}{' '}
                {p.isCameraEnabled && <Camera size={13} />}{' '}
                {p.isScreenShareEnabled && <Monitor size={13} />}
              </span>
              {!local && voiceRecords.find((record) => record.user_id === userId) && (
                <div className="voice-moderation">
                  {(BigInt(state.permissions) & (1n << 19n)) !== 0n && (
                    <button
                      aria-label={`Silenciar ${p.name}`}
                      title="Alternar mute de moderação"
                      onClick={() => {
                        const record = voiceRecords.find((r) => r.user_id === userId)!;
                        void moderate(record.id, { muted: !record.server_muted });
                      }}
                    >
                      <MicOff size={13} />
                    </button>
                  )}
                  {(BigInt(state.permissions) & (1n << 20n)) !== 0n && (
                    <button
                      aria-label={`Ensurdecer ${p.name}`}
                      title="Alternar deafen de moderação"
                      onClick={() => {
                        const record = voiceRecords.find((r) => r.user_id === userId)!;
                        void moderate(record.id, { deafened: !record.server_deafened });
                      }}
                    >
                      <VolumeX size={13} />
                    </button>
                  )}
                  {(BigInt(state.permissions) & (1n << 21n)) !== 0n && (
                    <select
                      aria-label={`Mover ${p.name}`}
                      value=""
                      onChange={(e) => {
                        if (e.target.value)
                          void moderate(voiceRecords.find((r) => r.user_id === userId)!.id, {
                            moveTo: e.target.value,
                          });
                      }}
                    >
                      <option value="">Mover para…</option>
                      {voiceChannels
                        .filter((c) => c.id !== channel.id)
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                    </select>
                  )}
                </div>
              )}
              {!local && (
                <label className="participant-volume">
                  <Volume2 size={13} />
                  <input
                    type="range"
                    min="0"
                    max="200"
                    aria-label={`Volume de ${p.name}`}
                    defaultValue={(state.preferences[userId]?.volume ?? 1) * 100}
                    onChange={(e) => {
                      useVoice.setState((s) => ({
                        preferences: {
                          ...s.preferences,
                          [userId]: {
                            volume: Number(e.target.value) / 100,
                            muted_locally: Number(e.target.value) === 0,
                          },
                        },
                      }));
                      applyVolumes();
                    }}
                    onPointerUp={(e) =>
                      void volume(userId, Number((e.target as HTMLInputElement).value) / 100)
                    }
                  />
                </label>
              )}
            </div>
          );
        })}
      </div>
      {same && room && (
        <>
          <div className="voice-controls">
            <IconButton
              label={state.muted ? 'Ativar microfone' : 'Silenciar microfone'}
              onClick={() => void toggleMic()}
            >
              {state.muted ? <MicOff /> : <Mic />}
            </IconButton>
            <IconButton
              label={state.deafened ? 'Voltar a ouvir' : 'Ensurdecer'}
              onClick={() => void toggleDeafen()}
            >
              {state.deafened ? <VolumeX /> : <Headphones />}
            </IconButton>
            <IconButton label="Alternar câmera" onClick={() => void camera()}>
              {room.localParticipant.isCameraEnabled ? <Camera /> : <CameraOff />}
            </IconButton>
            <IconButton label="Compartilhar tela" onClick={() => void screen()}>
              <Monitor />
            </IconButton>
            <button className="secondary" onClick={() => setSoundOpen(!soundOpen)}>
              Soundboard
            </button>
            <IconButton label="Sair da chamada" onClick={() => void leaveVoice()}>
              <PhoneOff />
            </IconButton>
          </div>
          <div className="stream-options">
            <label>
              Resolução
              <select
                aria-label="Resolução da tela"
                value={resolution}
                onChange={(e) => setResolution(Number(e.target.value))}
              >
                {[720, 1080, 1440, 2160].map((r) => (
                  <option key={r} value={r}>
                    {r === 2160 ? '4K' : `${r}p`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Quadros por segundo
              <select
                aria-label="FPS da tela"
                value={fps}
                onChange={(e) => setFps(Number(e.target.value))}
              >
                {[15, 30, 60].map((n) => (
                  <option key={n} value={n}>
                    {n} fps
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="field-note">
            A seleção de tela, janela ou aba é feita pelo navegador. O áudio do sistema depende do
            suporte dele.
          </p>
          {soundOpen && (
            <div className="soundboard">
              {catalog.sound.map((effect) => (
                <div key={effect.id}>
                  <button
                    className="secondary"
                    disabled={playing}
                    onClick={() => void sound(effect)}
                  >
                    🔊 {effect.name}
                  </button>
                  <small>{effect.category}</small>
                  <input
                    aria-label={`Atalho de ${effect.name}`}
                    placeholder="Ex.: Alt+Digit1"
                    defaultValue={
                      shortcuts.find((s) => s.sound_effect_id === effect.id)?.shortcut ??
                      effect.default_shortcut ??
                      ''
                    }
                    onBlur={(e) => {
                      if (e.target.value)
                        void api(`/me/soundboard/${effect.id}`, {
                          method: 'PUT',
                          body: JSON.stringify({ shortcut: e.target.value }),
                        }).catch((err) => useStore.getState().notify(err.message));
                    }}
                  />
                </div>
              ))}
              {!catalog.sound.length && (
                <p className="muted">O servidor ainda não tem efeitos sonoros.</p>
              )}
            </div>
          )}
        </>
      )}
      {!participants.length && !state.connecting && (
        <div className="voice-empty">
          ☕<p>Tem uma cadeira esperando por você.</p>
        </div>
      )}
    </div>
  );
}
