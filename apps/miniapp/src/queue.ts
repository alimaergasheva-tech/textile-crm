import { api, ApiError, isNetwork } from "./api";

/**
 * Очередь отметок: каждая получает уникальный ключ при создании и хранится на телефоне, пока сервер не подтвердит.
 * При обрыве связи отправка повторяется с тем же ключом — сервер не создаёт дубль (Idempotency-Key).
 * Отклонённые сервером (4xx, кроме 401) отметки из очереди убираются и показываются как ошибка.
 */
export interface QItem { key: string; path: string; method: string; body: unknown; label: string }
const KEY = "queue.v1";
const read = (): QItem[] => { try { return JSON.parse(localStorage.getItem(KEY) ?? "[]"); } catch { return []; } };
const write = (q: QItem[]) => localStorage.setItem(KEY, JSON.stringify(q));
const listeners = new Set<() => void>();
export const onQueue = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
const emit = () => listeners.forEach((f) => f());
export const queueSize = () => read().length;
export const lastErrors: string[] = [];

export function enqueue(item: Omit<QItem, "key">): QItem {
  const key = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const full = { ...item, key };
  write([...read(), full]);
  emit();
  void flush();
  return full;
}

let flushing = false;
export async function flush(onAuthLost?: () => Promise<boolean>) {
  if (flushing) return;
  flushing = true;
  try {
    for (const it of read()) {
      try {
        await api(it.path, { method: it.method, body: JSON.stringify(it.body), key: it.key });
      } catch (e) {
        if (isNetwork(e)) break;                                  // нет связи: оставляем, повторим позже
        const err = e as ApiError;
        if (err.status === 401 && onAuthLost && (await onAuthLost())) { flushing = false; return flush(); }
        if (err.status === 401) break;
        lastErrors.push(`${it.label}: ${err.message}`);          // сервер отказал: повтор не поможет
      }
      write(read().filter((x) => x.key !== it.key));
      emit();
    }
  } finally { flushing = false; emit(); }
}
