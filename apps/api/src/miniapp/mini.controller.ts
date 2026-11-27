import { Controller, Get, Inject, Param, ParseUUIDPipe, Post, Req, NotFoundException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { RequirePermission } from "../rbac/rbac.ts";
import { R } from "../crm/common.ts";
import { config } from "../config.ts";

/** Данные для Mini App: короткие ответы под телефон. Изменения идут через обычные эндпоинты с Idempotency-Key. */
@Controller()
export class MiniController {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}

  @Get("mini/me")
  me(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => ({
      ...(await c.query("SELECT id,full_name,locale FROM users WHERE id=$1", [req.user.id])).rows[0],
      permissions: [...req.user.perms.keys()],   // по правам приложение показывает нужные вкладки
    }));
  }

  /** Этапы в работе: бригадиру — своей бригады, руководителю производства — все. */
  @Get("mini/tasks") @RequirePermission("production.view")
  tasks(@Req() req: R) {
    const all = req.user.perms.has("production.manage");
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT s.id,s.step,s.name,po.number,mo.code AS model_code,mo.name AS model_name,po.deadline,
              (SELECT COALESCE(sum(planned_qty),0)::int FROM production_items i WHERE i.production_order_id=po.id) AS plan,
              COALESCE((SELECT sum(qty) FROM step_reports r WHERE r.step_id=s.id),0)::int AS reported,
              b.name AS brigade
         FROM production_steps s JOIN production_orders po ON po.id=s.production_order_id JOIN models mo ON mo.id=po.model_id
         LEFT JOIN brigades b ON b.id=s.brigade_id
        WHERE po.status='in_progress' AND s.status<>'done'
          AND ($1::boolean OR s.brigade_id IN (SELECT brigade_id FROM brigade_members WHERE user_id=$2))
        ORDER BY po.deadline NULLS LAST, po.number, s.step`, [all, req.user.id])).rows);
  }

  /** Очередь ОТК: задания, ожидающие приёмки. */
  @Get("mini/qc") @RequirePermission("production.qc")
  qc(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const pos = (await c.query(
        `SELECT po.id,po.number,mo.code AS model_code FROM production_orders po JOIN models mo ON mo.id=po.model_id WHERE po.status='qc' ORDER BY po.number`)).rows;
      for (const p of pos) p.items = (await c.query(
        "SELECT pi.variant_id,pi.planned_qty,v.sku FROM production_items pi JOIN variants v ON v.id=pi.variant_id WHERE pi.production_order_id=$1 ORDER BY v.sku", [p.id])).rows;
      return pos;
    });
  }

  /** Заработок за месяц по сделанным отметкам: количество × расценка операции. */
  @Get("mini/earnings") @RequirePermission("production.view")
  earnings(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT ro.currency,COALESCE(sum(r.qty*ro.piece_rate),0)::float8 AS amount,COALESCE(sum(r.qty),0)::int AS pieces
         FROM step_reports r JOIN production_steps s ON s.id=r.step_id JOIN route_operations ro ON ro.id=s.route_operation_id
        WHERE r.created_by=$1 AND r.created_at >= date_trunc('month', now()) GROUP BY ro.currency`, [req.user.id])).rows);
  }

  /** Ссылка-приглашение для привязки Telegram сотрудника. */
  @Post("users/:id/telegram-invite") @RequirePermission("users.edit")
  invite(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      if (!(await c.query("SELECT 1 FROM users WHERE id=$1 AND deleted_at IS NULL", [id])).rowCount) throw new NotFoundException();
      const slug = (await c.query("SELECT slug FROM tenants WHERE id=$1", [req.user.tenantId])).rows[0].slug as string;
      const token = `${slug.replace(/[^A-Za-z0-9-]/g, "")}_${randomBytes(12).toString("base64url").replace(/[^A-Za-z0-9]/g, "x")}`;
      await c.query("INSERT INTO telegram_invites (tenant_id,user_id,token,expires_at) VALUES ($1,$2,$3, now() + interval '7 days')", [req.user.tenantId, id, token]);
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "user", entityId: id, action: "telegram_invite", ip: req.ip });
      const bot = config.botUsername();
      return { token, link: bot ? `https://t.me/${bot}?startapp=${token}` : null, expires: "7d" };
    });
  }
}
