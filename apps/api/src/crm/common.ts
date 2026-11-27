import type pg from "pg";
import { AuthUser, isOwnOnly } from "../rbac/rbac.ts";

export type R = { user: AuthUser; ip?: string };

/** Условие «только свои», если право выдано в таком виде. col — колонка владельца. */
export function ownerClause(u: AuthUser, perm: string, col: string, paramIdx: number): { sql: string; params: string[] } {
  return isOwnOnly(u, perm) ? { sql: ` AND ${col} = $${paramIdx}`, params: [u.id] } : { sql: "", params: [] };
}

/** Запись в историю общения; обновляет «последнюю активность» сделки. */
export async function addInteraction(c: pg.PoolClient, tenantId: string, entity: string, entityId: string,
  type: string, text: string | null, userId: string | null) {
  await c.query(
    "INSERT INTO interactions (tenant_id,entity,entity_id,type,text,created_by) VALUES ($1,$2,$3,$4,$5,$6)",
    [tenantId, entity, entityId, type, text, userId]);
  if (entity === "deal") await c.query("UPDATE deals SET last_activity_at = now() WHERE id = $1", [entityId]);
}
