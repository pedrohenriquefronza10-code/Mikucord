import { useState, type FormEvent } from 'react';
import { Check, Copy, Hash, ImagePlus, LogOut, Moon, Plus, Shield, Sun, Users } from 'lucide-react';
import { api, post, patch } from './api';
import { useStore } from './store';
import { Avatar, ErrorText, Modal, Spinner } from './ui';
import type { Channel, Guild, Member, Role, User } from './types';
export function GuildDialog({
  onClose,
  onDone,
  join = false,
}: {
  onClose: () => void;
  onDone: (g: Guild) => void;
  join?: boolean;
}) {
  const [mode, setMode] = useState(join ? 'join' : 'create'),
    [name, setName] = useState(''),
    [description, setDescription] = useState(''),
    [code, setCode] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      let result: { guild: Guild };
      if (mode === 'create') result = await post('/guilds', { name, description });
      else {
        let token = code.trim();
        try {
          token = new URL(token).searchParams.get('invite') ?? token;
        } catch {}
        result = await post(`/invites/${encodeURIComponent(token)}/join`);
      }
      onDone(result.guild);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Sua turma, seu espaço."
      subtitle="Boas conversas precisam de um lugar para começar."
      onClose={onClose}
    >
      <div className="tabs">
        <button className={mode === 'create' ? 'selected' : ''} onClick={() => setMode('create')}>
          <Plus size={16} /> Criar servidor
        </button>
        <button className={mode === 'join' ? 'selected' : ''} onClick={() => setMode('join')}>
          <Users size={16} /> Tenho um convite
        </button>
      </div>
      <form onSubmit={submit}>
        {mode === 'create' ? (
          <>
            <label>
              Nome do servidor
              <input
                autoFocus
                required
                maxLength={100}
                placeholder="Ex.: Nosso cantinho"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              Uma pequena descrição <span className="muted">(opcional)</span>
              <textarea
                maxLength={1000}
                value={description}
                placeholder="Qual é a vibe da sua turma?"
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
          </>
        ) : (
          <label>
            Link ou código do convite
            <input
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Cole o convite que você recebeu"
            />
          </label>
        )}
        <ErrorText error={error} />
        <button className="primary full" disabled={busy}>
          {busy ? <Spinner /> : mode === 'create' ? 'Criar meu servidor' : 'Entrar no servidor'}
        </button>
      </form>
    </Modal>
  );
}
export function ChannelDialog({
  guild,
  categories,
  onClose,
  onDone,
}: {
  guild: Guild;
  categories: Channel[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(''),
    [type, setType] = useState('text'),
    [category, setCategory] = useState(''),
    [topic, setTopic] = useState(''),
    [privateChannel, setPrivate] = useState(false),
    [slowmode, setSlowmode] = useState('0'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await post(`/guilds/${guild.id}/channels`, {
        name,
        type,
        parentId: type !== 'category' && category ? category : null,
        topic,
        private: privateChannel,
        slowmode: Number(slowmode),
      });
      onDone();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Mais espaço para conversar"
      subtitle={`Novo canal em ${guild.name}`}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <label>
          Tipo
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="text"># Canal de texto</option>
            <option value="category">Categoria</option>
            <option value="voice">Voz</option>
            <option value="video">Vídeo</option>
            <option value="announcement">Anúncios</option>
            <option value="forum">Fórum</option>
          </select>
        </label>
        <label>
          Nome
          <input
            required
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            placeholder="papo-aleatório"
          />
        </label>
        {type !== 'category' && (
          <>
            <label>
              Categoria
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">Sem categoria</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Assunto
              <textarea
                maxLength={1024}
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="Sobre o que vamos conversar?"
              />
            </label>
            <label>
              Intervalo entre mensagens
              <select value={slowmode} onChange={(e) => setSlowmode(e.target.value)}>
                <option value="0">Sem intervalo</option>
                <option value="5">5 segundos</option>
                <option value="30">30 segundos</option>
                <option value="60">1 minuto</option>
              </select>
            </label>
          </>
        )}
        <label className="check-row">
          <input
            type="checkbox"
            checked={privateChannel}
            onChange={(e) => setPrivate(e.target.checked)}
          />
          <span>
            Privado <small>Visível para você e administradores.</small>
          </span>
        </label>
        <ErrorText error={error} />
        <button className="primary full" disabled={busy}>
          {busy ? (
            <Spinner />
          ) : (
            <>
              <Hash size={17} /> Criar {type === 'text' ? 'canal' : 'categoria'}
            </>
          )}
        </button>
      </form>
    </Modal>
  );
}
export function InviteDialog({ guild, onClose }: { guild: Guild; onClose: () => void }) {
  const [url, setUrl] = useState(''),
    [error, setError] = useState(''),
    [copied, setCopied] = useState(false),
    [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true);
    setError('');
    try {
      setUrl((await post<{ url: string }>(`/guilds/${guild.id}/invites`)).url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="A turma fica melhor completa."
      subtitle={`Convide seus amigos para ${guild.name}.`}
      onClose={onClose}
    >
      <div className="invite-art">
        <Users size={42} />
        <span>Tem uma cadeira esperando por eles.</span>
      </div>
      {url ? (
        <>
          <label>
            Convite válido por 7 dias
            <input readOnly value={url} onFocus={(e) => e.target.select()} />
          </label>
          <button
            className="primary full"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(url);
                setCopied(true);
              } catch {
                setError('Selecione e copie o link acima.');
              }
            }}
          >
            {copied ? (
              <>
                <Check size={17} /> Copiado!
              </>
            ) : (
              <>
                <Copy size={17} /> Copiar convite
              </>
            )}
          </button>
        </>
      ) : (
        <button className="primary full" onClick={() => void create()} disabled={busy}>
          {busy ? <Spinner /> : 'Gerar link de convite'}
        </button>
      )}
      <ErrorText error={error} />
    </Modal>
  );
}
export function SettingsDialog({
  onClose,
  onLogout,
  onAdvanced,
}: {
  onClose: () => void;
  onLogout: () => void;
  onAdvanced?: () => void;
}) {
  const user = useStore((s) => s.user)!,
    setUser = useStore((s) => s.setUser),
    notify = useStore((s) => s.notify);
  const [tab, setTab] = useState('profile'),
    [bio, setBio] = useState(user.about_me),
    [status, setStatus] = useState(user.custom_status_text),
    [presence, setPresence] = useState(user.preferred_status),
    [color, setColor] = useState(user.accent_color),
    [theme, setTheme] = useState(user.preferences.theme_mode),
    [density, setDensity] = useState(user.preferences.message_density),
    [font, setFont] = useState(user.preferences.chat_font_size),
    [members, setMembers] = useState(user.preferences.show_member_list),
    [busy, setBusy] = useState(false),
    [uploading, setUploading] = useState(''),
    [error, setError] = useState('');
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await patch('/me', {
        about_me: bio,
        custom_status_text: status,
        preferred_status: presence,
        accent_color: color,
      });
      const result = await patch<{ user: User }>('/me/preferences', {
        theme_mode: theme,
        message_density: density,
        chat_font_size: font,
        show_member_list: members,
      });
      setUser(result.user);
      notify('Seu cantinho está do seu jeito.');
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function upload(file: File | undefined, purpose: string) {
    if (!file) return;
    setUploading(purpose);
    setError('');
    const data = new FormData();
    data.append('file', file);
    try {
      const result = await api<{ user: User }>(`/me/media/${purpose}`, {
        method: 'POST',
        body: data,
      });
      setUser(result.user);
      notify('Imagem de perfil atualizada.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading('');
    }
  }
  return (
    <Modal
      title="Do seu jeitinho"
      subtitle="Um perfil com a sua cara. Um espaço com a sua vibe."
      onClose={onClose}
      wide
    >
      <div className="settings-tabs">
        <button className={tab === 'profile' ? 'selected' : ''} onClick={() => setTab('profile')}>
          Meu perfil
        </button>
        <button
          className={tab === 'appearance' ? 'selected' : ''}
          onClick={() => setTab('appearance')}
        >
          Aparência
        </button>
      </div>
      <form onSubmit={save}>
        {tab === 'profile' ? (
          <>
            <div className="profile-preview">
              <div className="profile-banner" style={{ backgroundColor: color }}>
                {user.banner_asset_id && (
                  <img src={`/api/media/${user.banner_asset_id}`} alt="Banner de perfil" />
                )}
                <label className="upload-label">
                  <ImagePlus size={15} /> {uploading === 'banner' ? 'Enviando…' : 'Mudar banner'}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    disabled={!!uploading}
                    onChange={(e) => void upload(e.target.files?.[0], 'banner')}
                  />
                </label>
              </div>
              <div className="preview-identity">
                <Avatar user={user} size={68} />
                <div>
                  <strong>
                    {user.username}
                    <span className="muted">#{user.tag}</span>
                  </strong>
                  <label className="text-link">
                    {uploading === 'avatar' ? 'Enviando…' : 'Trocar avatar'}
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/gif,image/webp"
                      disabled={!!uploading}
                      onChange={(e) => void upload(e.target.files?.[0], 'avatar')}
                    />
                  </label>
                </div>
              </div>
            </div>
            <div className="two-columns">
              <label>
                Status
                <select
                  aria-label="Status"
                  value={presence}
                  onChange={(e) => setPresence(e.target.value)}
                >
                  <option value="online">🟢 Online</option>
                  <option value="idle">🌙 Ausente</option>
                  <option value="dnd">⛔ Não perturbe</option>
                  <option value="invisible">⚪ Invisível</option>
                </select>
              </label>
              <label>
                Cor do perfil
                <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
              </label>
            </div>
            <label>
              O que está rolando?
              <input
                value={status}
                maxLength={128}
                onChange={(e) => setStatus(e.target.value)}
                placeholder="🎮 Só mais uma partida"
              />
            </label>
            <label>
              Sobre mim
              <textarea
                value={bio}
                maxLength={1000}
                onChange={(e) => setBio(e.target.value)}
                placeholder="Um pouquinho sobre você…"
              />
            </label>
          </>
        ) : (
          <>
            <label>Tema</label>
            <div className="theme-cards">
              <button
                type="button"
                className={theme === 'dark' ? 'selected' : ''}
                onClick={() => setTheme('dark')}
              >
                <Moon /> Escurinho
              </button>
              <button
                type="button"
                className={theme === 'light' ? 'selected' : ''}
                onClick={() => setTheme('light')}
              >
                <Sun /> Clarinho
              </button>
            </div>
            <label>
              Densidade das mensagens
              <select
                value={density}
                onChange={(e) => setDensity(e.target.value as typeof density)}
              >
                <option value="compact">Compacta</option>
                <option value="normal">Normal</option>
                <option value="comfortable">Confortável</option>
              </select>
            </label>
            <label>
              Tamanho da fonte: {font}px
              <input
                type="range"
                min="12"
                max="28"
                value={font}
                onChange={(e) => setFont(Number(e.target.value))}
              />
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={members}
                onChange={(e) => setMembers(e.target.checked)}
              />{' '}
              Mostrar lista de membros
            </label>
          </>
        )}
        <button type="button" className="secondary full" onClick={onAdvanced}>
          Temas, sons e notificações
        </button>
        <ErrorText error={error} />
        <div className="modal-actions">
          <button type="button" className="danger-link" onClick={onLogout}>
            <LogOut size={16} /> Sair da conta
          </button>
          <button className="primary" disabled={busy || !!uploading}>
            {busy ? <Spinner /> : 'Salvar alterações'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function ProfileDialog({ member, onClose }: { member: Member; onClose: () => void }) {
  return (
    <Modal title="Perfil" onClose={onClose}>
      <div
        className="profile-banner public-banner"
        style={{ backgroundColor: member.accent_color }}
      >
        {member.banner_asset_id && (
          <img src={`/api/media/${member.banner_asset_id}`} alt="Banner" />
        )}
      </div>
      <div className="public-profile">
        <Avatar user={member} size={80} status={member.status} />
        <h2>
          {member.username}
          <span className="muted">#{member.tag}</span>
        </h2>
        {member.custom_status_text && <p>{member.custom_status_text}</p>}
        <h4>SOBRE MIM</h4>
        <p className="preserve-space">
          {member.about_me || 'Ainda tem muita história para contar.'}
        </p>
        <div className="role-chips">
          {member.roles.map((r) => (
            <span key={r.id}>
              <i style={{ background: r.color ?? 'var(--accent)' }} />
              {r.name}
            </span>
          ))}
        </div>
      </div>
    </Modal>
  );
}
export function RolesDialog({
  guild,
  roles,
  members,
  onClose,
  onDone,
}: {
  guild: Guild;
  roles: Role[];
  members: Member[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(''),
    [color, setColor] = useState('#A68AEB'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState('');
  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const { role } = await post<{ role: Role }>(`/guilds/${guild.id}/roles`, { name, color });
      setSelected(role.id);
      setName('');
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function toggle(member: Member, roleId: string) {
    setBusy(true);
    try {
      const has = member.roles.some((r) => r.id === roleId);
      await api(`/guilds/${guild.id}/members/${member.id}/roles/${roleId}`, {
        method: has ? 'DELETE' : 'PUT',
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Cores da nossa turma"
      subtitle="Crie cargos e escolha quem faz parte de cada um."
      onClose={onClose}
      wide
    >
      <form onSubmit={create}>
        <div className="role-create">
          <label>
            Nome do cargo
            <input
              required
              maxLength={100}
              placeholder="Ex.: Amigos"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Cor
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          </label>
          <button className="primary" disabled={busy}>
            <Plus size={17} /> Criar
          </button>
        </div>
      </form>
      <label>
        Gerenciar membros do cargo
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="">Selecione um cargo</option>
          {roles
            .filter((r) => !r.is_everyone)
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
        </select>
      </label>
      {selected && (
        <div className="role-member-list">
          {members.map((m) => (
            <button key={m.id} disabled={busy} onClick={() => void toggle(m, selected)}>
              <Avatar user={m} size={30} />
              <span>{m.username}</span>
              <span
                className={`checkbox ${m.roles.some((r) => r.id === selected) ? 'checked' : ''}`}
              >
                {m.roles.some((r) => r.id === selected) && <Check size={14} />}
              </span>
            </button>
          ))}
        </div>
      )}
      <p className="field-note">
        <Shield size={13} /> Cargos criados aqui são visuais e mencionáveis. O dono mantém as
        permissões administrativas.
      </p>
      <ErrorText error={error} />
    </Modal>
  );
}
