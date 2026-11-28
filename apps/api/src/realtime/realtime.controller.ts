import { Controller, Get, Inject, Query, Req } from "@nestjs/common";
import { DbService } from "../db/db.service.ts";
import { R } from "../crm/common.ts";

/**
 * Лента изменений для живого обновления экранов.
 * Клиент раз в 3–5 секунд вызывает GET /events?since=<курсор> и обновляет затронутые данные.
 * Без параметра since возвращает только текущий курсор (первый вызов после открытия экрана).
 * Права на данные не нужны: в ленте нет содержимого, только «что изменилось»; сами данные
 * экран перечитывает обычными запросами, где права проверяются.
 */
@Controller("events")
export class RealtimeController {
  constructor(@Inject(DbService) private db: DbService) {}

  @Get()
  feed(@Req() req: R, @Query("since") since?: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      if (since === undefined || since === "") {
        // Новый слушатель: заодно подчищаем ленту старше суток
        await c.query("DELETE FROM realtime_events WHERE created_at < now() - interval '1 day'");
        const cur = (await c.query("SELECT COALESCE(max(id),0)::text AS cursor FROM realtime_events")).rows[0].cursor;
        return { cursor: cur, events: [] };
      }
      const from = /^\d+$/.test(since) ? since : "0";
      const rows = (await c.query(
        `SELECT id::text,channel,kind,entity,entity_id,actor_id,payload,created_at FROM realtime_events
          WHERE id > $1::bigint ORDER BY id LIMIT 200`, [from])).rows;
      return { cursor: rows.length ? rows[rows.length - 1].id : from, events: rows };
    });
  }
}
