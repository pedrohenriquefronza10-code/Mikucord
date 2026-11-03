import {
  VoiceMiniPanel,
  VoiceRoomPanel,
  joinVoice,
  leaveVoice,
  playNotificationSound,
} from './Voice';
import { DirectSidebar, SocialPanel } from './Social';
import { PreferencesDialog } from './Preferences';
import { ServerDialog, SearchDialog } from './Administration';
import { ForumPanel } from './Forum';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { io, type Socket } from 'socket.io-client';
import {
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  Compass,
  Hash,
  Headphones,
  Heart,
  HelpCircle,
  LogOut,
  Menu,
  MessageCircle,
  Plus,
  Search,
  Settings,
  Shield,
  Signal,
  Sparkles,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { api, patch, post, refreshSession, ApiError } from './api';
import { useStore } from './store';
import { Auth } from './Auth';
import { Chat } from './Chat';
import { Avatar, IconButton, Mark, Modal, Spinner } from './ui';
import {
  ChannelDialog,
  GuildDialog,
  InviteDialog,
  ProfileDialog,
  RolesDialog,
  SettingsDialog,
} from './Dialogs';
import type { Channel, Guild, Member, Notice, Role, User } from './types';
const statusLabels: Record<string, string> = {
  online: 'Online',
  idle: 'Ausente',
  dnd: 'Não perturbe',
  invisible: 'Invisível',
  offline: 'Offline',
};
function GuildBanner() {
  return (
    <div className="guild-banner">
      <svg viewBox="0 0 250 125" aria-hidden="true">
        <defs>
          <linearGradient id="hills" x2="1" y2="1">
            <stop stopColor="#71588c" />
            <stop offset="1" stopColor="#3a344c" />
          </linearGradient>
        </defs>
        <rect width="250" height="125" fill="#373044" />
        <circle cx="181" cy="39" r="24" fill="#c7afda" />
        <circle cx="173" cy="33" r="23" fill="#373044" />
        <path d="M0 90 53 41l54 54 41-36 76 65H0Z" fill="#594768" />
        <path d="m74 125 61-50 31 24 51-44 41 70Z" fill="url(#hills)" />
        <path d="m20 102 3-12 3 12m-4-6h4m196 5 4-14 4 14m-7-5h6" stroke="#b1a0ba" />
        <g fill="#dfcae9">
          <path d="m29 28 2-5 2 5 5 2-5 2-2 5-2-5-5-2Z" />
          <path d="m221 28 1-3 1 3 3 1-3 1-1 3-1-3-3-1Z" />
          <circle cx="112" cy="22" r="1.5" />
          <circle cx="78" cy="38" r="1" />
        </g>
      </svg>
      <span className="banner-caption">
        <Sparkles size={12} /> UM LUGAR SÓ NOSSO
      </span>
    </div>
  );
}
export function App() {
  const {
    user,
    setUser,
    guildId,
    channelId,
    selectGuild,
    selectChannel,
    notify,
    toast,
    mode,
    selectHome,
    selectConversation,
    focusMessageId,
    focusMessage,
  } = useStore();
  const [boot, setBoot] = useState(true),
    [guilds, setGuilds] = useState<Guild[]>([]),
    [channels, setChannels] = useState<Channel[]>([]),
    [members, setMembers] = useState<Member[]>([]),
    [roles, setRoles] = useState<Role[]>([]),
    [notices, setNotices] = useState<Notice[]>([]),
    [dataTick, setDataTick] = useState(0),
    [messageTick, setMessageTick] = useState(0),
    [memberTick, setMemberTick] = useState(0),
    [socket, setSocket] = useState<Socket | null>(null),
    [connected, setConnected] = useState(false),
    [dialog, setDialog] = useState(''),
    [profile, setProfile] = useState<Member | null>(null),
    [guildMenu, setGuildMenu] = useState(false),
    [notificationsOpen, setNotificationsOpen] = useState(false),
    [showSearch, setShowSearch] = useState(false),
    [search, setSearch] = useState(''),
    [mobileNav, setMobileNav] = useState(false),
    [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [voiceTick, setVoiceTick] = useState(0),
    [voiceRooms, setVoiceRooms] = useState<
      Array<{
        channel_id: string;
        participants: Array<{
          id: string;
          user_id: string;
          username: string;
          avatar_asset_id: string | null;
          self_muted: boolean;
          tracks: string[];
        }>;
      }>
    >([]);
  const [dmChannel, setDmChannel] = useState<Channel | null>(null);
  const inviteProcessed = useRef(false),
    currentChannel = useRef(channelId);
  currentChannel.current = channelId;
  useEffect(() => {
    let active = true;
    void api<{ user: User }>('/me')
      .then((r) => {
        if (active) setUser(r.user);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setBoot(false);
      });
    return () => {
      active = false;
    };
  }, [setUser]);
  useEffect(() => {
    const expired = () => {
      setUser(null);
      setGuilds([]);
      notify('Sua sessão terminou. Entre novamente.');
    };
    window.addEventListener('session.expired', expired);
    return () => window.removeEventListener('session.expired', expired);
  }, [setUser, notify]);
  useEffect(() => {
    const preferences = user?.preferences;
    document.documentElement.dataset.theme =
      preferences?.theme_mode === 'custom'
        ? (preferences.base_mode ?? 'dark')
        : (preferences?.theme_mode ?? 'dark');
    const root = document.documentElement;
    for (const key of [
      '--accent',
      '--accent-solid',
      '--sidebar',
      '--bg',
      '--surface',
      '--text',
      '--rail',
      '--member',
      '--input',
    ])
      root.style.removeProperty(key);
    if (preferences?.theme_mode === 'custom' && preferences.palette) {
      const p = preferences.palette;
      for (const [key, value] of Object.entries({
        '--accent': p.accent,
        '--accent-solid': p.primary,
        '--sidebar': p.secondary,
        '--bg': p.background,
        '--surface': p.surface,
        '--text': p.text,
        '--rail': p.secondary,
        '--member': p.secondary,
        '--input': p.background,
      }))
        root.style.setProperty(key, value);
    }
  }, [user?.preferences]);
  const reload = useCallback(() => setDataTick((n) => n + 1), []);
  useEffect(() => {
    if (!user) return;
    const s = io({ withCredentials: true, autoConnect: false });
    setSocket(s);
    let refreshing = false,
      disposed = false;
    const reconnect = async () => {
      if (refreshing || disposed) return;
      refreshing = true;
      try {
        if (await refreshSession()) {
          if (!disposed) s.connect();
        } else if (!disposed) setUser(null);
      } catch {
        if (!disposed) notify('Conexão interrompida. Vamos tentar novamente.');
      } finally {
        refreshing = false;
      }
    };
    s.on('connect', () => {
      setConnected(true);
      setMessageTick((n) => n + 1);
      reload();
      if (currentChannel.current) s.emit('channel.join', { channelId: currentChannel.current });
    });
    s.on('disconnect', (reason) => {
      setConnected(false);
      if (reason === 'io server disconnect') void reconnect();
    });
    s.on('connect_error', (error) => {
      setConnected(false);
      if (error.message === 'Sessão expirada.') void reconnect();
    });
    for (const name of ['message.created', 'message.updated', 'message.deleted'])
      s.on(name, (e: { channelId: string }) => {
        if (currentChannel.current === e.channelId) setMessageTick((n) => n + 1);
        else if (name === 'message.created') void playNotificationSound('message');
        setMemberTick((n) => n + 1);
      });
    s.on('guild.changed', reload);
    s.on('social.changed', reload);
    s.on('voice.changed', () => setVoiceTick((n) => n + 1));
    s.on('voice.move', (e: { userId: string; channelId: string }) => {
      if (e.userId === user.id)
        void api<{ channel: Channel }>(`/channels/${e.channelId}`).then((r) =>
          joinVoice(r.channel),
        );
    });
    s.on('presence.changed', () => setMemberTick((n) => n + 1));
    s.on('profile.updated', (e: { userId: string }) => {
      setMemberTick((n) => n + 1);
      if (e.userId === user.id)
        void api<{ user: User }>('/me')
          .then((r) => setUser(r.user))
          .catch(() => {});
    });
    s.connect();
    const poll = setInterval(() => {
      setMemberTick((n) => n + 1);
      if (!s.connected) void reconnect();
    }, 15_000);
    return () => {
      disposed = true;
      clearInterval(poll);
      s.disconnect();
      setSocket(null);
    };
  }, [user?.id, reload, setUser, notify]);
  useEffect(() => {
    if (!user) return;
    let active = true;
    void api<{ guilds: Guild[] }>('/guilds')
      .then((r) => {
        if (!active) return;
        setGuilds(r.guilds);
        if (useStore.getState().mode === 'guild' && !r.guilds.some((g) => g.id === guildId)) {
          if (r.guilds[0]) selectGuild(r.guilds[0].id);
          else {
            setChannels([]);
            setMembers([]);
            selectChannel(null);
          }
        }
      })
      .catch((e) => notify(e.message));
    return () => {
      active = false;
    };
  }, [user?.id, dataTick, guildId, selectGuild, selectChannel, notify]);
  useEffect(() => {
    if (!user || !guildId) return;
    let active = true;
    void api<{ channels: Channel[] }>(`/guilds/${guildId}/channels`)
      .then((r) => {
        if (!active) return;
        setChannels(r.channels);
        const selected = useStore.getState().channelId;
        if (!r.channels.some((c) => c.id === selected && c.type !== 'category'))
          selectChannel(r.channels.find((c) => c.type === 'text')?.id ?? null);
      })
      .catch((e) => {
        if (active) {
          if (e instanceof ApiError && [403, 404].includes(e.status)) setChannels([]);
          notify(e.message);
        }
      });
    void api<{ roles: Role[] }>(`/guilds/${guildId}/roles`)
      .then((r) => {
        if (active) setRoles(r.roles);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [user?.id, guildId, dataTick, selectChannel, notify]);
  useEffect(() => {
    if (!user || !guildId) return;
    let active = true;
    void api<{ members: Member[] }>(`/guilds/${guildId}/members`)
      .then((r) => {
        if (active) setMembers(r.members);
      })
      .catch(() => {});
    void api<{ notifications: Notice[] }>('/notifications')
      .then((r) => {
        if (active) setNotices(r.notifications);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [user?.id, guildId, dataTick, memberTick]);
  useEffect(() => {
    if (channelId) socket?.emit('channel.join', { channelId });
    setSearch('');
  }, [channelId, socket]);
  useEffect(() => {
    if (!user || inviteProcessed.current) return;
    const code = new URLSearchParams(location.search).get('invite');
    if (!code) return;
    inviteProcessed.current = true;
    void post<{ guild: Guild }>(`/invites/${encodeURIComponent(code)}/join`)
      .then((r) => {
        selectGuild(r.guild.id);
        reload();
        notify(`Você chegou ao ${r.guild.name}. Boas conversas!`);
        history.replaceState(null, '', location.pathname);
      })
      .catch((e) => notify(e.message));
  }, [user?.id, selectGuild, reload, notify]);
  useEffect(() => {
    if (!user || mode !== 'dm' || !channelId) return;
    let active = true;
    void api<{ channel: Channel; members: Member[] }>(`/conversations/${channelId}`)
      .then((r) => {
        if (active) {
          setDmChannel({
            ...r.channel,
            name:
              r.channel.type === 'dm'
                ? (r.members.find((m) => m.id !== user.id)?.username ?? r.channel.name)
                : r.channel.name,
          });
          setMembers(r.members);
          setRoles([]);
        }
      })
      .catch((e) => {
        if (active) {
          notify(e.message);
          selectHome();
        }
      });
    return () => {
      active = false;
    };
  }, [user?.id, mode, channelId, dataTick, memberTick]);
  useEffect(() => {
    if (!user) return;
    void api<{ notifications: Notice[] }>('/notifications')
      .then((r) => setNotices(r.notifications))
      .catch(() => {});
  }, [user?.id, dataTick, memberTick]);
  useEffect(() => {
    if (!user) return;
    const params = new URLSearchParams(location.search),
      c = params.get('channel'),
      g = params.get('guild');
    if (c && /^[0-9a-f-]{36}$/i.test(c)) {
      if (g) selectGuild(g);
      else selectConversation(c);
      selectChannel(c);
      history.replaceState(null, '', location.pathname);
    }
  }, [user?.id]);
  useEffect(() => {
    if (user && guildId)
      void api<{ rooms: typeof voiceRooms }>(`/guilds/${guildId}/voice`)
        .then((r) => setVoiceRooms(r.rooms))
        .catch(() => {});
    else setVoiceRooms([]);
  }, [user?.id, guildId, voiceTick, dataTick]);
  async function logout() {
    try {
      await leaveVoice();
      await post('/auth/logout');
      setUser(null);
      setGuilds([]);
      selectChannel(null);
      setDialog('');
    } catch (e) {
      notify((e as Error).message);
    }
  }
  const guild = guilds.find((g) => g.id === guildId),
    channel =
      mode === 'dm'
        ? dmChannel?.id === channelId
          ? dmChannel
          : null
        : channels.find((c) => c.id === channelId && c.type !== 'category'),
    canManage =
      guild?.owner_id === user?.id ||
      (BigInt(guild?.permissions ?? '0') &
        ((1n << 7n) | (1n << 8n) | (1n << 9n) | (1n << 23n) | (1n << 14n))) !==
        0n,
    online = members.filter((m) => m.status !== 'offline'),
    offline = members.filter((m) => m.status === 'offline');
  useEffect(() => {
    if (user?.preferences.theme_mode === 'custom') return;
    const root = document.documentElement;
    const p = user?.preferences.theme_mode === 'dark' ? guild?.visual_settings?.palette : undefined;
    const values = {
      '--accent': p?.accent,
      '--accent-solid': p?.primary,
      '--sidebar': p?.secondary,
      '--bg': p?.background,
      '--surface': p?.surface,
      '--text': p?.text,
      '--rail': p?.secondary,
      '--member': p?.secondary,
      '--input': p?.background,
    };
    for (const [key, value] of Object.entries(values)) {
      if (value) root.style.setProperty(key, value);
      else root.style.removeProperty(key);
    }
  }, [user?.preferences, guild?.visual_settings, guildId]);
  const chooseChannel = (c: Channel) => {
    selectChannel(c.id);
    if (c.type === 'voice' || c.type === 'video') void joinVoice(c);
    setMobileNav(false);
  };
  async function toggleMembers() {
    if (!user) return;
    try {
      const r = await patch<{ user: User }>('/me/preferences', {
        show_member_list: !user.preferences.show_member_list,
      });
      setUser(r.user);
    } catch (e) {
      notify((e as Error).message);
    }
  }
  const renderChannel = (c: Channel) => (
    <button
      className={`channel-link ${c.id === channelId ? 'selected' : ''}`}
      aria-label={c.name}
      onClick={() => chooseChannel(c)}
      key={c.id}
      title={c.topic || c.name}
    >
      {c.type === 'voice' || c.type === 'video' ? <Headphones size={18} /> : <Hash size={19} />}
      <span>{c.name}</span>
      {voiceRooms.find((r) => r.channel_id === c.id)?.participants.length ? (
        <span className="voice-channel-count">
          {voiceRooms.find((r) => r.channel_id === c.id)!.participants.length} 🎙
        </span>
      ) : null}
      {c.id === channelId && <span className="active-channel-dot" />}
    </button>
  );
  if (boot)
    return (
      <div className="boot-screen">
        <Mark size={48} />
        <Spinner />
        <p>Preparando seu cantinho…</p>
      </div>
    );
  if (!user)
    return (
      <>
        <Auth />
        {toast && (
          <div className="toast" role="status">
            {toast}
          </div>
        )}
      </>
    );
  return (
    <div className="app-shell">
      <nav className="server-rail" aria-label="Servidores">
        <button
          className="home-server"
          title="Amigos e conversas"
          aria-label="Amigos e conversas"
          onClick={selectHome}
        >
          <Mark size={34} />
        </button>
        <div className="rail-separator" />
        <div className="guild-buttons">
          {guilds.map((g, i) => (
            <div className={`server-wrap ${g.id === guildId ? 'selected' : ''}`} key={g.id}>
              <button
                className={`server-icon color-${i % 4}`}
                title={g.name}
                aria-label={`Abrir ${g.name}`}
                onClick={() => {
                  selectGuild(g.id);
                  setMobileNav(false);
                }}
              >
                {g.name
                  .split(/\s+/)
                  .slice(0, 2)
                  .map((w) => w[0])
                  .join('')
                  .toUpperCase()}
              </button>
            </div>
          ))}
        </div>
        <button
          className="rail-action"
          title="Criar servidor"
          aria-label="Criar servidor"
          onClick={() => setDialog('guild')}
        >
          <Plus size={25} />
        </button>
        <button
          className="rail-action discover"
          title="Entrar com convite"
          aria-label="Entrar com convite"
          onClick={() => setDialog('join')}
        >
          <Compass size={24} />
        </button>
        <div className="rail-bottom">
          <span className="rail-sparkle">✧</span>
          <IconButton label="Sobre o Tetocord" onClick={() => setDialog('welcome')}>
            <HelpCircle size={21} />
          </IconButton>
        </div>
      </nav>
      <aside className={`channel-sidebar ${mobileNav ? 'mobile-open' : ''}`}>
        <div className="guild-header">
          <button onClick={() => setGuildMenu(!guildMenu)} aria-expanded={guildMenu}>
            <span>{guild?.name ?? 'Seu Tetocord'}</span>
            <ChevronDown size={18} />
          </button>
          {guildMenu && (
            <div className="guild-menu">
              {guild && (
                <>
                  <button
                    onClick={() => {
                      setDialog('invite');
                      setGuildMenu(false);
                    }}
                  >
                    <UserPlus size={16} /> Convidar amigos
                  </button>
                  {canManage && (
                    <>
                      <button
                        onClick={() => {
                          setDialog('channel');
                          setGuildMenu(false);
                        }}
                      >
                        <Plus size={16} /> Criar canal ou categoria
                      </button>
                      <button
                        onClick={() => {
                          setDialog('roles');
                          setGuildMenu(false);
                        }}
                      >
                        <Shield size={16} /> Gerenciar cargos
                      </button>
                      <button
                        onClick={() => {
                          setDialog('server');
                          setGuildMenu(false);
                        }}
                      >
                        <Settings size={16} /> Configurar servidor
                      </button>
                    </>
                  )}
                  {!canManage && (
                    <button
                      className="danger-link"
                      onClick={() => {
                        setDialog('leave');
                        setGuildMenu(false);
                      }}
                    >
                      <LogOut size={16} /> Sair do servidor
                    </button>
                  )}
                </>
              )}
              <button
                onClick={() => {
                  setDialog('guild');
                  setGuildMenu(false);
                }}
              >
                <Plus size={16} /> Novo servidor
              </button>
            </div>
          )}
        </div>
        {guild &&
          (guild.banner_asset_id ? (
            <div className="guild-banner">
              <img src={`/api/media/${guild.banner_asset_id}`} alt={`Banner de ${guild.name}`} />
            </div>
          ) : (
            <GuildBanner />
          ))}
        <div className="channel-list">
          {mode !== 'guild' ? (
            <DirectSidebar
              tick={dataTick + memberTick}
              onSelect={(id) => {
                selectConversation(id);
                setMobileNav(false);
              }}
              onHome={selectHome}
            />
          ) : guild ? (
            <>
              <div className="channel-section-head">
                <span>SEU CANTINHO</span>
                <span className="small-pill">
                  {members.length} {members.length === 1 ? 'pessoa' : 'pessoas'}
                </span>
              </div>
              {channels
                .filter((c) => !c.parent_id && c.type !== 'category' && c.type !== 'thread')
                .map(renderChannel)}
              {channels
                .filter((c) => c.type === 'category')
                .map((category) => (
                  <section className="channel-category" key={category.id}>
                    <div className="category-title">
                      <button
                        onClick={() =>
                          setCollapsed((old) => ({ ...old, [category.id]: !old[category.id] }))
                        }
                      >
                        {collapsed[category.id] ? (
                          <ChevronRight size={13} />
                        ) : (
                          <ChevronDown size={13} />
                        )}
                        <span>{category.name}</span>
                      </button>
                      {canManage && (
                        <IconButton label="Adicionar canal" onClick={() => setDialog('channel')}>
                          <Plus size={14} />
                        </IconButton>
                      )}
                    </div>
                    {!collapsed[category.id] &&
                      channels.filter((c) => c.parent_id === category.id).map(renderChannel)}
                  </section>
                ))}
              {canManage && (
                <button className="sidebar-add" onClick={() => setDialog('channel')}>
                  <Plus size={15} /> Criar um canal
                </button>
              )}
            </>
          ) : (
            <div className="no-server-sidebar">
              <Sparkles size={24} />
              <p>
                Todo grupo merece
                <br />
                um cantinho.
              </p>
              <button className="text-link" onClick={() => setDialog('guild')}>
                Vamos criar o seu?
              </button>
            </div>
          )}
        </div>
        {guild && (
          <div className="invite-card">
            <div className="invite-card-icon">
              <Heart size={18} />
            </div>
            <strong>Falta alguém na turma?</strong>
            <p>Coisas boas a gente compartilha.</p>
            <button aria-label="Convidar amigos" onClick={() => setDialog('invite')}>
              <UserPlus size={14} /> Convidar amigos <span>↗</span>
            </button>
          </div>
        )}
        <VoiceMiniPanel />
        <div className="self-panel">
          <Avatar
            user={user}
            size={35}
            status={
              user.preferred_status === 'invisible'
                ? 'offline'
                : connected
                  ? user.preferred_status
                  : 'offline'
            }
            onClick={() => setDialog('settings')}
          />
          <button className="self-name" onClick={() => setDialog('settings')}>
            <strong>{user.username}</strong>
            <span>{user.custom_status_text || statusLabels[user.preferred_status]}</span>
          </button>
          <IconButton label="Configurações do usuário" onClick={() => setDialog('settings')}>
            <Settings size={18} />
          </IconButton>
        </div>
      </aside>
      <main className="main-panel">
        <header className="chat-header">
          <IconButton
            label="Mostrar canais"
            className="mobile-menu"
            onClick={() => setMobileNav(!mobileNav)}
          >
            <Menu size={20} />
          </IconButton>
          <Hash className="header-hash" size={24} />
          <strong>{channel?.name ?? 'Seu espaço'}</strong>
          {channel?.topic && (
            <>
              <span className="header-divider" />
              <span className="channel-topic">{channel.topic}</span>
            </>
          )}
          <div className="header-tools">
            <span
              className={`connection-badge ${connected ? 'connected' : ''}`}
              title={connected ? 'Conectado em tempo real' : 'Reconectando'}
            >
              <Signal size={12} />
              <span>{connected ? 'Ao vivo' : 'Reconectando'}</span>
            </span>
            <IconButton
              label="Notificações"
              onClick={() => setNotificationsOpen(!notificationsOpen)}
              active={notificationsOpen}
            >
              <Bell size={19} />
              {notices.length > 0 && <i className="notification-dot" />}
            </IconButton>
            <IconButton
              label="Mostrar ou ocultar membros"
              onClick={() => void toggleMembers()}
              active={user.preferences.show_member_list}
            >
              <Users size={20} />
            </IconButton>
            <div className="header-divider" />
            <IconButton
              label="Buscar mensagens"
              onClick={() => setDialog('search')}
              active={showSearch}
            >
              <Search size={19} />
            </IconButton>
          </div>
        </header>
        {showSearch && (
          <div className="search-bar">
            <Search size={16} />
            <input
              autoFocus
              aria-label="Buscar mensagens"
              placeholder="Buscar no histórico carregado deste canal…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <IconButton
              label="Fechar busca"
              onClick={() => {
                setShowSearch(false);
                setSearch('');
              }}
            >
              <X size={16} />
            </IconButton>
          </div>
        )}
        {notificationsOpen && (
          <div className="notification-panel">
            <header>
              <strong>
                Suas menções <span>{notices.length}</span>
              </strong>
              <IconButton label="Fechar notificações" onClick={() => setNotificationsOpen(false)}>
                <X size={17} />
              </IconButton>
            </header>
            {notices.length ? (
              notices.map((n) => (
                <button
                  key={n.id}
                  onClick={() => {
                    if (n.kind === 'friend_request') {
                      selectHome();
                      setNotificationsOpen(false);
                      return;
                    }
                    if (n.guild_id) selectGuild(n.guild_id);
                    else selectConversation(n.channel_id);
                    selectChannel(n.channel_id);
                    setNotificationsOpen(false);
                    void postRead(n.channel_id, n.message_id as string);
                  }}
                >
                  <span className="notification-avatar">@</span>
                  <span>
                    <strong>{n.username} chamou você</strong>
                    <small>
                      {(n.content ?? 'Pedido de amizade').replace(
                        /<@&?[0-9a-f-]{36}>/gi,
                        '@menção',
                      )}
                    </small>
                  </span>
                </button>
              ))
            ) : (
              <div className="no-notifications">
                <Check size={26} />
                <p>Tudo em dia por aqui.</p>
                <small>Quando alguém mencionar você, aparece aqui.</small>
              </div>
            )}
          </div>
        )}
        <div className="chat-and-members">
          <section className="chat-column">
            {mode === 'home' ? (
              <SocialPanel
                tick={dataTick + memberTick}
                onConversation={(id) => {
                  selectConversation(id);
                  setMobileNav(false);
                }}
              />
            ) : channel && (channel.type === 'voice' || channel.type === 'video') ? (
              <VoiceRoomPanel channel={channel} />
            ) : channel?.type === 'forum' ? (
              <ForumPanel
                forum={channel}
                channels={channels}
                onOpen={selectChannel}
                onChanged={reload}
              />
            ) : channel ? (
              <Chat
                key={`${channel.id}:${focusMessageId ?? 'recent'}`}
                channel={channel}
                members={members}
                roles={roles}
                socket={socket}
                tick={messageTick}
                filter={search}
              />
            ) : (
              <div className="empty-home">
                <div className="empty-home-icon">
                  <Mark size={72} />
                </div>
                <span className="eyebrow">SEU PEQUENO UNIVERSO</span>
                <h1>Onde a turma se encontra.</h1>
                <p>
                  Crie um servidor ou entre com um convite.
                  <br />O resto começa com uma boa conversa.
                </p>
                <div>
                  <button className="primary" onClick={() => setDialog('guild')}>
                    <Plus size={17} /> Criar meu servidor
                  </button>
                  <button className="secondary" onClick={() => setDialog('join')}>
                    Tenho um convite
                  </button>
                </div>
                <span className="empty-home-note">
                  <Heart size={13} /> Feito para amigos, não para seguidores.
                </span>
              </div>
            )}
          </section>
          {user.preferences.show_member_list && guild && (
            <aside className="members-sidebar" aria-label="Membros">
              <div className="members-title">
                <span>A TURMA</span>
                <span>{members.length}</span>
              </div>
              <div className="member-group">
                <h3>
                  <span className="tiny-dot" /> POR AQUI — {online.length}
                </h3>
                {online.map((m) => (
                  <button className="member" key={m.id} onClick={() => setProfile(m)}>
                    <Avatar user={m} size={34} status={m.status} />
                    <span>
                      <strong
                        style={{ color: m.roles.find((r) => r.color)?.color ?? 'var(--text)' }}
                      >
                        {m.nickname || m.username}
                        {m.id === guild.owner_id && (
                          <span className="owner-star" title="Dono do servidor">
                            ♛
                          </span>
                        )}
                      </strong>
                      <small>
                        {m.roles.find((r) => r.icon_asset_id)?.icon_asset_id && (
                          <img
                            className="role-icon"
                            src={`/api/media/${m.roles.find((r) => r.icon_asset_id)!.icon_asset_id}`}
                            alt="Ícone do cargo"
                          />
                        )}
                        {m.custom_status_text || m.roles[0]?.name || 'De boa por aqui'}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
              {offline.length > 0 && (
                <div className="member-group offline">
                  <h3>OFFLINE — {offline.length}</h3>
                  {offline.map((m) => (
                    <button className="member" key={m.id} onClick={() => setProfile(m)}>
                      <Avatar user={m} size={34} status="offline" />
                      <span>
                        <strong>{m.nickname || m.username}</strong>
                        <small>{m.custom_status_text || 'Volta logo ♡'}</small>
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <div className="members-footer">
                <span>✦</span>
                <p>
                  Pequenos momentos.
                  <br />
                  <strong>Boas companhias.</strong>
                </p>
                <Heart size={13} />
              </div>
            </aside>
          )}
        </div>
      </main>
      {dialog === 'guild' && (
        <GuildDialog
          onClose={() => setDialog('')}
          onDone={(g) => {
            selectGuild(g.id);
            reload();
          }}
        />
      )}
      {dialog === 'join' && (
        <GuildDialog
          join
          onClose={() => setDialog('')}
          onDone={(g) => {
            selectGuild(g.id);
            reload();
          }}
        />
      )}
      {dialog === 'channel' && guild && (
        <ChannelDialog
          guild={guild}
          categories={channels.filter((c) => c.type === 'category')}
          onClose={() => setDialog('')}
          onDone={reload}
        />
      )}
      {dialog === 'invite' && guild && <InviteDialog guild={guild} onClose={() => setDialog('')} />}
      {dialog === 'settings' && (
        <SettingsDialog
          onClose={() => setDialog('')}
          onLogout={() => void logout()}
          onAdvanced={() => setDialog('preferences')}
        />
      )}
      {dialog === 'preferences' && (
        <PreferencesDialog guilds={guilds} onClose={() => setDialog('')} />
      )}
      {dialog === 'server' && guild && (
        <ServerDialog
          guild={guild}
          members={members}
          channels={channels}
          onClose={() => setDialog('')}
          onDone={reload}
        />
      )}
      {dialog === 'search' && (
        <SearchDialog
          guilds={guilds}
          onClose={() => setDialog('')}
          onOpen={(m) => {
            if (m.guild_id) {
              selectGuild(m.guild_id);
              selectChannel(m.channel_id);
            } else selectConversation(m.channel_id);
            focusMessage(m.id);
          }}
        />
      )}
      {dialog === 'roles' && guild && (
        <RolesDialog
          guild={guild}
          roles={roles}
          members={members}
          onClose={() => setDialog('')}
          onDone={reload}
        />
      )}
      {profile && (
        <ProfileDialog
          member={members.find((m) => m.id === profile.id) ?? profile}
          onClose={() => setProfile(null)}
        />
      )}
      {dialog === 'welcome' && (
        <Modal
          title="Um lugar só nosso."
          subtitle="Bem-vindo ao Tetocord."
          onClose={() => setDialog('')}
        >
          <div className="about-mark">
            <Mark size={60} />
          </div>
          <p className="about-copy">
            Um espaço privado para colocar o papo em dia, reunir seus amigos e guardar boas
            conversas. Crie seu servidor e mande o convite para a turma.
          </p>
          <button className="primary full" onClick={() => setDialog('guild')}>
            <Plus size={17} /> Criar um novo cantinho
          </button>
        </Modal>
      )}
      {dialog === 'leave' && guild && (
        <Modal
          title={`Sair de ${guild.name}?`}
          subtitle="Você precisará de um novo convite para voltar."
          onClose={() => setDialog('')}
        >
          <div className="modal-actions">
            <button className="secondary" onClick={() => setDialog('')}>
              Ficar por aqui
            </button>
            <button
              className="danger"
              onClick={async () => {
                try {
                  await api(`/guilds/${guild.id}/membership`, { method: 'DELETE' });
                  reload();
                  setDialog('');
                } catch (e) {
                  notify((e as Error).message);
                }
              }}
            >
              Sair do servidor
            </button>
          </div>
        </Modal>
      )}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            className="toast"
            role="status"
          >
            <Check size={17} />
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
async function postRead(channel: string, message: string) {
  if (!message) return;
  try {
    await api(`/channels/${channel}/read`, {
      method: 'PUT',
      body: JSON.stringify({ messageId: message }),
    });
  } catch {}
}
