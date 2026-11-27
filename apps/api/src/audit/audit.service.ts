import { Injectable } from "@nestjs/common";
import type pg from "pg";

export interface AuditEntry {
  tenantId: string; userId?: string | null; entity: string; entityId?: string | null;
  action: string; before?: unknown; after?: unknown; ip?: string | null;
}

@Injectable()
export class AuditService {
  /** Пишет в журнал в той же транзакции, что и само изменение. */
  async log(c: pg.PoolClient, e: AuditEntry): Promise<void> {
    await c.query(
      `INSERT INTO audit_log (tenant_id,user_id,entity,entity_id,action,before,after,ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [e.tenantId, e.userId ?? null, e.entity, e.entityId ?? null, e.action,
       e.before ? JSON.stringify(e.before) : null, e.after ? JSON.stringify(e.after) : null, e.ip ?? null],
    );
  }
}
