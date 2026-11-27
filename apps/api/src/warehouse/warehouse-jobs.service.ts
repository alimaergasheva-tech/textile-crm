import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { DbService } from "../db/db.service.ts";
import { notifyPermission } from "../production/flow.ts";
import { reconcile } from "./stock.ts";

const TZ_OFFSET_H = 5; // Ташкент, UTC+5
const RECONCILE_HOUR = 2; // ночная сверка баланса с движениями (4.6)
const LOWSTOCK_HOUR = 9; // сводка по минимальным остаткам (4.7)

/** Фоновые задачи склада, раз в сутки на фабрику: сверка (только проверка, без исправления) и сводка по минимальным остаткам. */
@Injectable()
export class WarehouseJobsService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private last = new Map<string, string>(); // "задача:фабрика" → дата последнего запуска
  constructor(@Inject(DbService) private db: DbService) {}

  onModuleInit() { this.timer = setInterval(() => void this.tick(), 60_000); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async tick(now = new Date()) {
    if (this.busy) return;
    this.busy = true;
    try {
      const local = new Date(now.getTime() + TZ_OFFSET_H * 3600_000);
      const day = local.toISOString().slice(0, 10), hour = local.getUTCHours();
      const tenants = (await this.db.pool.query("SELECT id FROM tenants WHERE status='active'")).rows;
      for (const t of tenants) {
        if (hour >= RECONCILE_HOUR && this.last.get("rec:" + t.id) !== day) { this.last.set("rec:" + t.id, day); await this.reconcileTenant(t.id); }
        if (hour >= LOWSTOCK_HOUR && this.last.get("low:" + t.id) !== day) { this.last.set("low:" + t.id, day); await this.lowStockTenant(t.id); }
      }
    } catch (e) { console.error("warehouse jobs:", (e as Error).message); }
    finally { this.busy = false; }
  }

  async reconcileTenant(tenantId: string) {
    return this.db.tx(tenantId, async (c) => {
      const diffs = await reconcile(c, false);
      if (diffs.length) await notifyPermission(c, tenantId, "warehouse.manage", `Ночная сверка склада: расхождений ${diffs.length}. Откройте «Склад» → «Сверка».`);
      return diffs.length;
    });
  }

  async lowStockTenant(tenantId: string) {
    return this.db.tx(tenantId, async (c) => {
      const low = (await c.query(
        `SELECT m.code,m.name,m.unit,m.min_stock::float8,COALESCE(sum(sb.qty),0)::float8 AS qty
           FROM materials m LEFT JOIN stock_balances sb ON sb.material_id=m.id
          WHERE m.is_active AND m.min_stock > 0 GROUP BY m.id HAVING COALESCE(sum(sb.qty),0) < m.min_stock ORDER BY m.code LIMIT 15`)).rows;
      if (low.length) await notifyPermission(c, tenantId, "warehouse.manage",
        "Ниже минимального остатка:\n" + low.map((m) => `${m.code} ${m.name}: ${m.qty} ${m.unit} (мин. ${m.min_stock})`).join("\n"));
      return low.length;
    });
  }
}
