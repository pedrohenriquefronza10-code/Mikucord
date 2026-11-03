import { useEffect, useState, type FormEvent } from 'react';
import { api, post } from './api';
import { EmojiPicker } from './EmojiPicker';
import { ErrorText, Spinner } from './ui';
import type { Asset } from './Attachments';
import type { Catalog, Expression } from './types';
export function MediaPicker({
  kind,
  guildId,
  channelId,
  onText,
  onAsset,
  onSticker,
  onCustomEmoji,
}: {
  kind: 'emoji' | 'stickers' | 'gif';
  guildId?: string | null;
  channelId: string;
  onText: (s: string) => void;
  onAsset: (asset: Asset) => void;
  onSticker: (e: Expression) => void;
  onCustomEmoji?: (e: Expression) => void;
}) {
  const [catalog, setCatalog] = useState<Catalog>({ emoji: [], sticker: [], sound: [] }),
    [q, setQ] = useState(''),
    [gifs, setGifs] = useState<Array<{ id: string; preview: string; name: string }>>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (guildId)
      void api<Catalog>(`/guilds/${guildId}/catalog`)
        .then(setCatalog)
        .catch(() => {});
  }, [guildId]);
  async function search(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ gifs: typeof gifs }>(`/gifs?q=${encodeURIComponent(q)}`);
      setGifs(r.gifs);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (kind === 'gif') void search();
  }, [kind]);
  async function chooseGif(gifId: string) {
    setBusy(true);
    setError('');
    try {
      const r = await post<{ asset: Asset }>(`/channels/${channelId}/gifs`, { gifId });
      onAsset(r.asset);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={`rich-picker ${kind}`}>
      <ErrorText error={error} />
      {kind === 'emoji' ? (
        <>
          {catalog.emoji.length > 0 && (
            <div className="custom-emoji-grid">
              {catalog.emoji.map((e) => (
                <button
                  key={e.id}
                  title={`:${e.name}:`}
                  onClick={() =>
                    onCustomEmoji ? onCustomEmoji(e) : onText(`<:${e.id}:${e.name}:>`)
                  }
                >
                  <img src={`/api/media/${e.asset_id}`} alt={e.name} />
                </button>
              ))}
            </div>
          )}
          <EmojiPicker onSelect={(e) => e.native && onText(e.native)} />
        </>
      ) : kind === 'stickers' ? (
        <>
          <h4>FIGURINHAS DO SERVIDOR</h4>
          <div className="sticker-grid">
            {catalog.sticker.map((e) => (
              <button key={e.id} title={e.name} onClick={() => onSticker(e)}>
                <img src={`/api/media/${e.asset_id}`} alt={e.name} />
              </button>
            ))}
          </div>
          {!catalog.sticker.length && (
            <p className="field-note">Ainda não há figurinhas neste servidor.</p>
          )}
        </>
      ) : (
        <>
          <form className="gif-search" onSubmit={search}>
            <input
              aria-label="Buscar GIFs"
              placeholder="Buscar GIFs no Tenor"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <button className="primary" disabled={busy}>
              Buscar
            </button>
          </form>
          {busy && <Spinner />}
          <div className="gif-grid">
            {gifs.map((g) => (
              <button key={g.id} disabled={busy} onClick={() => void chooseGif(g.id)}>
                <img loading="lazy" src={g.preview} alt={g.name} />
              </button>
            ))}
          </div>
          <small className="muted">GIFs por Tenor</small>
        </>
      )}
    </div>
  );
}
