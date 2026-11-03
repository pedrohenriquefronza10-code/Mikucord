import { useEffect, useState, type FormEvent } from 'react';
import { Bell, Plus, Trash2 } from 'lucide-react';
import { api, patch, post } from './api';
import { useStore } from './store';
import { Modal, ErrorText } from './ui';
import type { Guild, User } from './types';
type Theme = {
  id: string;
  owner_id: string;
  name: string;
  base_mode: 'dark' | 'light';
  palette: Record<string, string>;
  visibility: string;
  guild_id: string | null;
};
type Schedule = { weekday: number; start: string; end: string };
type Settings = {
  preferences: {
    desktop_enabled: boolean;
    sound_enabled: boolean;
    direct_messages: boolean;
    mentions: boolean;
    everyone_mentions: boolean;
    quiet_hours_enabled: boolean;
  };
  schedules: Array<{ weekday: number; start_local: string; end_local: string }>;
  sounds: Array<{ event: string; asset_id: string | null; enabled: boolean; volume: number }>;
  publicKey: string;
};
const paletteDefaults = {
  primary: '#b59aef',
  secondary: '#211e29',
  background: '#292530',
  surface: '#322d3b',
  text: '#eeeaf4',
  accent: '#b59aef',
};
const colorNames: Record<string, string> = {
  primary: 'Primária',
  secondary: 'Secundária / canais',
  background: 'Fundo',
  surface: 'Painéis',
  text: 'Texto',
  accent: 'Destaque',
};
export function PreferencesDialog({ guilds, onClose }: { guilds: Guild[]; onClose: () => void }) {
  const user = useStore((s) => s.user)!,
    setUser = useStore((s) => s.setUser),
    notify = useStore((s) => s.notify),
    [tab, setTab] = useState('themes'),
    [themes, setThemes] = useState<Theme[]>([]),
    [pendingUploads, setPendingUploads] = useState<
      Array<{ id: string; filename: string; expected_size_bytes: string }>
    >([]),
    [palette, setPalette] = useState<Record<string, string>>({
      ...paletteDefaults,
      ...user.preferences.palette,
    }),
    [name, setName] = useState('Meu tema'),
    [baseMode, setBaseMode] = useState<'dark' | 'light'>('dark'),
    [share, setShare] = useState(''),
    [settings, setSettings] = useState<Settings | null>(null),
    [windows, setWindows] = useState<Schedule[]>([]),
    [timezone, setTimezone] = useState(
      user.preferences.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    ),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const reload = () => {
    void api<{ uploads: typeof pendingUploads }>('/me/uploads')
      .then((r) => setPendingUploads(r.uploads))
      .catch((e) => setError(e.message));
    void api<{ themes: Theme[] }>('/themes')
      .then((r) => setThemes(r.themes))
      .catch((e) => setError(e.message));
    void api<Settings>('/me/notification-settings')
      .then((r) => {
        setSettings(r);
        setWindows(
          r.schedules.map((s) => ({
            weekday: s.weekday,
            start: s.start_local.slice(0, 5),
            end: s.end_local.slice(0, 5),
          })),
        );
      })
      .catch((e) => setError(e.message));
  };
  useEffect(reload, []);
  async function apply(mode: string, theme_id: string | null = null) {
    try {
      const r = await api<{ user: User }>('/me/theme', {
        method: 'PUT',
        body: JSON.stringify({ mode, theme_id }),
      });
      setUser(r.user);
      notify('Tema aplicado.');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function saveTheme(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await post<{ theme: Theme }>('/themes', {
        name,
        palette,
        base_mode: baseMode,
        guild_id: share || null,
      });
      await apply('custom', r.theme.id);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function saveNotifications(e: FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setBusy(true);
    try {
      await patch('/me/notification-settings', {
        ...Object.fromEntries(
          Object.entries(settings.preferences).filter(([key]) =>
            [
              'desktop_enabled',
              'sound_enabled',
              'direct_messages',
              'mentions',
              'everyone_mentions',
              'quiet_hours_enabled',
            ].includes(key),
          ),
        ),
        timezone,
        schedules: windows,
      });
      const r = await api<{ user: User }>('/me');
      setUser(r.user);
      notify('Preferências de notificação salvas.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function push() {
    if (!settings) return;
    setError('');
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window))
        throw new Error('Este navegador não suporta Web Push.');
      if (!settings.publicKey) throw new Error('Push ainda não configurado pelo administrador.');
      if ((await Notification.requestPermission()) !== 'granted')
        throw new Error('Permita notificações nas configurações do navegador.');
      const registration = await navigator.serviceWorker.ready,
        key = settings.publicKey.replace(/-/g, '+').replace(/_/g, '/'),
        bytes = Uint8Array.from(atob(key + '='.repeat((4 - (key.length % 4)) % 4)), (char) =>
          char.charCodeAt(0),
        );
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: bytes,
        }));
      await post('/push/subscriptions', subscription.toJSON());
      setSettings({ ...settings, preferences: { ...settings.preferences, desktop_enabled: true } });
      notify('Este navegador está pronto para receber notificações.');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function unpush() {
    try {
      const registration = await navigator.serviceWorker.ready,
        subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await api('/push/subscriptions', {
          method: 'DELETE',
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        await subscription.unsubscribe();
      }
      if (settings)
        setSettings({
          ...settings,
          preferences: { ...settings.preferences, desktop_enabled: false },
        });
      await patch('/me/notification-settings', { desktop_enabled: false });
      notify('Push desativado neste navegador.');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function sound(file: File | undefined, event: string) {
    if (!file) return;
    const body = new FormData();
    body.append('file', file);
    try {
      await api(`/me/sounds/${event}`, { method: 'POST', body });
      notify('Som atualizado.');
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Modal
      title="Um espaço com a sua vibe"
      subtitle="Temas, sons e notificações, do seu jeito."
      onClose={onClose}
      wide
    >
      <div className="settings-tabs">
        <button className={tab === 'themes' ? 'selected' : ''} onClick={() => setTab('themes')}>
          Temas
        </button>
        <button
          className={tab === 'notifications' ? 'selected' : ''}
          onClick={() => setTab('notifications')}
        >
          Notificações
        </button>
        <button className={tab === 'sounds' ? 'selected' : ''} onClick={() => setTab('sounds')}>
          Sons
        </button>
        <button className={tab === 'uploads' ? 'selected' : ''} onClick={() => setTab('uploads')}>
          Envios pendentes
        </button>
      </div>
      <ErrorText error={error} />
      {tab === 'uploads' ? (
        <div>
          <p className="field-note">
            Envios interrompidos podem ser cancelados aqui para liberar novas sessões de upload.
          </p>
          {pendingUploads.map((u) => (
            <div className="catalog-management" key={u.id}>
              <span>{u.filename}</span>
              <button
                className="danger"
                onClick={() =>
                  void api(`/uploads/${u.id}`, { method: 'DELETE' })
                    .then(reload)
                    .catch((e) => setError(e.message))
                }
              >
                Cancelar envio
              </button>
            </div>
          ))}
          {!pendingUploads.length && <p>Nenhum envio pendente.</p>}
        </div>
      ) : tab === 'themes' ? (
        <>
          <div className="theme-cards">
            <button onClick={() => void apply('dark')}>🌙 Escuro</button>
            <button onClick={() => void apply('light')}>☀️ Claro</button>
            <button
              onClick={() => {
                setName('Jardim noturno');
                setPalette({
                  primary: '#88c9a9',
                  secondary: '#162920',
                  background: '#1d3327',
                  surface: '#294234',
                  text: '#e2f3e9',
                  accent: '#88c9a9',
                });
              }}
            >
              🌱 Jardim
            </button>
          </div>
          <div className="saved-themes">
            {themes.map((theme) => (
              <div key={theme.id}>
                <button onClick={() => void apply('custom', theme.id)}>
                  <span
                    className="theme-swatch"
                    style={{
                      background: theme.palette.background,
                      borderColor: theme.palette.accent,
                    }}
                  />
                  {theme.name}
                  <small>{theme.visibility === 'guild' ? 'Compartilhado' : 'Pessoal'}</small>
                </button>
                {theme.owner_id === user.id && (
                  <button
                    aria-label={`Excluir tema ${theme.name}`}
                    onClick={() =>
                      void api(`/themes/${theme.id}`, { method: 'DELETE' })
                        .then(reload)
                        .catch((e) => setError(e.message))
                    }
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
          <form className="stack-form" onSubmit={saveTheme}>
            <h3>Criar tema</h3>
            <label>
              Nome
              <input
                aria-label="Nome do tema"
                required
                value={name}
                maxLength={64}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <div className="palette-editor">
              {Object.entries(palette).map(([key, value]) => (
                <label key={key}>
                  {colorNames[key] ?? key}
                  <input
                    aria-label={`Cor ${colorNames[key] ?? key}`}
                    type="color"
                    value={value}
                    onChange={(e) => setPalette((p) => ({ ...p, [key]: e.target.value }))}
                  />
                </label>
              ))}
            </div>
            <label>
              Base
              <select
                value={baseMode}
                onChange={(e) => setBaseMode(e.target.value as typeof baseMode)}
              >
                <option value="dark">Escuro</option>
                <option value="light">Claro</option>
              </select>
            </label>
            <label>
              Compartilhar com
              <select value={share} onChange={(e) => setShare(e.target.value)}>
                <option value="">Só para mim</option>
                {guilds.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
            <div
              className="theme-preview-box"
              style={{
                background: palette.background,
                color: palette.text,
                borderColor: palette.accent,
              }}
            >
              <strong style={{ color: palette.accent }}>Uma boa conversa começa aqui.</strong>
              <p>Uma prévia das cores do seu novo tema.</p>
            </div>
            <button className="primary" disabled={busy}>
              Salvar e aplicar tema
            </button>
          </form>
        </>
      ) : tab === 'notifications' && settings ? (
        <form className="stack-form" onSubmit={saveNotifications}>
          <div className="inline-actions">
            <button type="button" className="primary" onClick={() => void push()}>
              <Bell size={15} /> Ativar push neste navegador
            </button>
            <button type="button" className="secondary" onClick={() => void unpush()}>
              Desativar push
            </button>
          </div>
          {Object.entries({
            desktop_enabled: 'Notificações push',
            sound_enabled: 'Sons de notificação',
            direct_messages: 'Mensagens diretas',
            mentions: 'Menções a mim e aos meus cargos',
            everyone_mentions: 'Menções a everyone',
            quiet_hours_enabled: 'Ativar horários de silêncio',
          }).map(([key, label]) => (
            <label className="check-row" key={key}>
              <input
                type="checkbox"
                checked={settings.preferences[key as keyof typeof settings.preferences]}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    preferences: { ...settings.preferences, [key]: e.target.checked },
                  })
                }
              />
              {label}
            </label>
          ))}
          <label>
            Fuso horário
            <input
              aria-label="Fuso horário"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
            />
          </label>
          <h4>Horários de silêncio</h4>
          {windows.map((window, index) => (
            <div className="quiet-window" key={index}>
              <select
                aria-label={`Dia do horário ${index + 1}`}
                value={window.weekday}
                onChange={(e) =>
                  setWindows((old) =>
                    old.map((w, i) =>
                      i === index ? { ...w, weekday: Number(e.target.value) } : w,
                    ),
                  )
                }
              >
                {['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'].map(
                  (day, i) => (
                    <option key={day} value={i + 1}>
                      {day}
                    </option>
                  ),
                )}
              </select>
              <input
                type="time"
                aria-label={`Início do horário ${index + 1}`}
                value={window.start}
                onChange={(e) =>
                  setWindows((old) =>
                    old.map((w, i) => (i === index ? { ...w, start: e.target.value } : w)),
                  )
                }
              />
              <input
                type="time"
                aria-label={`Fim do horário ${index + 1}`}
                value={window.end}
                onChange={(e) =>
                  setWindows((old) =>
                    old.map((w, i) => (i === index ? { ...w, end: e.target.value } : w)),
                  )
                }
              />
              <button
                type="button"
                aria-label="Remover horário"
                onClick={() => setWindows((old) => old.filter((_, i) => i !== index))}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="secondary"
            onClick={() =>
              setWindows((old) => [...old, { weekday: 1, start: '22:00', end: '23:59' }])
            }
          >
            <Plus size={14} /> Adicionar horário
          </button>
          <p className="field-note">
            Não perturbe silencia avisos em qualquer horário. Para cruzar meia-noite, crie duas
            janelas.
          </p>
          <button className="primary" disabled={busy}>
            Salvar notificações
          </button>
        </form>
      ) : tab === 'sounds' && settings ? (
        <div className="stack-form">
          {(['message', 'call_join', 'call_leave'] as const).map((event) => {
            const current = settings.sounds.find((s) => s.event === event);
            return (
              <section className="sound-setting" key={event}>
                <h4>
                  {
                    {
                      message: 'Nova mensagem',
                      call_join: 'Entrada em chamada',
                      call_leave: 'Saída de chamada',
                    }[event]
                  }
                </h4>
                <label>
                  Enviar som (até 30 segundos)
                  <input
                    aria-label={`Som de ${event}`}
                    type="file"
                    accept="audio/*"
                    onChange={(e) => void sound(e.target.files?.[0], event)}
                  />
                </label>
                {current?.asset_id && <audio controls src={`/api/media/${current.asset_id}`} />}
                <label>
                  Volume
                  <input
                    type="range"
                    min="0"
                    max="100"
                    defaultValue={(current?.volume ?? 1) * 100}
                    onPointerUp={(e) =>
                      void patch(`/me/sounds/${event}`, {
                        enabled: current?.enabled ?? true,
                        volume: Number((e.target as HTMLInputElement).value) / 100,
                      }).then(reload)
                    }
                  />
                </label>
                <div className="inline-actions">
                  <button
                    className="secondary"
                    onClick={() =>
                      void patch(`/me/sounds/${event}`, {
                        enabled: !(current?.enabled ?? true),
                        volume: current?.volume ?? 1,
                      }).then(reload)
                    }
                  >
                    {current?.enabled === false ? 'Ativar' : 'Silenciar'}
                  </button>
                  <button
                    className="text-link"
                    onClick={() =>
                      void patch(`/me/sounds/${event}`, {
                        enabled: true,
                        volume: 1,
                        reset: true,
                      }).then(reload)
                    }
                  >
                    Usar som padrão
                  </button>
                </div>
              </section>
            );
          })}
        </div>
      ) : null}
    </Modal>
  );
}
