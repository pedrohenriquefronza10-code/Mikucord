import { useEffect, useState } from 'react';
import { MessageCircle, Plus, Search, Users } from 'lucide-react';
import { api, post } from './api';
import { Avatar, ErrorText } from './ui';
import { useStore } from './store';
import type { Channel, User } from './types';
type Person = Pick<User, 'id' | 'username' | 'tag' | 'avatar_asset_id' | 'accent_color'> & {
  status?: string;
  custom_status_text?: string;
};
type FriendRequest = {
  id: string;
  sender_id: string;
  recipient_id: string;
  sender_name: string;
  sender_tag: string;
  recipient_name: string;
  recipient_tag: string;
};
export function DirectSidebar({
  tick,
  onSelect,
  onHome,
}: {
  tick: number;
  onSelect: (id: string) => void;
  onHome: () => void;
}) {
  const [conversations, setConversations] = useState<Channel[]>([]),
    user = useStore((s) => s.user)!,
    selected = useStore((s) => s.channelId);
  useEffect(() => {
    void api<{ channels: Channel[] }>('/conversations')
      .then((r) => setConversations(r.channels))
      .catch(() => {});
  }, [tick, user.id]);
  return (
    <div className="direct-sidebar">
      <button className="channel-link" onClick={onHome}>
        <Users size={18} /> Amigos e conversas
      </button>
      <div className="channel-section-head">
        <span>MENSAGENS DIRETAS</span>
        <button aria-label="Nova conversa" onClick={onHome}>
          <Plus size={14} />
        </button>
      </div>
      {conversations.map((c) => (
        <button
          key={c.id}
          className={`channel-link ${selected === c.id ? 'selected' : ''}`}
          onClick={() => onSelect(c.id)}
        >
          <MessageCircle size={17} />
          <span>
            {c.type === 'group_dm'
              ? c.name
              : (c.members?.find((m) => m.id !== user.id)?.username ?? c.name)}
          </span>
        </button>
      ))}
      {!conversations.length && <p className="field-note">Suas conversas vão aparecer aqui.</p>}
    </div>
  );
}
export function SocialPanel({
  tick,
  onConversation,
}: {
  tick: number;
  onConversation: (id: string) => void;
}) {
  const user = useStore((s) => s.user)!,
    notify = useStore((s) => s.notify),
    [tab, setTab] = useState('friends'),
    [friends, setFriends] = useState<Person[]>([]),
    [requests, setRequests] = useState<FriendRequest[]>([]),
    [blocks, setBlocks] = useState<Person[]>([]),
    [query, setQuery] = useState(''),
    [results, setResults] = useState<Person[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [groupName, setGroupName] = useState(''),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    void api<{ friends: Person[]; requests: FriendRequest[]; blocks: Person[] }>('/friends')
      .then((r) => {
        setFriends(r.friends);
        setRequests(r.requests);
        setBlocks(r.blocks);
      })
      .catch((e) => setError(e.message));
  }, [tick, revision]);
  async function act(path: string, method: string, body?: unknown) {
    setError('');
    try {
      await api(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      setRevision((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function conversation(ids: string[], name?: string) {
    try {
      const r = await post<{ channel: Channel }>('/conversations', {
        members: ids,
        ...(name ? { name } : {}),
      });
      onConversation(r.channel.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="social-panel">
      <header>
        <div>
          <span className="eyebrow">AS CONVERSAS QUE IMPORTAM</span>
          <h1>Quem faz parte do seu mundo?</h1>
          <p>Chame um amigo ou reúna a turma numa conversa.</p>
        </div>
        <Users size={40} />
      </header>
      <div className="settings-tabs">
        <button className={tab === 'friends' ? 'selected' : ''} onClick={() => setTab('friends')}>
          Amigos ({friends.length})
        </button>
        <button className={tab === 'requests' ? 'selected' : ''} onClick={() => setTab('requests')}>
          Pedidos ({requests.length})
        </button>
        <button className={tab === 'find' ? 'selected' : ''} onClick={() => setTab('find')}>
          Adicionar
        </button>
        <button className={tab === 'groups' ? 'selected' : ''} onClick={() => setTab('groups')}>
          Criar grupo
        </button>
        <button className={tab === 'blocked' ? 'selected' : ''} onClick={() => setTab('blocked')}>
          Bloqueados
        </button>
      </div>
      <ErrorText error={error} />
      {tab === 'friends' && (
        <>
          <div className="people-list">
            {friends.map((person) => (
              <div key={person.id}>
                <Avatar user={person} status={person.status} />
                <span>
                  <strong>
                    {person.username}
                    <small>#{person.tag}</small>
                  </strong>
                  <small>{person.custom_status_text || person.status}</small>
                </span>
                <button className="secondary" onClick={() => void conversation([person.id])}>
                  <MessageCircle size={15} /> Conversar
                </button>
                <button
                  className="danger-link"
                  onClick={() => void act(`/people/${person.id}/block`, 'PUT')}
                >
                  Bloquear
                </button>
                <button
                  className="text-link"
                  onClick={() => void act(`/friends/${person.id}`, 'DELETE')}
                >
                  Remover
                </button>
              </div>
            ))}
          </div>
          {!friends.length && (
            <p className="empty-copy">
              Toda boa amizade começa com um oi. Adicione alguém pelo nome e tag.
            </p>
          )}
        </>
      )}
      {tab === 'find' && (
        <>
          <form
            className="inline-form"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                setResults(
                  (await api<{ users: Person[] }>(`/people?q=${encodeURIComponent(query)}`)).users,
                );
                setError('');
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          >
            <input
              aria-label="Nome e tag do amigo"
              placeholder="seuamigo#1234 ou alguém de um servidor"
              minLength={2}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button className="primary">
              <Search size={16} /> Buscar
            </button>
          </form>
          <div className="people-list">
            {results.map((person) => (
              <div key={person.id}>
                <Avatar user={person} />
                <span>
                  <strong>
                    {person.username}
                    <small>#{person.tag}</small>
                  </strong>
                </span>
                <button
                  className="primary"
                  onClick={() =>
                    void act('/friends/requests', 'POST', { userId: person.id }).then(() =>
                      notify('Pedido processado. Confira a aba de pedidos.'),
                    )
                  }
                >
                  Adicionar amigo
                </button>
                <button className="secondary" onClick={() => void conversation([person.id])}>
                  Conversar
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      {tab === 'requests' && (
        <div className="people-list">
          {requests.map((request) => (
            <div key={request.id}>
              <span>
                <strong>
                  {request.sender_id === user.id ? request.recipient_name : request.sender_name}
                </strong>
                <small>
                  {request.sender_id === user.id ? 'Pedido enviado' : 'Quer ser seu amigo'}
                </small>
              </span>
              {request.recipient_id === user.id ? (
                <>
                  <button
                    className="primary"
                    onClick={() =>
                      void act(`/friends/requests/${request.id}`, 'PATCH', { action: 'accept' })
                    }
                  >
                    Aceitar
                  </button>
                  <button
                    className="secondary"
                    onClick={() =>
                      void act(`/friends/requests/${request.id}`, 'PATCH', { action: 'decline' })
                    }
                  >
                    Recusar
                  </button>
                </>
              ) : (
                <button
                  className="secondary"
                  onClick={() =>
                    void act(`/friends/requests/${request.id}`, 'PATCH', { action: 'cancel' })
                  }
                >
                  Cancelar
                </button>
              )}
            </div>
          ))}
          {!requests.length && <p className="empty-copy">Nenhum pedido pendente.</p>}
        </div>
      )}
      {tab === 'groups' && (
        <form
          className="stack-form"
          onSubmit={(e) => {
            e.preventDefault();
            void conversation(selected, groupName);
          }}
        >
          <label>
            Nome do grupo
            <input
              aria-label="Nome do grupo"
              required
              value={groupName}
              maxLength={100}
              onChange={(e) => setGroupName(e.target.value)}
            />
          </label>
          <p className="field-note">Escolha quem vai entrar na conversa.</p>
          {friends.map((friend) => (
            <label className="check-row" key={friend.id}>
              <input
                type="checkbox"
                checked={selected.includes(friend.id)}
                onChange={(e) =>
                  setSelected((ids) =>
                    e.target.checked ? [...ids, friend.id] : ids.filter((id) => id !== friend.id),
                  )
                }
              />
              {friend.username}
            </label>
          ))}
          <button className="primary" disabled={!selected.length}>
            Criar grupo
          </button>
        </form>
      )}
      {tab === 'blocked' && (
        <div className="people-list">
          {blocks.map((person) => (
            <div key={person.id}>
              <span>
                {person.username}#{person.tag}
              </span>
              <button
                className="secondary"
                onClick={() => void act(`/people/${person.id}/block`, 'DELETE')}
              >
                Desbloquear
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
