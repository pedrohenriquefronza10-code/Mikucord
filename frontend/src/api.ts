export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
let refreshPromise: Promise<boolean> | null = null;
export function refreshSession(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;
  const work = async () => {
    if ((await fetch('/api/me', { credentials: 'include' })).ok) return true;
    return (
      await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).ok;
  };
  const pending: Promise<boolean> = Promise.resolve(
    navigator.locks
      ? navigator.locks.request('tetocord-refresh', async () => await work())
      : work(),
  );
  refreshPromise = pending.finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const init = {
    ...options,
    credentials: 'include' as const,
    headers:
      options.body === undefined || options.body instanceof FormData
        ? options.headers
        : { 'Content-Type': 'application/json', ...options.headers },
  };
  let response = await fetch(`/api${path}`, init);
  if (response.status === 401 && !path.startsWith('/auth/') && (await refreshSession()))
    response = await fetch(`/api${path}`, init);
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ error: 'Não foi possível conectar. Tente novamente.' }));
    if (response.status === 401 && !path.startsWith('/auth/'))
      window.dispatchEvent(new Event('session.expired'));
    throw new ApiError(error.error ?? 'Algo deu errado. Tente novamente.', response.status);
  }
  return response.json();
}
export const post = <T>(path: string, body: unknown = {}) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
