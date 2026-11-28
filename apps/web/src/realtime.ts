import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

/** Какие кэши обновлять при событии канала. Новые модули добавляют свои каналы сюда. */
const CHANNEL_KEYS: Record<string, string[][]> = {
  tasks: [["tasks"], ["tasksSummary"]],
  deals: [["deals"]],
  locks: [["locks"]],
  departments: [["departments"], ["myDepartments"]],
};

interface Ev { id: string; channel: string; kind: string; entity: string | null; entity_id: string | null; actor_id: string | null }

/**
 * Живое обновление экранов: раз в несколько секунд спрашивает ленту изменений и перечитывает затронутые данные.
 * Опрос идёт только пока вкладка открыта; при возврате на вкладку выполняется сразу.
 * Работает и на serverless-хостинге: постоянное соединение не требуется.
 */
export function useRealtime(intervalMs = 4000) {
  const qc = useQueryClient();
  const cursor = useRef<string | null>(null);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stop) return;
      if (!document.hidden) {
        try {
          const r = await api<{ cursor: string; events: Ev[] }>(cursor.current === null ? "/events" : `/events?since=${cursor.current}`);
          cursor.current = r.cursor;
          const keys = new Set<string>();
          for (const e of r.events) for (const k of CHANNEL_KEYS[e.channel] ?? []) keys.add(JSON.stringify(k));
          for (const k of keys) void qc.invalidateQueries({ queryKey: JSON.parse(k) });
        } catch { /* нет связи: повторим на следующем шаге */ }
      }
      timer = setTimeout(tick, intervalMs);
    };
    const onVisible = () => { if (!document.hidden) { if (timer) clearTimeout(timer); void tick(); } };
    document.addEventListener("visibilitychange", onVisible);
    void tick();
    return () => { stop = true; if (timer) clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [qc, intervalMs]);
}

/**
 * Мягкий замок на время правки: занимает объект при открытии формы, продлевает раз в минуту и снимает при закрытии.
 * holder — имя того, кто уже редактирует (тогда форму нужно показать только для чтения).
 */
export function useEditLock(entity: string, entityId: string | null) {
  const [holder, setHolder] = useState<string | null>(null);
  useEffect(() => {
    if (!entityId) return;
    let stop = false;
    const take = async () => {
      try { await api("/locks", { method: "POST", body: JSON.stringify({ entity, entityId }) }); if (!stop) setHolder(null); }
      catch (e) { if (!stop) setHolder(/^409: Сейчас редактирует (.+)$/.exec((e as Error).message)?.[1] ?? "?"); }
    };
    void take();
    const timer = setInterval(take, 60_000);
    return () => { stop = true; clearInterval(timer); void api(`/locks/${entity}/${entityId}`, { method: "DELETE" }).catch(() => undefined); };
  }, [entity, entityId]);
  return { holder, readOnly: holder !== null };
}
