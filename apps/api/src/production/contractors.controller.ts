import { BadRequestException, Body, Controller, Get, Headers, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Req } from "@nestjs/common";
import { z } from "zod";
import type pg from "pg";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { RequirePermission } from "../rbac/rbac.ts";
import { R } from "../crm/common.ts";
import { idem } from "./flow.ts";

/**
 * Работа с подрядчиками (PRD-6). Для этапа, назначенного подрядчику: передали крой → подрядчик привёз изделия →
 * ОТК принимает годные и брак. Годные засчитываются в выполнение этапа (отметка), остаток у подрядчика = передано − принято − брак.
 */
@Controller()
export class ContractorsController {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}
  private log(c: pg.PoolClient, req: R, entity: string, id: string, action: string, after: unknown) {
    return this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity, entityId: id, action, after, ip: req.ip });
  }

  /** Этапы у подрядчиков: план, передано, ждёт приёмки, принято, брак, остаток у подрядчика. */
  @Get("contractor-holdings") @RequirePermission("production.view")
  holdings(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT s.id AS step_id, s.name AS step, po.number, mo.code AS model_code, ct.id AS contractor_id, ct.name AS contractor,
              (SELECT COALESCE(sum(planned_qty),0)::int FROM production_items i WHERE i.production_order_id=po.id) AS plan,
              COALESCE((SELECT sum(qty) FROM contractor_transfers t WHERE t.step_id=s.id),0)::int AS transferred,
              COALESCE((SELECT sum(qty) FROM contractor_receipts r WHERE r.step_id=s.id AND r.status='pending'),0)::int AS pending,
              COALESCE((SELECT sum(good_qty) FROM contractor_receipts r WHERE r.step_id=s.id AND r.status='accepted'),0)::int AS accepted,
              COALESCE((SELECT sum(defect_qty) FROM contractor_receipts r WHERE r.step_id=s.id AND r.status='accepted'),0)::int AS defect
         FROM production_steps s JOIN production_orders po ON po.id=s.production_order_id JOIN models mo ON mo.id=po.model_id
         JOIN contractors ct ON ct.id=s.contractor_id
        WHERE s.assignee_type='contractor' AND s.status<>'done' AND po.status='in_progress'
        ORDER BY ct.name, po.number, s.step`)).rows.map((r) => ({ ...r, at_contractor: r.transferred - r.accepted - r.defect })));
  }

  @Get("contractor-receipts") @RequirePermission("production.view")
  receipts(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT r.id,r.qty,r.created_at,ct.name AS contractor,s.name AS step,po.number
         FROM contractor_receipts r JOIN contractors ct ON ct.id=r.contractor_id JOIN production_steps s ON s.id=r.step_id
         JOIN production_orders po ON po.id=s.production_order_id WHERE r.status='pending' ORDER BY r.created_at`)).rows);
  }

  private async step(c: pg.PoolClient, id: string) {
    const s = (await c.query(
      `SELECT s.*, po.status AS po_status,
              (SELECT COALESCE(sum(planned_qty),0)::int FROM production_items i WHERE i.production_order_id=s.production_order_id) AS plan
         FROM production_steps s JOIN production_orders po ON po.id=s.production_order_id WHERE s.id=$1 FOR UPDATE OF s`, [id])).rows[0];
    if (!s) throw new NotFoundException();
    if (s.assignee_type !== "contractor" || !s.contractor_id) throw new BadRequestException("Этап не назначен подрядчику");
    if (s.po_status !== "in_progress") throw new BadRequestException("Задание не в работе");
    if (s.status === "done") throw new BadRequestException("Этап закрыт");
    return s;
  }
  private sum = async (c: pg.PoolClient, sql: string, id: string) => Number((await c.query(sql, [id])).rows[0].n);

  /** Передача кроя подрядчику: всего не больше плана задания. */
  @Post("production-steps/:id/transfer") @RequirePermission("production.manage")
  transfer(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @Headers("idempotency-key") key?: string) {
    const d = z.object({ qty: z.number().int().positive(), note: z.string().optional() }).parse(body);
    return this.db.tx(req.user.tenantId, (c) => idem(c, req.user.tenantId, req.user.id, key, async () => {
      const s = await this.step(c, id);
      const sent = await this.sum(c, "SELECT COALESCE(sum(qty),0) n FROM contractor_transfers WHERE step_id=$1", id);
      if (sent + d.qty > s.plan) throw new BadRequestException(`Больше плана: можно передать ещё ${s.plan - sent}`);
      const tid = (await c.query("INSERT INTO contractor_transfers (tenant_id,step_id,contractor_id,qty,note,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
        [req.user.tenantId, id, s.contractor_id, d.qty, d.note ?? null, req.user.id])).rows[0].id;
      await c.query("UPDATE production_steps SET started_at=COALESCE(started_at,now()) WHERE id=$1", [id]);
      await this.log(c, req, "contractor_transfer", tid, "create", { stepId: id, ...d });
      return { id: tid, transferred: sent + d.qty };
    }));
  }

  /** Подрядчик привёз изделия: запись ждёт приёмки ОТК. Нельзя привезти больше, чем у него на руках. */
  @Post("production-steps/:id/receipts") @RequirePermission("production.manage")
  receive(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @Headers("idempotency-key") key?: string) {
    const d = z.object({ qty: z.number().int().positive(), note: z.string().optional() }).parse(body);
    return this.db.tx(req.user.tenantId, (c) => idem(c, req.user.tenantId, req.user.id, key, async () => {
      const s = await this.step(c, id);
      const sent = await this.sum(c, "SELECT COALESCE(sum(qty),0) n FROM contractor_transfers WHERE step_id=$1", id);
      const back = await this.sum(c, "SELECT COALESCE(sum(CASE WHEN status='pending' THEN qty ELSE good_qty + defect_qty END),0) n FROM contractor_receipts WHERE step_id=$1", id);
      if (back + d.qty > sent) throw new BadRequestException(`У подрядчика на руках ${sent - back}`);
      const rid = (await c.query("INSERT INTO contractor_receipts (tenant_id,step_id,contractor_id,qty,note,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
        [req.user.tenantId, id, s.contractor_id, d.qty, d.note ?? null, req.user.id])).rows[0].id;
      await this.log(c, req, "contractor_receipt", rid, "create", { stepId: id, ...d });
      return { id: rid };
    }));
  }

  /** Приёмка ОТК: годные + брак = привезённому. Годные засчитываются в выполнение этапа, при достижении плана этап закрывается. */
  @Post("contractor-receipts/:id/accept") @RequirePermission("production.qc")
  accept(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @Headers("idempotency-key") key?: string) {
    const d = z.object({ good: z.number().int().min(0), defect: z.number().int().min(0).default(0), reasonCode: z.string().optional() }).parse(body);
    return this.db.tx(req.user.tenantId, (c) => idem(c, req.user.tenantId, req.user.id, key, async () => {
      const r = (await c.query("SELECT * FROM contractor_receipts WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!r) throw new NotFoundException();
      if (r.status !== "pending") throw new BadRequestException("Уже принято");
      if (d.good + d.defect !== r.qty) throw new BadRequestException(`Годные и брак вместе должны дать ${r.qty}`);
      const s = await this.step(c, r.step_id);
      await c.query("UPDATE contractor_receipts SET status='accepted', good_qty=$2, defect_qty=$3, reason_code=$4, accepted_by=$5, accepted_at=now() WHERE id=$1",
        [id, d.good, d.defect, d.reasonCode ?? null, req.user.id]);
      let done = false;
      if (d.good > 0) {
        await c.query("INSERT INTO step_reports (tenant_id,step_id,qty,note,created_by) VALUES ($1,$2,$3,'Приёмка от подрядчика',$4)", [req.user.tenantId, r.step_id, d.good, req.user.id]);
        const got = await this.sum(c, "SELECT COALESCE(sum(qty),0) n FROM step_reports WHERE step_id=$1", r.step_id);
        done = got >= s.plan;
        await c.query("UPDATE production_steps SET status=$2, started_at=COALESCE(started_at,now()), finished_at=CASE WHEN $2='done' THEN now() END WHERE id=$1", [r.step_id, done ? "done" : "in_progress"]);
      }
      await this.log(c, req, "contractor_receipt", id, "accept", d);
      return { ok: true, stepDone: done };
    }));
  }
}
