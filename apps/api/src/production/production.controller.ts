import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Put, Req } from "@nestjs/common";
import { z } from "zod";
import type pg from "pg";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { RequirePermission } from "../rbac/rbac.ts";
import { R } from "../crm/common.ts";
import { applyMovement } from "../warehouse/stock.ts";
import { assertTransition, idem, notify, consumeMaterials, issueMaterial, refreshOrderStatus, reserveItem } from "./flow.ts";

const uuid = z.string().uuid();

@Controller()
export class ProductionController {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}
  private log(c: pg.PoolClient, req: R, entity: string, id: string, action: string, after: unknown) {
    return this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity, entityId: id, action, after, ip: req.ip });
  }
  private async po(c: pg.PoolClient, id: string, lock = true) {
    const p = (await c.query(`SELECT * FROM production_orders WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [id])).rows[0];
    if (!p) throw new NotFoundException();
    return p;
  }

  // ---------- бригады и подрядчики ----------
  @Get("brigades") @RequirePermission("production.view")
  brigades(@Req() req: R) { return this.db.tx(req.user.tenantId, async (c) => (await c.query("SELECT id,name FROM brigades WHERE is_active ORDER BY name")).rows); }
  @Post("brigades") @RequirePermission("production.manage")
  addBrigade(@Req() req: R, @Body() body: unknown) {
    const d = z.object({ name: z.string().min(1) }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => ({ id: (await c.query("INSERT INTO brigades (tenant_id,name) VALUES ($1,$2) RETURNING id", [req.user.tenantId, d.name])).rows[0].id }));
  }
  @Get("contractors") @RequirePermission("production.view")
  contractors(@Req() req: R) { return this.db.tx(req.user.tenantId, async (c) => (await c.query("SELECT id,name,phone FROM contractors WHERE is_active ORDER BY name")).rows); }
  @Post("contractors") @RequirePermission("production.manage")
  addContractor(@Req() req: R, @Body() body: unknown) {
    const d = z.object({ name: z.string().min(1), phone: z.string().optional() }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => ({ id: (await c.query("INSERT INTO contractors (tenant_id,name,phone) VALUES ($1,$2,$3) RETURNING id", [req.user.tenantId, d.name, d.phone ?? null])).rows[0].id }));
  }

  @Get("brigades/:id/members") @RequirePermission("production.view")
  members(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      "SELECT u.id,u.full_name,(u.telegram_id IS NOT NULL) AS linked FROM brigade_members bm JOIN users u ON u.id=bm.user_id WHERE bm.brigade_id=$1 ORDER BY u.full_name", [id])).rows);
  }
  @Post("brigades/:id/members") @RequirePermission("production.manage")
  addMember(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = z.object({ userId: uuid }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      await c.query("INSERT INTO brigade_members (tenant_id,brigade_id,user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [req.user.tenantId, id, d.userId]);
      await this.log(c, req, "brigade", id, "add_member", d);
      return { ok: true };
    });
  }
  @Post("brigades/:id/members/:userId/remove") @RequirePermission("production.manage")
  removeMember(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Param("userId", ParseUUIDPipe) userId: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      await c.query("DELETE FROM brigade_members WHERE brigade_id=$1 AND user_id=$2", [id, userId]);
      await this.log(c, req, "brigade", id, "remove_member", { userId });
      return { ok: true };
    });
  }

  // ---------- задания ----------
  @Get("production-orders") @RequirePermission("production.view")
  list(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT po.id,po.number,po.status,po.priority,po.deadline,mo.code AS model_code,mo.name AS model_name,o.number AS order_number,
              (SELECT COALESCE(sum(planned_qty),0)::int FROM production_items i WHERE i.production_order_id=po.id) AS planned,
              (po.deadline IS NOT NULL AND po.deadline < current_date AND po.status NOT IN ('stocked','closed','cancelled')) AS overdue
         FROM production_orders po JOIN models mo ON mo.id=po.model_id JOIN orders o ON o.id=po.order_id
        ORDER BY po.priority DESC, po.deadline NULLS LAST, po.number LIMIT 300`)).rows);
  }

  @Get("production-orders/:id") @RequirePermission("production.view")
  get(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const p = (await c.query(`SELECT po.*,mo.code AS model_code,mo.name AS model_name,o.number AS order_number FROM production_orders po JOIN models mo ON mo.id=po.model_id JOIN orders o ON o.id=po.order_id WHERE po.id=$1`, [id])).rows[0];
      if (!p) throw new NotFoundException();
      const items = (await c.query("SELECT pi.id,pi.variant_id,pi.planned_qty,pi.done_qty,pi.defect_qty,v.sku FROM production_items pi JOIN variants v ON v.id=pi.variant_id WHERE pi.production_order_id=$1 ORDER BY v.sku", [id])).rows;
      const steps = (await c.query(
        `SELECT s.id,s.step,s.name,s.status,s.assignee_type,s.brigade_id,s.contractor_id,b.name AS brigade,ct.name AS contractor,s.close_reason,
                COALESCE((SELECT sum(qty) FROM step_reports r WHERE r.step_id=s.id),0)::int AS reported
           FROM production_steps s LEFT JOIN brigades b ON b.id=s.brigade_id LEFT JOIN contractors ct ON ct.id=s.contractor_id WHERE s.production_order_id=$1 ORDER BY s.step`, [id])).rows;
      const consumption = (await c.query("SELECT mc.material_id,m.code,m.name,m.unit,mc.planned_qty::float8,mc.actual_qty::float8 FROM material_consumption mc JOIN materials m ON m.id=mc.material_id WHERE mc.production_order_id=$1 ORDER BY m.code", [id])).rows;
      const defects = (await c.query("SELECT d.id,d.qty,d.reason_code,d.action,v.sku FROM defects d JOIN variants v ON v.id=d.variant_id WHERE d.production_order_id=$1", [id])).rows;
      return { ...p, items, steps, consumption, defects, plannedTotal: items.reduce((a, i) => a + i.planned_qty, 0) };
    });
  }

  @Post("production-orders/:id/plan") @RequirePermission("production.manage")
  plan(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = z.object({ deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), priority: z.number().int().min(0).max(10).optional() }).parse(body ?? {});
    return this.db.tx(req.user.tenantId, async (c) => {
      const p = await this.po(c, id);
      assertTransition(p.status, "planned");
      await c.query("UPDATE production_orders SET status='planned', deadline=COALESCE($2,deadline), priority=COALESCE($3,priority) WHERE id=$1", [id, d.deadline ?? null, d.priority ?? null]);
      await this.log(c, req, "production_order", id, "plan", d);
      return { ok: true };
    });
  }

  /** Запуск: статус «в работе» и автосписание материалов по BOM (одна транзакция — при нехватке ничего не меняется). */
  @Post("production-orders/:id/start") @RequirePermission("production.manage")
  start(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const p = await this.po(c, id);
      assertTransition(p.status, "in_progress");
      await consumeMaterials(c, req.user.tenantId, req.user.id, id, p.model_id);
      await c.query("UPDATE production_orders SET status='in_progress' WHERE id=$1", [id]);
      await this.log(c, req, "production_order", id, "start", {});
      return { ok: true };
    });
  }

  /** Фактический расход: разница с нормой списывается или возвращается на склад. */
  @Post("production-orders/:id/consumption") @RequirePermission("production.manage")
  consumption(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = z.object({ materialId: uuid, actual: z.number().min(0) }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const p = await this.po(c, id);
      if (p.status !== "in_progress") throw new BadRequestException("Расход правится только в работе");
      const mc = (await c.query("SELECT actual_qty::float8 a FROM material_consumption WHERE production_order_id=$1 AND material_id=$2 FOR UPDATE", [id, d.materialId])).rows[0];
      if (!mc) throw new NotFoundException();
      const diff = Math.round((d.actual - mc.a) * 1000) / 1000;
      if (diff > 0) await issueMaterial(c, req.user.tenantId, req.user.id, d.materialId, diff, id);
      else if (diff < 0) {
        const loc = (await c.query("SELECT l.id FROM locations l JOIN warehouses w ON w.id=l.warehouse_id WHERE w.kind='raw' ORDER BY l.code LIMIT 1")).rows[0].id;
        await applyMovement(c, req.user.tenantId, req.user.id, { type: "return", materialId: d.materialId, locationId: loc, qty: -diff, docType: "production_order", docId: id, comment: "Возврат неизрасходованного" });
      }
      await c.query("UPDATE material_consumption SET actual_qty=$3 WHERE production_order_id=$1 AND material_id=$2", [id, d.materialId, d.actual]);
      await this.log(c, req, "production_order", id, "consumption", d);
      return { diff };
    });
  }

  // ---------- этапы ----------
  @Put("production-steps/:id/assign") @RequirePermission("production.manage")
  assign(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = z.object({ brigadeId: uuid.optional(), contractorId: uuid.optional() }).refine((x) => !!x.brigadeId !== !!x.contractorId, "Укажите бригаду или подрядчика").parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const r = await c.query("UPDATE production_steps SET assignee_type=$2,brigade_id=$3,contractor_id=$4 WHERE id=$1 AND status<>'done'",
        [id, d.brigadeId ? "brigade" : "contractor", d.brigadeId ?? null, d.contractorId ?? null]);
      if (!r.rowCount) throw new NotFoundException();
      if (d.brigadeId) {
        const info = (await c.query("SELECT s.name,po.number FROM production_steps s JOIN production_orders po ON po.id=s.production_order_id WHERE s.id=$1", [id])).rows[0];
        const members = (await c.query("SELECT user_id FROM brigade_members WHERE brigade_id=$1", [d.brigadeId])).rows;
        for (const m of members) await notify(c, req.user.tenantId, m.user_id, `Новое задание: ${info.number}, этап «${info.name}»`);
      }
      await this.log(c, req, "production_step", id, "assign", d);
      return { ok: true };
    });
  }

  /** Отметка о выполнении: нельзя больше плана задания (перевыполнение — только по решению руководителя, этапа это не касается). */
  @Post("production-steps/:id/report") @RequirePermission("production.report")
  report(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @Headers("idempotency-key") key?: string) {
    const d = z.object({ qty: z.number().int().positive(), note: z.string().optional() }).parse(body);
    return this.db.tx(req.user.tenantId, (c) => idem(c, req.user.tenantId, req.user.id, key, async () => {
      const s = (await c.query("SELECT s.*,po.status AS po_status FROM production_steps s JOIN production_orders po ON po.id=s.production_order_id WHERE s.id=$1 FOR UPDATE OF s", [id])).rows[0];
      if (!s) throw new NotFoundException();
      // Бригадир отмечает только этапы своей бригады; руководитель производства — любые
      if (!req.user.perms.has("production.manage")) {
        const ok = s.brigade_id && (await c.query("SELECT 1 FROM brigade_members WHERE brigade_id=$1 AND user_id=$2", [s.brigade_id, req.user.id])).rowCount;
        if (!ok) throw new ForbiddenException("Этап назначен не вашей бригаде");
      }
      if (s.po_status !== "in_progress") throw new BadRequestException("Задание не в работе");
      if (s.status === "done") throw new BadRequestException("Этап закрыт");
      const plan = Number((await c.query("SELECT COALESCE(sum(planned_qty),0) n FROM production_items WHERE production_order_id=$1", [s.production_order_id])).rows[0].n);
      const done = Number((await c.query("SELECT COALESCE(sum(qty),0) n FROM step_reports WHERE step_id=$1", [id])).rows[0].n);
      if (done + d.qty > plan) throw new BadRequestException(`Больше плана: осталось ${plan - done}`);
      await c.query("INSERT INTO step_reports (tenant_id,step_id,qty,note,created_by) VALUES ($1,$2,$3,$4,$5)", [req.user.tenantId, id, d.qty, d.note ?? null, req.user.id]);
      const finished = done + d.qty >= plan;
      await c.query("UPDATE production_steps SET status=$2, started_at=COALESCE(started_at,now()), finished_at=CASE WHEN $2='done' THEN now() END WHERE id=$1", [id, finished ? "done" : "in_progress"]);
      return { reported: done + d.qty, plan, done: finished };
    }));
  }
  @Post("production-steps/:id/close") @RequirePermission("production.manage")
  closeStep(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = z.object({ reason: z.string().min(1, "Укажите причину") }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const r = await c.query("UPDATE production_steps SET status='done', close_reason=$2, finished_at=now() WHERE id=$1 AND status<>'done'", [id, d.reason]);
      if (!r.rowCount) throw new NotFoundException();
      await this.log(c, req, "production_step", id, "close", d);
      return { ok: true };
    });
  }

  // ---------- ОТК и склад ----------
  @Post("production-orders/:id/to-qc") @RequirePermission("production.manage")
  toQc(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const p = await this.po(c, id);
      assertTransition(p.status, "qc");
      const open = (await c.query("SELECT count(*)::int n FROM production_steps WHERE production_order_id=$1 AND status<>'done'", [id])).rows[0].n;
      if (open) throw new BadRequestException(`Не закрыто этапов: ${open}`);
      await c.query("UPDATE production_orders SET status='qc' WHERE id=$1", [id]);
      await this.log(c, req, "production_order", id, "to_qc", {});
      return { ok: true };
    });
  }

  /** Приёмка ОТК: годные идут на склад готовой продукции, брак фиксируется и списывается или уходит на переделку. */
  @Post("production-orders/:id/qc") @RequirePermission("production.qc")
  qc(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @Headers("idempotency-key") key?: string) {
    const d = z.object({ lines: z.array(z.object({
      variantId: uuid, good: z.number().int().min(0), defect: z.number().int().min(0).default(0),
      reasonCode: z.string().optional(), action: z.enum(["writeoff", "rework"]).default("writeoff") })).min(1) }).parse(body);
    return this.db.tx(req.user.tenantId, (c) => idem(c, req.user.tenantId, req.user.id, key, async () => {
      const t = req.user.tenantId;
      const p = await this.po(c, id);
      assertTransition(p.status, "stocked");
      const fin = (await c.query("SELECT l.id FROM locations l JOIN warehouses w ON w.id=l.warehouse_id WHERE w.kind='finished' ORDER BY l.code LIMIT 1")).rows[0]?.id;
      if (!fin) throw new BadRequestException("Нет склада готовой продукции");
      for (const l of d.lines) {
        const it = (await c.query("SELECT id,planned_qty FROM production_items WHERE production_order_id=$1 AND variant_id=$2", [id, l.variantId])).rows[0];
        if (!it) throw new BadRequestException("Нет такой строки в задании");
        if (l.good + l.defect > it.planned_qty) throw new BadRequestException("Принято больше плана");
        if (l.good > 0) await applyMovement(c, t, req.user.id, { type: "receipt", variantId: l.variantId, locationId: fin, qty: l.good, docType: "production_order", docId: id, comment: "Приёмка ОТК" });
        if (l.defect > 0) await c.query("INSERT INTO defects (tenant_id,production_order_id,variant_id,qty,reason_code,action,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)", [t, id, l.variantId, l.defect, l.reasonCode ?? null, l.action, req.user.id]);
        await c.query("UPDATE production_items SET done_qty=$2, defect_qty=$3 WHERE id=$1", [it.id, l.good, l.defect]);
      }
      await c.query("UPDATE production_orders SET status='stocked' WHERE id=$1", [id]);
      // Принятое резервируется под недостающие строки заказа
      const items = (await c.query("SELECT id,variant_id,qty,reserved,shipped FROM order_items WHERE order_id=$1", [p.order_id])).rows;
      for (const it of items) await reserveItem(c, t, req.user.id, it);
      await refreshOrderStatus(c, p.order_id);
      await this.log(c, req, "production_order", id, "qc", d);
      return { ok: true };
    }));
  }

  @Post("production-orders/:id/close") @RequirePermission("production.manage")
  close(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const p = await this.po(c, id);
      assertTransition(p.status, "closed");
      await c.query("UPDATE production_orders SET status='closed' WHERE id=$1", [id]);
      await this.log(c, req, "production_order", id, "close", {});
      return { ok: true };
    });
  }
  @Post("production-orders/:id/cancel") @RequirePermission("production.manage")
  cancel(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const p = await this.po(c, id);
      assertTransition(p.status, "cancelled");
      if (p.status === "in_progress" || p.status === "qc") throw new BadRequestException("Материалы уже списаны — оформите возврат через расход");
      await c.query("UPDATE production_orders SET status='cancelled' WHERE id=$1", [id]);
      await this.log(c, req, "production_order", id, "cancel", {});
      return { ok: true };
    });
  }

  /** Доска: задания по статусам + загрузка бригад (штук в открытых этапах). */
  @Get("production/board") @RequirePermission("production.view")
  board(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const load = (await c.query(
        `SELECT b.id,b.name,count(s.id)::int AS steps FROM brigades b LEFT JOIN production_steps s ON s.brigade_id=b.id AND s.status<>'done'
          LEFT JOIN production_orders po ON po.id=s.production_order_id AND po.status='in_progress' WHERE b.is_active GROUP BY b.id ORDER BY b.name`)).rows;
      return { load };
    });
  }
}
