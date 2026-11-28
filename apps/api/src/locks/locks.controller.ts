import { Body, ConflictException, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { DbService } from "../db/db.service.ts";
import { R } from "../crm/common.ts";
import { publish } from "../realtime/realtime.ts";

/** Объекты, которые можно «занять» на время правки. Список расширяют новые модули (calc, inspection, plan_task ...). */
const ENTITIES = ["task", "deal", "calc", "inspection", "plan_task", "quote"] as const;
const Body_ = z.object({ entity: z.enum(ENTITIES), entityId: z.string().uuid() });
export const LOCK_TTL_SEC = 120;

/**
 * Мягкие замки: показывают «это сейчас правит Иван» и не дают двум людям одновременно открыть
 * одну форму на редактирование. Окончательная защита от потери данных — версия записи (409).
 * Замок истекает через 2 минуты без продления; экран продлевает его повторным POST раз в минуту.
 */
@Controller("locks")
export class LocksController {
  constructor(@Inject(DbService) private db: DbService) {}

  /** Занять или продлить свой замок. Чужой действующий замок → 409 с именем владельца. */
  @Post()
  acquire(@Req() req: R, @Body() body: unknown) {
    const d = Body_.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const r = await c.query(
        `INSERT INTO edit_locks (tenant_id,entity,entity_id,user_id,expires_at)
         VALUES ($1,$2,$3,$4, now() + make_interval(secs => $5))
         ON CONFLICT (tenant_id,entity,entity_id) DO UPDATE
           SET user_id=EXCLUDED.user_id, expires_at=EXCLUDED.expires_at,
               acquired_at=CASE WHEN edit_locks.user_id=EXCLUDED.user_id THEN edit_locks.acquired_at ELSE now() END
         WHERE edit_locks.user_id=EXCLUDED.user_id OR edit_locks.expires_at < now()
         RETURNING expires_at`,
        [req.user.tenantId, d.entity, d.entityId, req.user.id, LOCK_TTL_SEC]);
      if (!r.rowCount) {
        const h = (await c.query(
          `SELECT u.full_name, l.expires_at FROM edit_locks l JOIN users u ON u.id=l.user_id WHERE l.entity=$1 AND l.entity_id=$2`,
          [d.entity, d.entityId])).rows[0];
        throw new ConflictException({ message: `Сейчас редактирует ${h?.full_name ?? "другой пользователь"}`, holder: h?.full_name, expiresAt: h?.expires_at });
      }
      await publish(c, req.user.tenantId, { channel: "locks", kind: "locked", entity: d.entity, entityId: d.entityId, actorId: req.user.id });
      return { locked: true, expiresAt: r.rows[0].expires_at, ttlSec: LOCK_TTL_SEC };
    });
  }

  /** Освободить свой замок (закрыли форму). Чужой замок не трогаем. */
  @Delete(":entity/:id")
  release(@Req() req: R, @Param("entity") entity: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const r = await c.query("DELETE FROM edit_locks WHERE entity=$1 AND entity_id=$2 AND user_id=$3", [entity, id, req.user.id]);
      if (r.rowCount) await publish(c, req.user.tenantId, { channel: "locks", kind: "unlocked", entity, entityId: id, actorId: req.user.id });
      return { released: !!r.rowCount };
    });
  }

  /** Действующие замки по типу объекта: «кто что сейчас правит». */
  @Get()
  list(@Req() req: R, @Query("entity") entity?: string) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT l.entity,l.entity_id,l.user_id,u.full_name,l.expires_at FROM edit_locks l JOIN users u ON u.id=l.user_id
        WHERE l.expires_at > now() AND ($1::text IS NULL OR l.entity=$1) ORDER BY l.expires_at DESC LIMIT 500`, [entity ?? null])).rows);
  }
}
