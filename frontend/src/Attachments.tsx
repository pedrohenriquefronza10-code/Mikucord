import { useEffect, useRef, useState } from 'react';
import { Download, File, RotateCcw, X } from 'lucide-react';
import { api, post, refreshSession } from './api';
import { useStore } from './store';
export type Asset = { id: string; filename: string; size_bytes: string; mime: string };
export type Attachment = Asset;
type Upload = {
  key: string;
  file?: File;
  nonce: string;
  sessionId?: string;
  asset?: Asset;
  state: 'queued' | 'uploading' | 'verifying' | 'ready' | 'error';
  progress: number;
  error?: string;
};
export const formatBytes = (s: string | number) => {
  let value = Number(s),
    unit = 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
};
async function sendPart(
  session: string,
  part: number,
  blob: Blob,
  signal: AbortSignal,
  onProgress: (n: number) => void,
): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await new Promise<{ status: number; error?: string; retry: number }>(
      (resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', `/api/uploads/${session}/parts/${part}`);
        xhr.withCredentials = true;
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.upload.onprogress = (e) => onProgress(e.loaded);
        const abort = () => xhr.abort();
        signal.addEventListener('abort', abort, { once: true });
        xhr.onloadend = () => signal.removeEventListener('abort', abort);
        xhr.onabort = () => reject(new DOMException('Envio cancelado.', 'AbortError'));
        xhr.onerror = () => resolve({ status: 0, error: 'Conexão interrompida.', retry: 2 });
        xhr.onload = () => {
          let body;
          try {
            body = JSON.parse(xhr.responseText);
          } catch {}
          resolve({
            status: xhr.status,
            error: body?.error,
            retry: Math.min(15, Number(xhr.getResponseHeader('Retry-After')) || 2),
          });
        };
        if (signal.aborted) {
          reject(new DOMException('Envio cancelado.', 'AbortError'));
          return;
        }
        xhr.send(blob);
      },
    );
    if (result.status >= 200 && result.status < 300) return;
    if (result.status === 401 && (await refreshSession())) continue;
    if ((result.status === 429 || result.status === 0 || result.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, result.retry * 1000));
      continue;
    }
    throw new Error(result.error ?? 'Não foi possível enviar esta parte. Tente novamente.');
  }
  throw new Error('Não foi possível retomar o envio.');
}
export function useUploads(channel: string) {
  const [uploads, setUploads] = useState<Upload[]>([]),
    controllers = useRef(new Map<string, AbortController>()),
    active = useRef(true),
    waiting = useRef<Upload[]>([]),
    running = useRef(0);
  const update = (key: string, patch: Partial<Upload>) => {
    if (active.current)
      setUploads((all) => all.map((u) => (u.key === key ? { ...u, ...patch } : u)));
  };
  async function run(upload: Upload) {
    const controller = new AbortController();
    controllers.current.set(upload.key, controller);
    running.current++;
    update(upload.key, { state: 'uploading', error: undefined });
    try {
      let session = upload.sessionId;
      if (!session) {
        const result = await post<{ upload: { id: string } }>(`/channels/${channel}/uploads`, {
          filename: upload.file!.name,
          size: String(upload.file!.size),
          clientNonce: upload.nonce,
        });
        session = result.upload.id;
        upload.sessionId = session;
        update(upload.key, { sessionId: session });
      }
      const status = await api<{
        upload: {
          state: string;
          partSize: number;
          parts: Array<{ part_number: number; size_bytes: string }>;
          asset: Asset | null;
        };
      }>(`/uploads/${session}`);
      if (status.upload.asset) {
        update(upload.key, { asset: status.upload.asset, state: 'ready', progress: 100 });
        return;
      }
      const partSize = status.upload.partSize,
        done = new Map(status.upload.parts.map((p) => [p.part_number, Number(p.size_bytes)]));
      let complete = [...done.values()].reduce((a, b) => a + b, 0);
      const file = upload.file!;
      for (let offset = 0, part = 1; offset < file.size; offset += partSize, part++) {
        if (controller.signal.aborted) throw new DOMException('Cancelado', 'AbortError');
        if (done.has(part)) continue;
        const chunk = file.slice(offset, Math.min(file.size, offset + partSize));
        await sendPart(session, part, chunk, controller.signal, (n) =>
          update(upload.key, { progress: Math.min(99, ((complete + n) / file.size) * 100) }),
        );
        complete += chunk.size;
      }
      if (controller.signal.aborted) throw new DOMException('Cancelado', 'AbortError');
      update(upload.key, { state: 'verifying', progress: 100 });
      const result = await post<{ asset: Asset }>(`/uploads/${session}/complete`);
      update(upload.key, { asset: result.asset, state: 'ready' });
    } catch (e) {
      if ((e as Error).name !== 'AbortError')
        update(upload.key, { state: 'error', error: (e as Error).message });
    } finally {
      controllers.current.delete(upload.key);
      running.current--;
      drain();
    }
  }
  function drain() {
    if (!active.current) return;
    while (running.current < 2 && waiting.current.length) {
      const next = waiting.current.shift()!;
      void run(next);
    }
  }
  const addFiles = (files: File[]) => {
    const next = files
      .filter((f) => f.size > 0)
      .map((file) => ({
        key: crypto.randomUUID(),
        file,
        nonce: crypto.randomUUID(),
        state: 'queued' as const,
        progress: 0,
      }));
    if (!next.length) {
      useStore.getState().notify('Arquivos vazios não podem ser enviados.');
      return;
    }
    const room = 20 - uploads.length,
      accepted = next.slice(0, room);
    setUploads((old) => [...old, ...accepted]);
    waiting.current.push(...accepted);
    queueMicrotask(drain);
    if (next.length > room) useStore.getState().notify('Envie até 20 arquivos por mensagem.');
  };
  function remove(key: string) {
    controllers.current.get(key)?.abort();
    waiting.current = waiting.current.filter((u) => u.key !== key);
    const item = uploads.find((u) => u.key === key);
    if (item?.sessionId && !item.asset)
      void api(`/uploads/${item.sessionId}`, { method: 'DELETE' }).catch(() => {});
    setUploads((old) => old.filter((u) => u.key !== key));
  }
  function retry(key: string) {
    const item = uploads.find((u) => u.key === key);
    if (item) {
      waiting.current.push(item);
      update(key, { state: 'queued' });
      drain();
    }
  }
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      for (const c of controllers.current.values()) c.abort();
    };
  }, [channel]);
  return {
    uploads,
    addFiles,
    remove,
    retry,
    addAsset: (asset: Asset) =>
      setUploads((old) => [
        ...old,
        {
          key: crypto.randomUUID(),
          nonce: crypto.randomUUID(),
          asset,
          state: 'ready',
          progress: 100,
        },
      ]),
    clear: () => setUploads([]),
    busy: uploads.some((u) => u.state !== 'ready'),
    assetIds: uploads.flatMap((u) => (u.asset ? [u.asset.id] : [])),
  };
}
export function UploadTray({ state }: { state: ReturnType<typeof useUploads> }) {
  return state.uploads.length ? (
    <div className="upload-tray">
      {state.uploads.map((u) => (
        <div key={u.key} className={`upload-draft ${u.state}`}>
          <File size={22} />
          <span>
            <strong>{u.asset?.filename ?? u.file?.name}</strong>
            <small>
              {u.error ??
                (u.state === 'ready'
                  ? `${formatBytes(u.asset!.size_bytes)} · Pronto`
                  : u.state === 'verifying'
                    ? 'Verificando o arquivo…'
                    : `${formatBytes(u.file?.size ?? 0)} · ${Math.floor(u.progress)}%`)}
            </small>
            <progress value={u.progress} max={100} />
          </span>
          {u.state === 'error' && (
            <button type="button" title="Retomar envio" onClick={() => state.retry(u.key)}>
              <RotateCcw size={15} />
            </button>
          )}
          <button type="button" title="Remover arquivo" onClick={() => state.remove(u.key)}>
            <X size={15} />
          </button>
        </div>
      ))}
    </div>
  ) : null;
}
export function AttachmentView({ attachment }: { attachment: Attachment }) {
  const [progress, setProgress] = useState<number | null>(null),
    [failed, setFailed] = useState(false),
    notify = useStore((s) => s.notify);
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (
        event.origin !== location.origin ||
        event.data?.type !== 'tetocord-download' ||
        event.data.assetId !== attachment.id
      )
        return;
      if (event.data.error) {
        notify(event.data.error);
        setProgress(null);
      } else {
        setProgress(event.data.total ? (event.data.loaded / event.data.total) * 100 : 0);
        if (event.data.done) setTimeout(() => setProgress(null), 3000);
      }
    };
    navigator.serviceWorker?.addEventListener('message', listener);
    return () => navigator.serviceWorker?.removeEventListener('message', listener);
  }, [attachment.id, notify]);
  async function download() {
    try {
      await refreshSession();
      if (navigator.serviceWorker?.controller) {
        const iframe = document.createElement('iframe');
        iframe.hidden = true;
        iframe.src = `/__download/${attachment.id}`;
        document.body.appendChild(iframe);
        setProgress(0);
        setTimeout(() => iframe.remove(), 3600000);
      } else {
        const a = document.createElement('a');
        a.href = `/api/attachments/${attachment.id}/download`;
        a.download = attachment.filename;
        a.click();
        notify('Download iniciado no gerenciador do navegador.');
      }
    } catch (e) {
      notify((e as Error).message);
    }
  }
  const src = `/api/attachments/${attachment.id}/content`;
  return (
    <div className="attachment-view">
      {!failed && /^image\/(jpeg|png|gif|webp|avif)$/.test(attachment.mime) && (
        <img
          className="attachment-image"
          loading="lazy"
          src={src}
          alt={attachment.filename}
          onError={() => setFailed(true)}
        />
      )}{' '}
      {!failed && /^video\/(mp4|webm|quicktime)$/.test(attachment.mime) && (
        <video controls preload="metadata" src={src} onError={() => setFailed(true)} />
      )}{' '}
      {!failed && /^audio\//.test(attachment.mime) && (
        <audio controls preload="metadata" src={src} onError={() => setFailed(true)} />
      )}
      <div className="attachment-card">
        <File size={23} />
        <span>
          <strong>{attachment.filename}</strong>
          <small>
            {formatBytes(attachment.size_bytes)}
            {progress !== null ? ` · ${Math.round(progress)}%` : ''}
          </small>
          {progress !== null && <progress value={progress} max={100} />}
        </span>
        <button
          aria-label={`Baixar ${attachment.filename}`}
          title="Baixar arquivo"
          onClick={() => void download()}
        >
          <Download size={18} />
        </button>
      </div>
    </div>
  );
}
