import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AtSign, CornerUpLeft, Hash, Pencil, Plus, Send, Smile, Trash2, X } from 'lucide-react';
import type { Socket } from 'socket.io-client';
import { AttachmentView, UploadTray, useUploads } from './Attachments';
import { MediaPicker } from './MediaPicker';
import { api, patch, post } from './api';
import { useStore } from './store';
import { Avatar, IconButton, Modal, Spinner } from './ui';
import type { Channel, Member, Message, Role, Expression } from './types';
const time = (date: string) =>
  new Date(date).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
export function MessageText({
  content,
  members,
  roles,
  emojis = [],
}: {
  emojis?: Expression[];
  content: string;
  members: Member[];
  roles: Role[];
}) {
  return (
    <>
      {content
        .split(
          /(<:[0-9a-f-]{36}:[A-Za-z0-9_]+:>|:[A-Za-z0-9_]{2,32}:|<@&?[0-9a-f-]{36}>|@everyone|@[\p{L}\p{N}_.-]+#\d{4})/giu,
        )
        .map((part, i) => {
          const custom = part.match(/^<:([0-9a-f-]{36}):([A-Za-z0-9_]+):>$/i);
          const emoji = emojis.find((e) => e.id === custom?.[1] || `:${e.name}:` === part);
          if (emoji)
            return (
              <img
                key={i}
                className="inline-emoji"
                src={`/api/media/${emoji.asset_id}`}
                alt={`:${emoji.name}:`}
                title={emoji.name}
              />
            );
          if (custom) return <span key={i}>:emoji indisponível:</span>;
          const user = part.match(/^<@([0-9a-f-]{36})>$/i),
            role = part.match(/^<@&([0-9a-f-]{36})>$/i);
          if (user)
            return (
              <span className="mention" key={i}>
                @{members.find((m) => m.id === user[1])?.username ?? 'usuário'}
              </span>
            );
          if (role)
            return (
              <span className="mention" key={i}>
                @{roles.find((r) => r.id === role[1])?.name ?? 'cargo'}
              </span>
            );
          return part.startsWith('@') ? (
            <span className="mention" key={i}>
              {part}
            </span>
          ) : (
            part
          );
        })}
    </>
  );
}
export function Chat({
  channel,
  members,
  roles,
  socket,
  tick,
  filter,
}: {
  channel: Channel;
  members: Member[];
  roles: Role[];
  socket: Socket | null;
  tick: number;
  filter: string;
}) {
  const user = useStore((s) => s.user)!,
    notify = useStore((s) => s.notify);
  const [messages, setMessages] = useState<Message[]>([]),
    [loading, setLoading] = useState(true),
    [hasMore, setHasMore] = useState(false),
    [error, setError] = useState(''),
    [draft, setDraft] = useState(''),
    [sending, setSending] = useState(false),
    [reply, setReply] = useState<Message | null>(null),
    [editing, setEditing] = useState<string | null>(null),
    [editText, setEditText] = useState(''),
    [deleting, setDeleting] = useState<Message | null>(null),
    [picker, setPicker] = useState<'mention' | 'emoji' | 'stickers' | 'gif' | null>(null),
    [typing, setTyping] = useState<Record<string, { name: string; until: number }>>({});
  const focus = useStore((s) => s.focusMessageId),
    setFocus = useStore((s) => s.focusMessage);
  const uploads = useUploads(channel.id),
    fileInput = useRef<HTMLInputElement>(null);
  const [selectedStickers, setSelectedStickers] = useState<Expression[]>([]),
    [reacting, setReacting] = useState<Message | null>(null),
    [dragging, setDragging] = useState(false);
  const list = useRef<HTMLDivElement>(null),
    input = useRef<HTMLTextAreaElement>(null),
    scrollNext = useRef(true),
    nonce = useRef<string | null>(null),
    draftRef = useRef(''),
    lastTyping = useRef(0);
  useEffect(() => {
    nonce.current = null;
  }, [uploads.assetIds.join(','), selectedStickers.map((s) => s.id).join(',')]);
  useEffect(() => {
    let active = true;
    void api<{ messages: Message[]; hasMore: boolean }>(
      focus ? `/messages/${focus}/context` : `/channels/${channel.id}/messages`,
    )
      .then((data) => {
        if (!active) return;
        setMessages((prev) => {
          const map = new Map(prev.map((m) => [m.id, m]));
          for (const m of data.messages) {
            const old = map.get(m.id);
            if (!old || BigInt(m.version) >= BigInt(old.version)) map.set(m.id, m);
          }
          return [...map.values()].sort(
            (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
          );
        });
        setHasMore(data.hasMore);
        setLoading(false);
        setError('');
      })
      .catch((e) => {
        if (active) {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [channel.id, tick, focus]);
  useEffect(() => {
    if (focus && messages.length)
      document.getElementById(`message-${focus}`)?.scrollIntoView({ block: 'center' });
  }, [focus, messages]);
  useEffect(() => {
    if (scrollNext.current) {
      list.current?.scrollTo({ top: list.current.scrollHeight });
      scrollNext.current = false;
    }
  }, [messages]);
  useEffect(() => {
    const last = messages.at(-1);
    if (!last || document.visibilityState !== 'visible') return;
    void api(`/channels/${channel.id}/read`, {
      method: 'PUT',
      body: JSON.stringify({ messageId: last.id }),
    }).catch(() => {});
  }, [messages.at(-1)?.id, channel.id]);
  useEffect(() => {
    if (!socket) return;
    const listener = (e: { channelId: string; userId: string; username: string }) => {
      if (e.channelId === channel.id)
        setTyping((t) => ({ ...t, [e.userId]: { name: e.username, until: Date.now() + 5000 } }));
    };
    socket.on('typing', listener);
    const timer = setInterval(
      () =>
        setTyping((t) =>
          Object.fromEntries(Object.entries(t).filter(([, v]) => v.until > Date.now())),
        ),
      1500,
    );
    return () => {
      socket.off('typing', listener);
      clearInterval(timer);
    };
  }, [socket, channel.id]);
  async function older() {
    setLoading(true);
    try {
      const data = await api<{ messages: Message[]; hasMore: boolean }>(
        `/channels/${channel.id}/messages?before=${messages[0].id}`,
      );
      const before = list.current?.scrollHeight ?? 0;
      setMessages((prev) => [...data.messages, ...prev]);
      setHasMore(data.hasMore);
      requestAnimationFrame(() => {
        if (list.current) list.current.scrollTop = list.current.scrollHeight - before;
      });
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  function changeDraft(text: string) {
    setDraft(text);
    if (text !== draftRef.current) {
      nonce.current = null;
      draftRef.current = text;
    }
    if (text.trim() && socket?.connected && Date.now() - lastTyping.current > 4000) {
      lastTyping.current = Date.now();
      socket.emit('typing', { channelId: channel.id });
    }
  }
  async function send(e: FormEvent) {
    e.preventDefault();
    if (
      (!draft.trim() && !uploads.assetIds.length && !selectedStickers.length) ||
      sending ||
      uploads.busy
    )
      return;
    setSending(true);
    const content = draft.trim();
    nonce.current ??= crypto.randomUUID();
    const body = {
      content,
      clientNonce: nonce.current,
      replyTo: reply?.id ?? null,
      attachmentIds: uploads.assetIds,
      stickerIds: selectedStickers.map((s) => s.id),
    };
    try {
      let result: { message: Message };
      if (socket?.connected) {
        result = await new Promise((resolve, reject) => {
          socket
            .timeout(8000)
            .emit(
              'message.send',
              { ...body, channelId: channel.id },
              (err: Error | null, res: { ok: boolean; error: string; message: Message }) => {
                if (err)
                  reject(
                    new Error(
                      'Envio não confirmado. Tente novamente; sua mensagem não será duplicada.',
                    ),
                  );
                else if (!res.ok) reject(new Error(res.error));
                else resolve(res);
              },
            );
        });
      } else result = await post(`/channels/${channel.id}/messages`, body);
      scrollNext.current = true;
      setMessages((ms) =>
        [...ms.filter((m) => m.id !== result.message.id), result.message].sort(
          (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
        ),
      );
      setDraft('');
      if (focus) setFocus(null);
      uploads.clear();
      setSelectedStickers([]);
      draftRef.current = '';
      nonce.current = null;
      setReply(null);
      setError('');
      input.current?.focus();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  async function edit(message: Message) {
    try {
      const { message: m } = await patch<{ message: Message }>(`/messages/${message.id}`, {
        content: editText,
        version: message.version,
      });
      setMessages((ms) => ms.map((old) => (old.id === m.id ? m : old)));
      setEditing(null);
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function remove() {
    if (!deleting) return;
    try {
      const { message: m } = await api<{ message: Message }>(`/messages/${deleting.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ version: deleting.version }),
      });
      setMessages((ms) => ms.map((old) => (old.id === m.id ? m : old)));
      setDeleting(null);
    } catch (e) {
      notify((e as Error).message);
    }
  }
  function insert(text: string) {
    const position = input.current?.selectionStart ?? draft.length;
    changeDraft(`${draft.slice(0, position)}${text} ${draft.slice(position)}`);
    setPicker(null);
    input.current?.focus();
  }
  const shown = filter
    ? messages.filter((m) => m.content.toLowerCase().includes(filter.toLowerCase()))
    : messages;
  const canSend = (BigInt(channel.permissions) & 4n) !== 0n,
    canModerate = (BigInt(channel.permissions) & 8n) !== 0n;
  return (
    <div
      className="chat-workspace"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (canSend) {
          uploads.addFiles(Array.from(e.dataTransfer.files));
          nonce.current = null;
        }
      }}
    >
      {dragging && (
        <div className="drop-overlay">
          <Plus size={45} />
          <h2>Solte os arquivos aqui</h2>
          <p>Direto para a conversa, do tamanho que o seu espaço permitir.</p>
        </div>
      )}
      {focus && (
        <div className="context-note">
          Resultado da busca ·{' '}
          <button onClick={() => setFocus(null)}>Voltar às mensagens recentes</button>
        </div>
      )}
      <div
        className={`message-scroll density-${user.preferences.message_density}`}
        ref={list}
        onScroll={() => {
          const el = list.current!;
          scrollNext.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
        style={{ fontSize: user.preferences.chat_font_size }}
      >
        <div className="chat-welcome">
          <div className="welcome-hash">
            <Hash size={35} />
            <span>✦</span>
          </div>
          <h1>
            Esse é o começo de <span>#{channel.name}</span>
          </h1>
          <p>{channel.topic || 'Um espaço para colocar o papo em dia e criar boas memórias.'}</p>
          <span className="welcome-tag">
            <span className="tiny-dot" /> NOSSO PEQUENO UNIVERSO
          </span>
        </div>
        {hasMore && (
          <button className="load-older" disabled={loading} onClick={() => void older()}>
            {loading ? 'Carregando…' : 'Carregar mensagens anteriores'}
          </button>
        )}
        {loading && !messages.length && (
          <div className="loading-inline">
            <Spinner /> Buscando as conversas…
          </div>
        )}
        {filter && (
          <p className="search-note">{shown.length} resultado(s) no histórico carregado.</p>
        )}
        {shown.map((message, index) => {
          const date = new Date(message.created_at).toLocaleDateString('pt-BR', {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            }),
            previous = shown[index - 1],
            newDay =
              !previous ||
              new Date(previous.created_at).toDateString() !==
                new Date(message.created_at).toDateString();
          const member = members.find((m) => m.id === message.author_id);
          const color = member?.roles.find((r) => r.color)?.color;
          return (
            <div
              key={message.id}
              id={`message-${message.id}`}
              className={focus === message.id ? 'message-focus' : ''}
            >
              {newDay && (
                <div className="date-divider">
                  <span>{date}</span>
                </div>
              )}
              <article
                className={`message-row ${message.author_id === user.id ? 'own' : ''} ${message.deleted_at ? 'deleted' : ''}`}
              >
                <Avatar user={message.author} />
                <div className="message-body">
                  {message.reply && (
                    <div className="reply-preview">
                      <CornerUpLeft size={12} />
                      <strong>{message.reply.username}</strong>
                      <span>
                        {message.reply.deleted_at
                          ? 'Mensagem excluída'
                          : message.reply.content.replace(/<@&?[0-9a-f-]{36}>/gi, '@menção')}
                      </span>
                    </div>
                  )}
                  <div className="message-meta">
                    <strong style={{ color: color ?? 'var(--text)' }}>
                      {message.author.username}
                    </strong>
                    {member?.roles[0] && (
                      <span className="role-badge" style={{ color: color ?? 'var(--accent)' }}>
                        {member.roles[0].name}
                      </span>
                    )}
                    <time dateTime={message.created_at}>{time(message.created_at)}</time>
                  </div>
                  {editing === message.id ? (
                    <form
                      className="edit-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void edit(message);
                      }}
                    >
                      <textarea
                        autoFocus
                        required
                        maxLength={4000}
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                      />
                      <span>
                        <button type="button" onClick={() => setEditing(null)}>
                          Cancelar
                        </button>
                        <button type="submit" className="text-link">
                          Salvar
                        </button>
                      </span>
                    </form>
                  ) : (
                    <p className="message-content">
                      {message.deleted_at ? (
                        <em>Mensagem excluída</em>
                      ) : (
                        <MessageText
                          content={message.content}
                          members={members}
                          roles={roles}
                          emojis={message.emojis}
                        />
                      )}{' '}
                      {message.edited_at && !message.deleted_at && <small>(editada)</small>}
                    </p>
                  )}
                  {!message.deleted_at && (
                    <>
                      <div className="message-files">
                        {message.attachments?.map((a) => (
                          <AttachmentView key={a.id} attachment={a} />
                        ))}
                      </div>
                      <div className="message-stickers">
                        {message.stickers?.map((sticker) => (
                          <img
                            key={sticker.id}
                            src={`/api/media/${sticker.asset_id}`}
                            alt={sticker.name}
                          />
                        ))}
                      </div>
                      <div className="reaction-bar">
                        {message.reactions?.map((reaction) => (
                          <button
                            key={reaction.emoji_key}
                            className={reaction.users.includes(user.id) ? 'reacted' : ''}
                            onClick={() =>
                              void api(`/messages/${message.id}/reactions`, {
                                method: 'PUT',
                                body: JSON.stringify(
                                  reaction.custom_emoji_id
                                    ? { customEmojiId: reaction.custom_emoji_id }
                                    : { emoji: reaction.unicode_emoji },
                                ),
                              }).catch((e) => notify(e.message))
                            }
                          >
                            {reaction.custom_emoji_id ? <span>✨</span> : reaction.unicode_emoji}{' '}
                            <span>{reaction.count}</span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
                {!message.deleted_at && (
                  <div className="message-actions">
                    <IconButton label="Adicionar reação" onClick={() => setReacting(message)}>
                      <Smile size={16} />
                    </IconButton>
                    <IconButton
                      label={`Responder ${message.author.username}`}
                      onClick={() => {
                        setReply(message);
                        input.current?.focus();
                      }}
                    >
                      <CornerUpLeft size={16} />
                    </IconButton>
                    {message.author_id === user.id && (
                      <IconButton
                        label="Editar mensagem"
                        onClick={() => {
                          setEditing(message.id);
                          setEditText(message.content);
                        }}
                      >
                        <Pencil size={15} />
                      </IconButton>
                    )}
                    {(message.author_id === user.id || canModerate) && (
                      <IconButton label="Excluir mensagem" onClick={() => setDeleting(message)}>
                        <Trash2 size={15} />
                      </IconButton>
                    )}
                  </div>
                )}
              </article>
            </div>
          );
        })}
        {!loading && !messages.length && (
          <div className="first-message">
            <span>👋</span>
            <p>
              Alguém tem que dar o primeiro oi.
              <br />
              <strong>Que tal você?</strong>
            </p>
          </div>
        )}
      </div>
      <div className="composer-area">
        <UploadTray state={uploads} />
        {selectedStickers.length > 0 && (
          <div className="selected-stickers">
            {selectedStickers.map((s) => (
              <button
                key={s.id}
                title="Remover figurinha"
                onClick={() => setSelectedStickers((old) => old.filter((e) => e.id !== s.id))}
              >
                <img src={`/api/media/${s.asset_id}`} alt={s.name} />
                <X size={12} />
              </button>
            ))}
          </div>
        )}
        {error && (
          <div className="chat-error" role="alert">
            {error}
            <button aria-label="Fechar erro" onClick={() => setError('')}>
              <X size={14} />
            </button>
          </div>
        )}
        {reply && (
          <div className="composing-reply">
            <CornerUpLeft size={14} />
            <span>
              Respondendo a <strong>{reply.author.username}</strong>
            </span>
            <IconButton label="Cancelar resposta" onClick={() => setReply(null)}>
              <X size={14} />
            </IconButton>
          </div>
        )}
        <input
          ref={fileInput}
          type="file"
          aria-label="Selecionar arquivos"
          multiple
          hidden
          onChange={(e) => {
            uploads.addFiles(Array.from(e.target.files ?? []));
            e.target.value = '';
            nonce.current = null;
          }}
        />
        <form className="composer" onSubmit={send}>
          <button
            type="button"
            className="attach-button"
            title="Anexar arquivos"
            aria-label="Anexar arquivos"
            onClick={() => fileInput.current?.click()}
            disabled={!canSend}
          >
            <Plus size={19} />
          </button>
          <textarea
            ref={input}
            aria-label={`Conversar em #${channel.name}`}
            placeholder={canSend ? `Conversar em #${channel.name}` : 'Você só pode ler este canal.'}
            value={draft}
            disabled={!canSend}
            maxLength={4000}
            rows={1}
            onChange={(e) => changeDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(e);
              }
              if (e.key === 'Escape') {
                setReply(null);
                setPicker(null);
              }
            }}
          />
          <div className="composer-tools">
            <IconButton
              label="Mencionar alguém"
              onClick={() => setPicker(picker === 'mention' ? null : 'mention')}
              active={picker === 'mention'}
            >
              <AtSign size={19} />
            </IconButton>
            <IconButton
              label="Inserir emoji"
              onClick={() => setPicker(picker === 'emoji' ? null : 'emoji')}
              active={picker === 'emoji'}
            >
              <Smile size={20} />
            </IconButton>
            <button
              type="button"
              className="picker-text-button"
              aria-label="Escolher figurinha"
              onClick={() => setPicker(picker === 'stickers' ? null : 'stickers')}
            >
              ▧
            </button>
            <button
              type="button"
              className="picker-text-button"
              aria-label="Buscar GIFs"
              onClick={() => setPicker(picker === 'gif' ? null : 'gif')}
            >
              GIF
            </button>
            <span className="tool-divider" />
            <button
              className="send-button"
              type="submit"
              aria-label="Enviar mensagem"
              disabled={
                (!draft.trim() && !uploads.assetIds.length && !selectedStickers.length) ||
                sending ||
                !canSend ||
                uploads.busy
              }
            >
              {sending ? <Spinner /> : <Send size={18} />}
            </button>
          </div>
        </form>
        {picker && (
          <div className="composer-picker">
            {picker !== 'mention' ? (
              <MediaPicker
                kind={picker}
                guildId={channel.guild_id}
                channelId={channel.id}
                onText={insert}
                onAsset={(asset) => {
                  uploads.addAsset(asset);
                  setPicker(null);
                }}
                onSticker={(sticker) => {
                  setSelectedStickers((old) =>
                    [...old.filter((s) => s.id !== sticker.id), sticker].slice(-3),
                  );
                  setPicker(null);
                }}
              />
            ) : (
              <>
                <h4>CHAME ALGUÉM PARA A CONVERSA</h4>
                {members.map((m) => (
                  <button key={m.id} onClick={() => insert(`<@${m.id}>`)}>
                    <Avatar user={m} size={26} />
                    <span>
                      {m.username}
                      <small>#{m.tag}</small>
                    </span>
                  </button>
                ))}
                {roles
                  .filter((r) => !r.is_everyone)
                  .map((r) => (
                    <button key={r.id} onClick={() => insert(`<@&${r.id}>`)}>
                      <AtSign size={17} />
                      <span style={{ color: r.color ?? 'var(--text)' }}>{r.name}</span>
                    </button>
                  ))}
                {(BigInt(channel.permissions) & 64n) !== 0n && (
                  <button onClick={() => insert('@everyone')}>
                    <AtSign size={17} /> todos do servidor
                  </button>
                )}
              </>
            )}
          </div>
        )}
        <div className="composer-foot">
          <span>
            {Object.keys(typing).length ? (
              <>
                <i className="typing-dots">•••</i>{' '}
                {Object.values(typing)
                  .map((t) => t.name)
                  .join(', ')}{' '}
                digitando…
              </>
            ) : (
              <>
                <span className="keyboard-key">↵</span> para enviar{' '}
                <span className="foot-dot">·</span> Shift + Enter para uma nova linha
              </>
            )}
          </span>
          <span>{draft.length > 3500 ? `${draft.length}/4000` : 'Feito de boas conversas ♡'}</span>
        </div>
      </div>
      {deleting && (
        <Modal
          title="Excluir esta mensagem?"
          subtitle="As respostas continuarão indicando que ela foi excluída."
          onClose={() => setDeleting(null)}
        >
          <blockquote>{deleting.content}</blockquote>
          <div className="modal-actions">
            <button className="secondary" onClick={() => setDeleting(null)}>
              Cancelar
            </button>
            <button className="danger" onClick={() => void remove()}>
              Excluir mensagem
            </button>
          </div>
        </Modal>
      )}
      {reacting && (
        <Modal title="Reagir à mensagem" onClose={() => setReacting(null)}>
          <MediaPicker
            kind="emoji"
            guildId={channel.guild_id}
            channelId={channel.id}
            onAsset={() => {}}
            onSticker={() => {}}
            onText={(emoji) => {
              void api(`/messages/${reacting.id}/reactions`, {
                method: 'PUT',
                body: JSON.stringify({ emoji }),
              })
                .then(() => setReacting(null))
                .catch((e) => notify(e.message));
            }}
            onCustomEmoji={(e) => {
              void api(`/messages/${reacting.id}/reactions`, {
                method: 'PUT',
                body: JSON.stringify({ customEmojiId: e.id }),
              })
                .then(() => setReacting(null))
                .catch((err) => notify(err.message));
            }}
          />
        </Modal>
      )}
    </div>
  );
}
