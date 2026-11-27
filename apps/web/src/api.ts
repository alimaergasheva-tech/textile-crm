const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
let token: string | null = null;
export const setToken = (t: string | null) => { token = t; };
export const hasToken = () => token !== null;

async function raw(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(BASE + path, {
    ...init, credentials: "include",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
  });
}

/** Обновляет токен по refresh-cookie. Возвращает true, если получилось. */
export async function refresh(): Promise<boolean> {
  const r = await raw("/auth/refresh", { method: "POST" });
  if (!r.ok) { token = null; return false; }
  token = (await r.json()).accessToken;
  return true;
}

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  let r = await raw(path, init);
  if (r.status === 401 && (await refresh())) r = await raw(path, init);
  if (!r.ok) {
    // Сообщение сервера (например, «Недостаточно остатка») показываем как есть
    let msg = r.status === 403 ? "403" : `${r.status}`;
    try { const b = await r.json(); const m = Array.isArray(b.message) ? b.message.join("; ") : b.message; if (m) msg = `${r.status}: ${m}`; } catch { /* не JSON */ }
    throw new Error(msg);
  }
  return r.status === 204 ? (undefined as T) : r.json();
}

export async function login(tenant: string, email: string, password: string) {
  const r = await raw("/auth/login", { method: "POST", body: JSON.stringify({ tenant, email, password }) });
  if (!r.ok) throw new Error("login");
  token = (await r.json()).accessToken;
}
export async function logout() { await raw("/auth/logout", { method: "POST" }); token = null; }

/** Скачивает бинарный ответ (PDF) с авторизацией и открывает в новой вкладке. */
export async function openPdf(path: string): Promise<void> {
  let r = await raw(path);
  if (r.status === 401 && (await refresh())) r = await raw(path);
  if (!r.ok) throw new Error(`${r.status}`);
  const url = URL.createObjectURL(await r.blob());
  window.open(url, "_blank");
}

/** Скачивает файл (CSV) с авторизацией. */
export async function downloadFile(path: string, filename: string): Promise<void> {
  let r = await raw(path);
  if (r.status === 401 && (await refresh())) r = await raw(path);
  if (!r.ok) throw new Error(`${r.status}`);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(await r.blob());
  a.download = filename;
  a.click();
}

/** Бинарный ответ с авторизацией → временный адрес для <img>. */
export async function blobUrl(path: string): Promise<string> {
  let r = await raw(path);
  if (r.status === 401 && (await refresh())) r = await raw(path);
  if (!r.ok) throw new Error(`${r.status}`);
  return URL.createObjectURL(await r.blob());
}
