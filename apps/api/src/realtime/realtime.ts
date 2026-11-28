import type pg from "pg";

export interface RtEvent {
  channel: string;                 // tasks | deals | locks | departments ...
  kind: string;                    // created | updated | moved | locked | unlocked ...
  entity?: string; entityId?: string; actorId?: string;
  /** Только идентификаторы и коды: данные экран перечитывает сам с проверкой прав. */
  payload?: Record<string, unknown>;
}

/** Кладёт событие в ленту изменений в той же транзакции, что и само изменение. */
export async function publish(c: pg.PoolClient, tenantId: string, e: RtEvent): Promise<void> {
  await c.query(
    `INSERT INTO realtime_events (tenant_id,channel,kind,entity,entity_id,actor_id,payload) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [tenantId, e.channel, e.kind, e.entity ?? null, e.entityId ?? null, e.actorId ?? null, e.payload ? JSON.stringify(e.payload) : null]);
}
