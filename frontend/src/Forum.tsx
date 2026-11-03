import { useState } from 'react';
import { post } from './api';
import { ErrorText } from './ui';
import type { Channel } from './types';
export function ForumPanel({
  forum,
  channels,
  onOpen,
  onChanged,
}: {
  forum: Channel;
  channels: Channel[];
  onOpen: (id: string) => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState(''),
    [content, setContent] = useState(''),
    [error, setError] = useState('');
  return (
    <div className="forum-panel">
      <header>
        <h1>☕ {forum.name}</h1>
        <p>{forum.topic || 'Cada assunto merece a sua conversa.'}</p>
      </header>
      <div className="forum-threads">
        {channels
          .filter((c) => c.parent_id === forum.id && c.type === 'thread')
          .map((c) => (
            <button key={c.id} onClick={() => onOpen(c.id)}>
              <strong>{c.name}</strong>
              <span>{c.topic || 'Abrir conversa →'}</span>
            </button>
          ))}
      </div>
      <form
        className="stack-form"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const r = await post<{ channel: Channel }>(`/guilds/${forum.guild_id}/channels`, {
              name,
              type: 'thread',
              parentId: forum.id,
              topic: content.slice(0, 1024),
            });
            if (content.trim())
              await post(`/channels/${r.channel.id}/messages`, {
                content,
                clientNonce: crypto.randomUUID(),
              });
            setName('');
            setContent('');
            onChanged();
            onOpen(r.channel.id);
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <h3>Começar uma conversa</h3>
        <label>
          Assunto
          <input
            aria-label="Assunto da conversa"
            value={name}
            maxLength={100}
            required
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Primeira mensagem
          <textarea
            value={content}
            maxLength={4000}
            required
            onChange={(e) => setContent(e.target.value)}
          />
        </label>
        <button className="primary">Publicar conversa</button>
        <ErrorText error={error} />
      </form>
    </div>
  );
}
