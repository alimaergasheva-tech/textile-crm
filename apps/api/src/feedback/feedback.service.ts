import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { DbService } from "../db/db.service.ts";
import { notify } from "../production/flow.ts";

/**
 * Фоновая проверка раз в минуту:
 *  – оценки, срок запроса которых наступил, переходят в «запрошена», менеджеру клиента уходит напоминание;
 *  – рекламации без решения дольше срока (48 ч) эскалируются руководителям один раз.
 */
@Injectable()
export class FeedbackService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private busy = false;
  constructor(@Inject(DbService) private db: DbService) {}
  onModuleInit() { this.timer = setInterval(() => void this.tick(), 60_000); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const tenants = (await this.db.pool.query("SELECT id FROM tenants WHERE status='active'")).rows;
      for (const t of tenants) await this.db.tx(t.id, async (c) => {
        const due = (await c.query(
          `UPDATE feedback f SET status='requested' WHERE status='scheduled' AND request_at <= now()
           RETURNING f.id, f.client_id, (SELECT number FROM orders o WHERE o.id=f.order_id) AS order_number`)).rows;
        for (const f of due) {
          const owner = (await c.query("SELECT owner_id FROM clients WHERE id=$1", [f.client_id])).rows[0]?.owner_id;
          if (owner) await notify(c, t.id, owner, `Запросите оценку у клиента по заказу ${f.order_number} (ссылка — в разделе «Обратная связь»)`);
        }
        const late = (await c.query(
          `UPDATE complaints SET escalated_at = now() WHERE status IN ('new','in_progress') AND due_at < now() AND escalated_at IS NULL RETURNING number`)).rows;
        if (late.length) {
          const bosses = (await c.query(
            `SELECT DISTINCT ur.user_id FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE rp.permission_code='feedback.manage'`)).rows;
          for (const k of late) for (const b of bosses) await notify(c, t.id, b.user_id, `Рекламация ${k.number} без ответа более 48 часов`);
        }
      });
    } catch (e) { console.error("feedback tick:", (e as Error).message); }
    finally { this.busy = false; }
  }
}
