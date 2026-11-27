import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { DbService } from "../db/db.service.ts";
import { config } from "../config.ts";

/** Очередь уведомлений: повтор с растущей паузой, после 5 неудач — статус failed. Без токена бота ничего не отправляется. */
@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private busy = false;
  constructor(@Inject(DbService) private db: DbService) {}

  onModuleInit() {
    if (!config.botToken()) return;
    this.timer = setInterval(() => void this.tick(), 10_000);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const tenants = (await this.db.pool.query("SELECT id FROM tenants WHERE status='active'")).rows;
      for (const t of tenants) await this.db.tx(t.id, async (c) => {
        const rows = (await c.query(
          `SELECT n.id,n.attempts,n.text,u.telegram_id FROM notifications n JOIN users u ON u.id=n.user_id
            WHERE n.status='pending' AND n.next_attempt_at <= now() ORDER BY n.id LIMIT 20 FOR UPDATE OF n SKIP LOCKED`)).rows;
        for (const n of rows) {
          try {
            if (!n.telegram_id) throw new Error("Telegram не привязан");
            const r = await fetch(`https://api.telegram.org/bot${config.botToken()}/sendMessage`, {
              method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: n.telegram_id, text: n.text }) });
            if (!r.ok) throw new Error(`Telegram ${r.status}`);
            await c.query("UPDATE notifications SET status='sent', sent_at=now(), attempts=attempts+1 WHERE id=$1", [n.id]);
          } catch (e) {
            const attempts = n.attempts + 1;
            await c.query(
              "UPDATE notifications SET attempts=$2, last_error=$3, status=CASE WHEN $2>=5 THEN 'failed' ELSE 'pending' END, next_attempt_at=now() + ($2 * interval '1 minute') WHERE id=$1",
              [n.id, attempts, (e as Error).message]);
          }
        }
      });
    } catch (e) { console.error("notifications:", (e as Error).message); }
    finally { this.busy = false; }
  }
}
