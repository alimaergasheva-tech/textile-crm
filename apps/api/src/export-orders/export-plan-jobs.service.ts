import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { DbService } from "../db/db.service.ts";
import { notify, notifyPermission } from "../production/flow.ts";
import { TZ_OFFSET_H, todayLocal } from "./plan.controller.ts";

const NOTIFY_HOUR = 9;      // утренняя сводка
const ESCALATE_DAYS = 3;    // с какого дня просрочки уведомляется руководство плана

/** Раз в сутки на фабрику: просроченные этапы плана → сотрудникам и руководителю отдела; от 3 дней — ещё и руководителям плана. */
@Injectable()
export class ExportPlanJobsService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private last = new Map<string, string>();
  constructor(@Inject(DbService) private db: DbService) {}
  onModuleInit() { this.timer = setInterval(() => void this.tick(), 60_000); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async tick(now = new Date()) {
    if (this.busy) return;
    this.busy = true;
    try {
      const local = new Date(now.getTime() + TZ_OFFSET_H * 3600_000);
      if (local.getUTCHours() < NOTIFY_HOUR) return;
      const day = todayLocal(now);
      const tenants = (await this.db.pool.query("SELECT id FROM tenants WHERE status='active'")).rows;
      for (const t of tenants) {
        if (this.last.get(t.id) === day) continue;
        this.last.set(t.id, day);
        await this.notifyLate(t.id, day);
      }
    } catch (e) { console.error("export plan jobs:", (e as Error).message); }
    finally { this.busy = false; }
  }

  /** Возвращает число отправленных групп уведомлений. Повторно по этапу в тот же день не шлёт. */
  async notifyLate(tenantId: string, day: string) {
    return this.db.tx(tenantId, async (c) => {
      const late = (await c.query(
        `SELECT t.id,t.name,t.department_code,t.party,t.planned_end::text,o.number,($1::date - t.planned_end)::int AS late
           FROM export_plan_tasks t JOIN export_orders o ON o.id=t.order_id
          WHERE t.status<>'done' AND t.planned_end < $1::date AND o.status NOT IN ('closed','cancelled')
            AND (t.notified_on IS NULL OR t.notified_on < $1::date) ORDER BY o.number,t.seq`, [day])).rows;
      let sent = 0;
      const byDept = new Map<string, typeof late>();
      for (const t of late) { const k = t.department_code ?? ""; byDept.set(k, [...(byDept.get(k) ?? []), t]); }
      for (const [code, items] of byDept) {
        const text = "Просрочены этапы экспортных заказов:\n" +
          items.map((t) => `${t.number}: ${t.name}${t.party ? ` (${t.party})` : ""} — срок ${t.planned_end}, просрочка ${t.late} дн.`).join("\n");
        const users = new Set<string>();
        if (code) {
          const dep = (await c.query("SELECT id,head_user_id FROM departments WHERE code=$1 AND is_active", [code])).rows[0];
          if (dep) {
            if (dep.head_user_id) users.add(dep.head_user_id);
            for (const u of (await c.query("SELECT user_id FROM user_departments WHERE department_id=$1", [dep.id])).rows) users.add(u.user_id);
          }
        }
        if (code && users.size) { for (const u of users) await notify(c, tenantId, u, text); sent++; }
        else { await notifyPermission(c, tenantId, "exportplan.manage", text); sent++; } // у этапа нет отдела или он пуст
      }
      const hot = late.filter((t) => t.late >= ESCALATE_DAYS);
      if (hot.length) {
        await notifyPermission(c, tenantId, "exportplan.manage",
          `Эскалация: просрочка от ${ESCALATE_DAYS} дней\n` + hot.map((t) => `${t.number}: ${t.name} — ${t.late} дн. (${t.department_code ?? "—"})`).join("\n"));
        sent++;
      }
      if (late.length) await c.query("UPDATE export_plan_tasks SET notified_on=$2 WHERE id = ANY($1::uuid[])", [late.map((t) => t.id), day]);
      return sent;
    });
  }
}
