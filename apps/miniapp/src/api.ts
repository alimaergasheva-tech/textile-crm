const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "/api";
let token: string | null = null;
export const setToken = (t: string | null) => { token = t; };

export class ApiError extends Error { constructor(public status: number, msg: string) { super(msg); } }

/** Ошибка сети (нет связи) — отличаем от ответа сервера: сетевые запросы повторяем, ответы сервера — нет. */
export const isNetwork = (e: unknown) => !(e instanceof ApiError);

export async function api<T = any>(path: string, init: RequestInit & { key?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  if (init.key) headers["idempotency-key"] = init.key;
  const r = await fetch(BASE + path, { ...init, headers });
  if (!r.ok) {
    let msg = String(r.status);
    try { const b = await r.json(); msg = (Array.isArray(b.message) ? b.message.join("; ") : b.message) ?? msg; } catch { /* не JSON */ }
    throw new ApiError(r.status, msg);
  }
  return r.status === 204 ? (undefined as T) : r.json();
}

/** Бинарный ответ с авторизацией → временный адрес для <img>. */
export async function blobUrl(path: string): Promise<string> {
  const r = await fetch(BASE + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!r.ok) throw new ApiError(r.status, String(r.status));
  return URL.createObjectURL(await r.blob());
}
