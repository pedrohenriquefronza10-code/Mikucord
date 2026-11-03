import { useEffect, useState, type FormEvent } from 'react';
import { api, patch, post } from './api';
import { useStore } from './store';
import { ErrorText, Modal } from './ui';
import type { Catalog, Channel, Expression, Guild, Member, Role } from './types';
export const permissionNames = [
  'Ver canal',
  'Ler histórico',
  'Enviar mensagens',
  'Gerenciar mensagens',
  'Anexar arquivos',
  'Adicionar reações',
  'Mencionar everyone',
  'Gerenciar canais',
  'Gerenciar servidor',
  'Gerenciar cargos',
  'Criar convites',
  'Expulsar membros',
  'Banir membros',
  'Aplicar timeout',
  'Ver auditoria',
  'Conectar em voz',
  'Falar',
  'Publicar câmera',
  'Compartilhar tela',
  'Silenciar membros',
  'Ensurdecer membros',
  'Mover membros',
  'Usar soundboard',
  'Gerenciar expressões',
  'Alterar meu apelido',
  'Gerenciar apelidos',
  'Administrador',
];
export function ServerDialog({
  guild,
  members,
  channels,
  onClose,
  onDone,
}: {
  guild: Guild;
  members: Member[];
  channels: Channel[];
  onClose: () => void;
  onDone: () => void;
}) {
  const notify = useStore((s) => s.notify),
    [tab, setTab] = useState('general'),
    [name, setName] = useState(guild.name),
    [description, setDescription] = useState(guild.description),
    [tags, setTags] = useState(guild.tags?.join(', ') ?? ''),
    [serverPalette, setServerPalette] = useState<Record<string, string>>(
      guild.visual_settings?.palette ?? {
        primary: '#b59aef',
        secondary: '#211e29',
        background: '#292530',
        surface: '#322d3b',
        text: '#eeeaf4',
        accent: '#b59aef',
      },
    ),
    [boost, setBoost] = useState(!!guild.boost_enabled),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [catalog, setCatalog] = useState<Catalog>({ emoji: [], sticker: [], sound: [] }),
    [kind, setKind] = useState<'emoji' | 'sticker' | 'sound'>('emoji'),
    [itemName, setItemName] = useState(''),
    [file, setFile] = useState<File | null>(null),
    [category, setCategory] = useState('Geral'),
    [shortcut, setShortcut] = useState(''),
    [itemTags, setItemTags] = useState(''),
    [roles, setRoles] = useState<Role[]>([]),
    [roleId, setRoleId] = useState(''),
    [roleName, setRoleName] = useState(''),
    [roleColor, setRoleColor] = useState('#b59aef'),
    [roleBits, setRoleBits] = useState('0'),
    [rolePosition, setRolePosition] = useState(1),
    [mentionable, setMentionable] = useState(true),
    [targetChannel, setTargetChannel] = useState(
      channels.find((c) => c.type !== 'category')?.id ?? '',
    ),
    [targetKind, setTargetKind] = useState('role'),
    [targetId, setTargetId] = useState(''),
    [allow, setAllow] = useState('0'),
    [deny, setDeny] = useState('0'),
    [targetUser, setTargetUser] = useState(''),
    [action, setAction] = useState('timeout'),
    [reason, setReason] = useState(''),
    [minutes, setMinutes] = useState(60),
    [newOwner, setNewOwner] = useState(''),
    [bans, setBans] = useState<Array<{ user_id: string; username: string; tag: string }>>([]),
    [editName, setEditName] = useState(''),
    [editTopic, setEditTopic] = useState(''),
    [editSlow, setEditSlow] = useState(0),
    [editPosition, setEditPosition] = useState(0),
    [logs, setLogs] = useState<
      Array<{ id: string; action: string; username: string; created_at: string; target_id: string }>
    >([]);
  const refresh = () => {
    void api<Catalog>(`/guilds/${guild.id}/catalog`)
      .then(setCatalog)
      .catch(() => {});
    void api<{ roles: Role[] }>(`/guilds/${guild.id}/roles`)
      .then((r) => setRoles(r.roles))
      .catch(() => {});
    onDone();
  };
  useEffect(refresh, [guild.id]);
  useEffect(() => {
    const c = channels.find((c) => c.id === targetChannel);
    if (c) {
      setEditName(c.name);
      setEditTopic(c.topic);
      setEditSlow(c.slowmode_seconds);
      setEditPosition(c.position ?? 0);
    }
  }, [targetChannel, channels]);
  useEffect(() => {
    if (tab === 'members' && action === 'unban')
      void api<{ bans: typeof bans }>(`/guilds/${guild.id}/bans`)
        .then((r) => setBans(r.bans))
        .catch((e) => setError(e.message));
  }, [tab, action, guild.id]);
  useEffect(() => {
    const role = roles.find((r) => r.id === roleId);
    if (role) {
      setRoleName(role.name);
      setRoleColor(role.color ?? '#b59aef');
      setRoleBits(role.permissions ?? '0');
      setRolePosition(role.position);
      setMentionable(!!role.mentionable);
    }
  }, [roleId, roles]);
  useEffect(() => {
    if (tab === 'audit')
      void api<{ logs: typeof logs }>(`/guilds/${guild.id}/audit`)
        .then((r) => setLogs(r.logs))
        .catch((e) => setError(e.message));
  }, [tab, guild.id]);
  useEffect(() => {
    if (tab !== 'permissions' || !targetChannel || !targetId) return;
    void api<{
      roles: Array<{ role_id: string; allow: string; deny: string }>;
      members: Array<{ user_id: string; allow: string; deny: string }>;
    }>(`/channels/${targetChannel}/overwrites`)
      .then((r) => {
        const current =
          targetKind === 'role'
            ? r.roles.find((o) => o.role_id === targetId)
            : r.members.find((o) => o.user_id === targetId);
        setAllow(current?.allow ?? '0');
        setDeny(current?.deny ?? '0');
      })
      .catch((e) => setError(e.message));
  }, [tab, targetChannel, targetKind, targetId]);
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      refresh();
      notify('Alterações salvas.');
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function uploadImage(purpose: string, file: File | undefined, role?: string) {
    if (!file) return;
    const body = new FormData();
    body.append('file', file);
    await run(() =>
      api(
        role ? `/guilds/${guild.id}/roles/${role}/icon` : `/guilds/${guild.id}/media/${purpose}`,
        { method: 'POST', body },
      ),
    );
  }
  async function upload(e: FormEvent) {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    if (!file) {
      setError('Selecione um arquivo.');
      return;
    }
    const body = new FormData();
    body.append('file', file);
    const q = new URLSearchParams({ name: itemName, category, shortcut, tags: itemTags });
    if (
      await run(() => api(`/guilds/${guild.id}/catalog/${kind}?${q}`, { method: 'POST', body }))
    ) {
      setItemName('');
      setFile(null);
      const input = form.querySelector<HTMLInputElement>('input[type=file]');
      if (input) input.value = '';
    }
  }
  const role = roles.find((r) => r.id === roleId);
  return (
    <Modal
      title={`O seu ${guild.name}`}
      subtitle="Cuide do espaço e de quem faz parte dele."
      onClose={onClose}
      wide
    >
      <div className="admin-tabs">
        {[
          ['general', 'Servidor'],
          ['expressions', 'Emojis, figurinhas e sons'],
          ['roles', 'Cargos'],
          ['permissions', 'Permissões'],
          ['channels', 'Canais'],
          ['members', 'Moderação'],
          ['audit', 'Auditoria'],
        ].map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? 'selected' : ''}
            onClick={() => {
              setTab(id);
              setError('');
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <ErrorText error={error} />
      {tab === 'general' ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() =>
              patch(`/guilds/${guild.id}`, {
                name,
                description,
                tags: tags
                  .split(',')
                  .map((t) => t.trim())
                  .filter(Boolean),
                visual_settings: { palette: serverPalette },
                boost_enabled: boost,
                boost_level: boost ? 1 : 0,
              }),
            );
          }}
        >
          <label>
            Nome do servidor
            <input
              aria-label="Nome do servidor"
              value={name}
              maxLength={100}
              required
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Descrição
            <textarea
              value={description}
              maxLength={1000}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label>
            Tags, separadas por vírgula
            <input value={tags} onChange={(e) => setTags(e.target.value)} />
          </label>
          <label>
            Ícone do servidor
            <input
              aria-label="Ícone do servidor"
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              onChange={(e) => void uploadImage('guild_icon', e.target.files?.[0])}
            />
          </label>
          <label>
            Banner do servidor
            <input
              aria-label="Banner do servidor"
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              onChange={(e) => void uploadImage('guild_banner', e.target.files?.[0])}
            />
          </label>
          <label className="check-row">
            <input type="checkbox" checked={boost} onChange={(e) => setBoost(e.target.checked)} />{' '}
            Boost simbólico — sem pagamento
          </label>
          <fieldset>
            <legend>Cores do servidor</legend>
            <div className="palette-grid">
              {Object.entries({
                primary: 'Primária',
                secondary: 'Secundária',
                background: 'Fundo',
                surface: 'Superfície',
                text: 'Texto',
                accent: 'Destaque',
              }).map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    type="color"
                    aria-label={`Cor do servidor: ${label}`}
                    value={serverPalette[key]}
                    onChange={(e) => setServerPalette((p) => ({ ...p, [key]: e.target.value }))}
                  />
                </label>
              ))}
            </div>
            <p className="field-note">
              Aplicadas ao tema escuro padrão. Cada membro pode escolher seu tema pessoal.
            </p>
          </fieldset>
          <p className="field-note">
            GIFs de perfil e servidor, quantidade de expressões e qualidade de tela continuam
            livres.
          </p>
          <button className="primary" disabled={busy}>
            Salvar servidor
          </button>
          {guild.owner_id === useStore.getState().user?.id && (
            <fieldset>
              <legend>Propriedade do servidor</legend>
              <label>
                Novo dono
                <select value={newOwner} onChange={(e) => setNewOwner(e.target.value)}>
                  <option value="">Escolha um membro</option>
                  {members
                    .filter((m) => m.id !== guild.owner_id)
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.username}
                      </option>
                    ))}
                </select>
              </label>
              <button
                type="button"
                className="secondary"
                disabled={busy || !newOwner}
                onClick={() => {
                  if (
                    confirm(
                      'Transferir a propriedade para esse membro? Seus cargos atuais serão mantidos.',
                    )
                  )
                    void run(() =>
                      api(`/guilds/${guild.id}/owner`, {
                        method: 'PUT',
                        body: JSON.stringify({ userId: newOwner }),
                      }),
                    ).then((ok) => {
                      if (ok) onClose();
                    });
                }}
              >
                Transferir servidor
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => {
                  if (
                    confirm(
                      `Excluir ${guild.name} e seus canais? Todos perderão acesso a este servidor.`,
                    )
                  )
                    void run(() => api(`/guilds/${guild.id}`, { method: 'DELETE' })).then((ok) => {
                      if (ok) onClose();
                    });
                }}
              >
                Excluir servidor
              </button>
            </fieldset>
          )}
        </form>
      ) : tab === 'expressions' ? (
        <>
          <form onSubmit={upload}>
            <label>
              Catálogo
              <select
                aria-label="Tipo de expressão"
                value={kind}
                onChange={(e) => setKind(e.target.value as typeof kind)}
              >
                <option value="emoji">Emojis</option>
                <option value="sticker">Figurinhas</option>
                <option value="sound">Soundboard</option>
              </select>
            </label>
            <label>
              Nome
              <input
                aria-label="Nome da expressão"
                required
                maxLength={kind === 'emoji' ? 32 : 64}
                value={itemName}
                onChange={(e) => setItemName(e.target.value)}
              />
            </label>
            {kind === 'sticker' && (
              <label>
                Tags
                <input
                  value={itemTags}
                  onChange={(e) => setItemTags(e.target.value)}
                  placeholder="feliz, jogos, café"
                />
              </label>
            )}
            {kind === 'sound' && (
              <div className="two-columns">
                <label>
                  Categoria
                  <input value={category} onChange={(e) => setCategory(e.target.value)} />
                </label>
                <label>
                  Atalho padrão
                  <input
                    value={shortcut}
                    onChange={(e) => setShortcut(e.target.value)}
                    placeholder="Alt+Digit1"
                  />
                </label>
              </div>
            )}
            <label>
              Arquivo {kind === 'sound' ? '(até 10 segundos)' : '(PNG, JPEG, GIF ou WebP)'}
              <input
                aria-label="Arquivo da expressão"
                type="file"
                required
                accept={kind === 'sound' ? 'audio/*' : 'image/png,image/jpeg,image/gif,image/webp'}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <button className="primary" disabled={busy}>
              Adicionar ao catálogo
            </button>
          </form>
          <div className="catalog-management">
            {catalog[kind].map((item) => (
              <div key={item.id}>
                {kind === 'sound' ? (
                  <audio controls src={`/api/media/${item.asset_id}`} />
                ) : (
                  <img src={`/api/media/${item.asset_id}`} alt={item.name} />
                )}
                <input
                  aria-label={`Renomear ${item.name}`}
                  defaultValue={item.name}
                  onBlur={(e) => {
                    if (e.target.value !== item.name)
                      void run(() =>
                        patch(`/guilds/${guild.id}/catalog/${kind}/${item.id}`, {
                          name: e.target.value,
                        }),
                      );
                  }}
                />
                {kind === 'sound' && <small>{item.category}</small>}
                <button
                  className="danger-link"
                  onClick={() =>
                    void run(() =>
                      api(`/guilds/${guild.id}/catalog/${kind}/${item.id}`, { method: 'DELETE' }),
                    )
                  }
                >
                  Remover
                </button>
              </div>
            ))}
          </div>
        </>
      ) : tab === 'roles' ? (
        <>
          <label>
            Cargo
            <select
              aria-label="Editar cargo"
              value={roleId}
              onChange={(e) => setRoleId(e.target.value)}
            >
              <option value="">Selecione um cargo</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          {role && (
            <form
              className="stack-form"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() =>
                  patch(`/guilds/${guild.id}/roles/${role.id}`, {
                    name: roleName,
                    color: roleColor,
                    permissions: roleBits,
                    ...(!role.is_everyone ? { position: rolePosition } : {}),
                    mentionable,
                  }),
                );
              }}
            >
              <div className="two-columns">
                <label>
                  Nome
                  <input value={roleName} onChange={(e) => setRoleName(e.target.value)} required />
                </label>
                <label>
                  Cor
                  <input
                    type="color"
                    value={roleColor}
                    onChange={(e) => setRoleColor(e.target.value)}
                  />
                </label>
              </div>
              {!role.is_everyone && (
                <label>
                  Posição na hierarquia
                  <input
                    type="number"
                    min="1"
                    value={rolePosition}
                    onChange={(e) => setRolePosition(Number(e.target.value))}
                  />
                </label>
              )}
              <label>
                Ícone do cargo
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => void uploadImage('role_icon', e.target.files?.[0], role.id)}
                />
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={mentionable}
                  onChange={(e) => setMentionable(e.target.checked)}
                />{' '}
                Pode ser mencionado
              </label>
              <div className="permissions-grid">
                {permissionNames.map((name, i) => (
                  <label className="check-row" key={name}>
                    <input
                      type="checkbox"
                      checked={(BigInt(roleBits) & (1n << BigInt(i))) !== 0n}
                      onChange={(e) =>
                        setRoleBits((bits) =>
                          (e.target.checked
                            ? BigInt(bits) | (1n << BigInt(i))
                            : BigInt(bits) & ~(1n << BigInt(i))
                          ).toString(),
                        )
                      }
                    />
                    {name}
                  </label>
                ))}
              </div>
              <div className="modal-actions">
                {!role.is_everyone && (
                  <button
                    type="button"
                    className="danger-link"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        api(`/guilds/${guild.id}/roles/${role.id}`, { method: 'DELETE' }),
                      ).then((ok) => {
                        if (ok) setRoleId('');
                      })
                    }
                  >
                    Excluir cargo
                  </button>
                )}
                <button className="primary" disabled={busy}>
                  Salvar cargo
                </button>
              </div>
            </form>
          )}
          <p className="field-note">
            Use “Gerenciar cargos” no menu para criar e atribuir cargos. A hierarquia e a concessão
            de permissões são verificadas pelo servidor.
          </p>
        </>
      ) : tab === 'permissions' ? (
        <form
          className="stack-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() =>
              api(`/channels/${targetChannel}/overwrites`, {
                method: 'PUT',
                body: JSON.stringify({ target: targetKind, targetId, allow, deny }),
              }),
            );
          }}
        >
          <label>
            Canal
            <select value={targetChannel} onChange={(e) => setTargetChannel(e.target.value)}>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <div className="two-columns">
            <label>
              Tipo de alvo
              <select
                value={targetKind}
                onChange={(e) => {
                  setTargetKind(e.target.value);
                  setTargetId('');
                }}
              >
                <option value="role">Cargo</option>
                <option value="member">Membro</option>
              </select>
            </label>
            <label>
              Alvo
              <select value={targetId} onChange={(e) => setTargetId(e.target.value)} required>
                <option value="">Selecione</option>
                {(targetKind === 'role' ? roles : members).map((target) => (
                  <option key={target.id} value={target.id}>
                    {'name' in target ? target.name : target.username}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="overwrite-rows">
            {permissionNames.map((name, i) => {
              const bit = 1n << BigInt(i),
                value =
                  (BigInt(allow) & bit) !== 0n
                    ? 'allow'
                    : (BigInt(deny) & bit) !== 0n
                      ? 'deny'
                      : 'inherit';
              return (
                <label key={name}>
                  {name}
                  <select
                    aria-label={`Permissão ${name}`}
                    value={value}
                    onChange={(e) => {
                      setAllow((a) =>
                        ((BigInt(a) & ~bit) | (e.target.value === 'allow' ? bit : 0n)).toString(),
                      );
                      setDeny((d) =>
                        ((BigInt(d) & ~bit) | (e.target.value === 'deny' ? bit : 0n)).toString(),
                      );
                    }}
                  >
                    <option value="inherit">Herdar</option>
                    <option value="allow">Permitir</option>
                    <option value="deny">Negar</option>
                  </select>
                </label>
              );
            })}
          </div>
          <button className="primary" disabled={busy || !targetId}>
            Salvar sobrescrita
          </button>
        </form>
      ) : tab === 'channels' ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() =>
              patch(`/channels/${targetChannel}`, {
                name: editName,
                topic: editTopic,
                slowmode_seconds: editSlow,
                position: editPosition,
              }),
            );
          }}
        >
          <label>
            Canal
            <select value={targetChannel} onChange={(e) => setTargetChannel(e.target.value)}>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Nome
            <input
              required
              value={editName}
              maxLength={100}
              onChange={(e) => setEditName(e.target.value)}
            />
          </label>
          <label>
            Descrição
            <textarea
              value={editTopic}
              maxLength={1024}
              onChange={(e) => setEditTopic(e.target.value)}
            />
          </label>
          <label>
            Intervalo entre mensagens (segundos)
            <input
              type="number"
              min={0}
              max={21600}
              value={editSlow}
              onChange={(e) => setEditSlow(Number(e.target.value))}
            />
          </label>
          <label>
            Posição na lista
            <input
              type="number"
              min={0}
              max={1000000}
              value={editPosition}
              onChange={(e) => setEditPosition(Number(e.target.value))}
            />
          </label>
          <button className="primary" disabled={busy || !targetChannel}>
            Salvar canal
          </button>
          {channels.find((c) => c.id === targetChannel)?.parent_id && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                void run(() => patch(`/channels/${targetChannel}`, { permissions_synced: true }))
              }
            >
              Sincronizar permissões com a categoria
            </button>
          )}
          <button
            type="button"
            className="danger"
            disabled={busy || !targetChannel}
            onClick={() => {
              if (confirm('Excluir este canal e seus canais filhos?'))
                void run(() => api(`/channels/${targetChannel}`, { method: 'DELETE' })).then(
                  (ok) => {
                    if (ok) setTargetChannel('');
                  },
                );
            }}
          >
            Excluir canal
          </button>
        </form>
      ) : tab === 'members' ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() =>
              post(`/guilds/${guild.id}/moderation`, {
                userId: targetUser,
                action,
                reason,
                minutes,
              }),
            );
          }}
        >
          <label>
            Membro
            <select
              aria-label="Membro para moderação"
              value={targetUser}
              onChange={(e) => setTargetUser(e.target.value)}
              required
            >
              <option value="">Selecione</option>
              {(action === 'unban'
                ? bans.map((b) => ({ id: b.user_id, username: `${b.username}#${b.tag}` }))
                : members
              ).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.username}
                </option>
              ))}
            </select>
          </label>
          <label>
            Ação
            <select value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="timeout">Aplicar timeout</option>
              <option value="kick">Expulsar</option>
              <option value="ban">Banir</option>
              <option value="unban">Remover banimento</option>
            </select>
          </label>
          {action === 'timeout' && (
            <label>
              Duração (minutos, zero para remover)
              <input
                type="number"
                min="0"
                max="40320"
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
              />
            </label>
          )}
          <label>
            Motivo
            <textarea value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button className="danger" disabled={busy || !targetUser}>
            Aplicar ação de moderação
          </button>
        </form>
      ) : (
        <div className="audit-list">
          {logs.map((log) => (
            <article key={log.id}>
              <strong>{log.action}</strong>
              <span>{log.username ?? 'Sistema'}</span>
              <small>{new Date(log.created_at).toLocaleString('pt-BR')}</small>
              <code>{log.target_id}</code>
            </article>
          ))}
          {logs.length > 0 && (
            <button
              className="secondary"
              onClick={() =>
                void api<{ logs: typeof logs }>(
                  `/guilds/${guild.id}/audit?before=${encodeURIComponent(logs.at(-1)!.created_at)}`,
                )
                  .then((r) => setLogs((old) => [...old, ...r.logs]))
                  .catch((e) => setError(e.message))
              }
            >
              Carregar anteriores
            </button>
          )}
        </div>
      )}
    </Modal>
  );
}
export function SearchDialog({
  guilds,
  onClose,
  onOpen,
}: {
  guilds: Guild[];
  onClose: () => void;
  onOpen: (message: { id: string; channel_id: string; guild_id: string | null }) => void;
}) {
  const [q, setQ] = useState(''),
    [guild, setGuild] = useState(''),
    [author, setAuthor] = useState(''),
    [channel, setChannel] = useState(''),
    [before, setBefore] = useState(''),
    [after, setAfter] = useState(''),
    [options, setOptions] = useState<{
      people: Array<{ id: string; username: string; tag: string }>;
      channels: Array<{ id: string; name: string }>;
    }>({ people: [], channels: [] }),
    [results, setResults] = useState<
      Array<{
        id: string;
        channel_id: string;
        guild_id: string | null;
        channel_name: string;
        content: string;
        created_at: string;
        author: { username: string };
      }>
    >([]),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const selected = guild ? guilds.filter((g) => g.id === guild) : guilds;
    void Promise.all([
      Promise.all(
        selected.map(async (g) => {
          const [c, m] = await Promise.all([
            api<{ channels: Channel[] }>(`/guilds/${g.id}/channels`),
            api<{ members: Member[] }>(`/guilds/${g.id}/members`),
          ]);
          return {
            channels: c.channels
              .filter((c) => !['category', 'forum', 'voice', 'video'].includes(c.type))
              .map((c) => ({ id: c.id, name: `${g.name} / #${c.name}` })),
            people: m.members,
          };
        }),
      ),
      guild
        ? Promise.resolve({ channels: [] as Channel[] })
        : api<{ channels: Channel[] }>('/conversations'),
    ])
      .then(([servers, dm]) => {
        if (!active) return;
        const people = new Map<string, { id: string; username: string; tag: string }>();
        for (const m of servers.flatMap((s) => s.people)) people.set(m.id, m);
        for (const c of dm.channels) for (const m of c.members ?? []) people.set(m.id, m);
        setOptions({
          people: [...people.values()].sort((a, b) => a.username.localeCompare(b.username)),
          channels: [
            ...servers.flatMap((s) => s.channels),
            ...dm.channels.map((c) => ({
              id: c.id,
              name: c.name || c.members?.map((m) => m.username).join(', ') || 'Conversa direta',
            })),
          ],
        });
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [guild, guilds]);
  return (
    <Modal
      title="Encontre aquela conversa"
      subtitle="Busque por texto e refine por pessoa, canal e data."
      onClose={onClose}
      wide
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const query = new URLSearchParams({ q });
            if (guild) query.set('guild', guild);
            if (author) query.set('author', author);
            if (channel) query.set('channel', channel);
            if (before) query.set('before', new Date(`${before}T23:59:59`).toISOString());
            if (after) query.set('after', new Date(`${after}T00:00:00`).toISOString());
            const r = await api<{ results: typeof results }>(`/search?${query}`);
            setResults(r.results);
            setError('');
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <label>
          Texto
          <input
            aria-label="Texto da busca"
            required
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <label>
          Servidor
          <select value={guild} onChange={(e) => setGuild(e.target.value)}>
            <option value="">Todos e mensagens diretas</option>
            {guilds.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        <div className="two-columns">
          <label>
            Autor
            <select value={author} onChange={(e) => setAuthor(e.target.value)}>
              <option value="">Qualquer pessoa</option>
              {options.people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.username}#{p.tag}
                </option>
              ))}
            </select>
          </label>
          <label>
            Canal ou conversa
            <select value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="">Todos os canais</option>
              {options.channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="two-columns">
          <label>
            Depois de
            <input type="date" value={after} onChange={(e) => setAfter(e.target.value)} />
          </label>
          <label>
            Antes de
            <input type="date" value={before} onChange={(e) => setBefore(e.target.value)} />
          </label>
        </div>
        <button className="primary">Buscar mensagens</button>
      </form>
      <ErrorText error={error} />
      <div className="search-results">
        {results.map((r) => (
          <button
            key={r.id}
            onClick={() => {
              onOpen(r);
              onClose();
            }}
          >
            <strong>
              {r.author.username} <small>#{r.channel_name}</small>
            </strong>
            <p>{r.content.replace(/<@&?[0-9a-f-]{36}>/gi, '@menção')}</p>
            <small>{new Date(r.created_at).toLocaleString('pt-BR')}</small>
          </button>
        ))}
      </div>
    </Modal>
  );
}
