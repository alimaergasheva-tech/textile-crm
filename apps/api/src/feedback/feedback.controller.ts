import { BadRequestException, Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req } from "@nestjs/common";
import { z } from "zod";
import type pg from "pg";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { Public, RequirePermission } from "../rbac/rbac.ts";
import { R } from "../crm/common.ts";
import { applyMovement } from "../warehouse/stock.ts";
import { nextNumber, notifyPermission, reserveAndPlan } from "../production/flow.ts";

const uuid = z.string().uuid();
const RESPONSE_HOURS = 48;

@Controller()
export class FeedbackController {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}
  private log(c: pg.PoolClient, req: R, entity: string, id: string | null, action: string, after: unknown) {
    return this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity, entityId: id, action, after, ip: req.ip });
  }

  // ---------- оценки ----------
  @Get("feedback") @RequirePermission("feedback.view")
  list(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT f.id,f.status,f.rating,f.comment,f.request_at,f.answered_at,f.token,o.number AS order_number,cl.name AS client
         FROM feedback f JOIN orders o ON o.id=f.order_id JOIN clients cl ON cl.id=f.client_id ORDER BY f.request_at DESC LIMIT 200`)).rows);
  }

  /** Сотрудник вносит оценку клиента вручную (например, по телефону). */
  @Post("feedback") @RequirePermission("feedback.create")
  record(@Req() req: R, @Body() body: unknown) {
    const d = z.object({ feedbackId: uuid, rating: z.number().int().min(1).max(5), comment: z.string().optional() }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const r = await c.query("UPDATE feedback SET rating=$2, comment=$3, status='answered', answered_at=now() WHERE id=$1 AND status<>'answered'", [d.feedbackId, d.rating, d.comment ?? null]);
      if (!r.rowCount) throw new BadRequestException("Оценка уже получена");
      await this.log(c, req, "feedback", d.feedbackId, "record", d);
      return { ok: true };
    });
  }

  // ---------- публичная страница оценки (без входа, по секретной ссылке) ----------
  @Public() @Get("public/feedback/:token")
  async publicGet(@Param("token") token: string) {
    return this.byToken(token, async (c) => {
      const f = (await c.query("SELECT f.status,o.number AS order_number,tn.name AS factory FROM feedback f JOIN orders o ON o.id=f.order_id JOIN tenants tn ON tn.id=f.tenant_id WHERE f.token=$1", [token])).rows[0];
      if (!f) throw new NotFoundException();
      return { orderNumber: f.order_number, factory: f.factory, answered: f.status === "answered" };
    });
  }
  @Public() @Post("public/feedback/:token") @HttpCode(200)
  async publicPost(@Param("token") token: string, @Body() body: unknown) {
    const d = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().max(2000).optional() }).parse(body);
    return this.byToken(token, async (c) => {
      const r = await c.query("UPDATE feedback SET rating=$2, comment=$3, status='answered', answered_at=now() WHERE token=$1 AND status<>'answered'", [token, d.rating, d.comment ?? null]);
      if (!r.rowCount) throw new BadRequestException("Оценка уже получена или ссылка недействительна");
      return { ok: true };
    });
  }
  private byToken<T>(token: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const tid = token.split(".")[0];
    if (!/^[0-9a-f-]{36}$/.test(tid)) throw new NotFoundException();
    return this.db.tx(tid, fn);
  }

  // ---------- рекламации ----------
  @Get("complaints") @RequirePermission("feedback.view")
  complaints(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT k.id,k.number,k.status,k.reason_code,k.description,k.qty,k.lot_info,k.due_at,k.escalated_at,k.resolution_type,k.resolution_note,k.created_at,
              o.number AS order_number,cl.name AS client,u.full_name AS assignee,v.sku,
              (k.status IN ('new','in_progress') AND k.due_at < now()) AS overdue
         FROM complaints k JOIN orders o ON o.id=k.order_id JOIN clients cl ON cl.id=k.client_id
         LEFT JOIN users u ON u.id=k.assignee_id LEFT JOIN variants v ON v.id=k.variant_id ORDER BY k.created_at DESC LIMIT 200`)).rows);
  }

  @Post("complaints") @RequirePermission("feedback.create")
  createComplaint(@Req() req: R, @Body() body: unknown) {
    const d = z.object({ orderId: uuid, variantId: uuid.optional(), lotInfo: z.string().optional(), qty: z.number().int().positive().optional(),
      reasonCode: z.string().min(1), description: z.string().optional(), assigneeId: uuid.optional() }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const t = req.user.tenantId;
      const o = (await c.query("SELECT client_id FROM orders WHERE id=$1", [d.orderId])).rows[0];
      if (!o) throw new NotFoundException("Заказ не найден");
      const n = Number((await c.query("SELECT count(*)::int n FROM complaints")).rows[0].n) + 1;
      const number = `C-${new Date().getFullYear()}-${String(n).padStart(4, "0")}`;
      const id = (await c.query(
        `INSERT INTO complaints (tenant_id,number,order_id,client_id,variant_id,lot_info,qty,reason_code,description,assignee_id,due_at,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + ($11 || ' hours')::interval, $12) RETURNING id`,
        [t, number, d.orderId, o.client_id, d.variantId ?? null, d.lotInfo ?? null, d.qty ?? null, d.reasonCode, d.description ?? null,
         d.assigneeId ?? req.user.id, String(RESPONSE_HOURS), req.user.id])).rows[0].id;
      await this.log(c, req, "complaint", id, "create", d);
      await notifyPermission(c, t, "feedback.manage", `Новая рекламация ${number}`);
      return { id, number };
    });
  }

  /** Статусы идут вперёд: новая → в работе → решена → закрыта. «Решена» ставится только через решение. */
  @Patch("complaints/:id/status") @RequirePermission("feedback.manage")
  setStatus(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = z.object({ status: z.enum(["in_progress", "closed"]), assigneeId: uuid.optional() }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const k = (await c.query("SELECT status FROM complaints WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!k) throw new NotFoundException();
      const ok = (d.status === "in_progress" && k.status === "new") || (d.status === "closed" && k.status === "resolved");
      if (!ok) throw new BadRequestException(`Переход ${k.status} → ${d.status} недопустим`);
      await c.query("UPDATE complaints SET status=$2, assignee_id=COALESCE($3,assignee_id) WHERE id=$1", [id, d.status, d.assigneeId ?? null]);
      await this.log(c, req, "complaint", id, "status", d);
      return { ok: true };
    });
  }

  /** Решение: замена (новая строка заказа и задание/резерв), возврат (товар на склад, зачёт в долг) или скидка (зачёт в долг). */
  @Post("complaints/:id/resolve") @RequirePermission("feedback.manage")
  resolve(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = z.object({ type: z.enum(["replace", "refund", "discount"]), amount: z.number().int().positive().optional(), note: z.string().optional() }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const t = req.user.tenantId;
      const k = (await c.query("SELECT * FROM complaints WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!k) throw new NotFoundException();
      if (!["new", "in_progress"].includes(k.status)) throw new BadRequestException("Рекламация уже решена");
      let amount = d.amount ?? null;
      if (d.type !== "discount") {
        if (!k.variant_id || !k.qty) throw new BadRequestException("Для замены и возврата укажите модель и количество в рекламации");
      }
      if (d.type === "replace") {
        // новая потребность по заказу: резерв из остатков или производственное задание на нехватку
        const upd = await c.query("UPDATE order_items SET qty = qty + $3 WHERE order_id=$1 AND variant_id=$2", [k.order_id, k.variant_id, k.qty]);
        if (!upd.rowCount) await c.query("INSERT INTO order_items (tenant_id,order_id,variant_id,qty,unit_price) VALUES ($1,$2,$3,$4,0)", [t, k.order_id, k.variant_id, k.qty]);
        await c.query("UPDATE orders SET status='confirmed' WHERE id=$1 AND status='shipped'", [k.order_id]);
        await reserveAndPlan(c, t, req.user.id, k.order_id);
      } else if (d.type === "refund") {
        const loc = (await c.query("SELECT l.id FROM locations l JOIN warehouses w ON w.id=l.warehouse_id WHERE w.kind='finished' ORDER BY l.code LIMIT 1")).rows[0]?.id;
        if (!loc) throw new BadRequestException("Нет склада готовой продукции");
        await applyMovement(c, t, req.user.id, { type: "return", variantId: k.variant_id, locationId: loc, qty: k.qty, docType: "complaint", docId: id, comment: "Возврат по рекламации" });
        const price = Number((await c.query("SELECT unit_price::float8 p FROM order_items WHERE order_id=$1 AND variant_id=$2", [k.order_id, k.variant_id])).rows[0]?.p ?? 0);
        amount = amount ?? Math.round(price * k.qty);
        await c.query("UPDATE orders SET discount = discount + $2 WHERE id=$1", [k.order_id, amount]);
      } else {
        if (!amount) throw new BadRequestException("Укажите сумму скидки");
        await c.query("UPDATE orders SET discount = discount + $2 WHERE id=$1", [k.order_id, amount]);
      }
      await c.query("UPDATE complaints SET status='resolved', resolved_at=now(), resolution_type=$2, resolution_amount=$3, resolution_note=$4 WHERE id=$1", [id, d.type, amount, d.note ?? null]);
      await this.log(c, req, "complaint", id, "resolve", d);
      return { ok: true };
    });
  }

  // ---------- обращения сотрудников ----------
  /** Любой вошедший сотрудник. При anonymous автор нигде не сохраняется (в журнал аудита — тоже). */
  @Post("suggestions")
  suggest(@Req() req: R, @Body() body: unknown) {
    const d = z.object({ text: z.string().min(3).max(4000), kind: z.enum(["problem", "suggestion"]).default("suggestion"), anonymous: z.boolean().default(false) }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const id = (await c.query("INSERT INTO suggestions (tenant_id,user_id,kind,text) VALUES ($1,$2,$3,$4) RETURNING id", [req.user.tenantId, d.anonymous ? null : req.user.id, d.kind, d.text])).rows[0].id;
      if (!d.anonymous) await this.log(c, req, "suggestion", id, "create", { kind: d.kind });
      return { id };
    });
  }
  @Get("suggestions") @RequirePermission("feedback.manage")
  suggestions(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      "SELECT s.id,s.kind,s.text,s.status,s.created_at,u.full_name AS author FROM suggestions s LEFT JOIN users u ON u.id=s.user_id ORDER BY s.created_at DESC LIMIT 200")).rows);
  }
  @Patch("suggestions/:id") @RequirePermission("feedback.manage")
  suggestionStatus(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = z.object({ status: z.enum(["seen", "done"]) }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => { await c.query("UPDATE suggestions SET status=$2 WHERE id=$1", [id, d.status]); return { ok: true }; });
  }

  // ---------- статистика ----------
  @Get("feedback/stats") @RequirePermission("feedback.view")
  stats(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const f = (await c.query("SELECT COALESCE(avg(rating),0)::float8 AS avg, count(rating)::int AS rated, count(*) FILTER (WHERE status='requested')::int AS waiting FROM feedback")).rows[0];
      const shipped = Number((await c.query("SELECT count(*)::int n FROM shipments WHERE status='shipped'")).rows[0].n);
      const k = (await c.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE status IN ('new','in_progress'))::int AS open,
                count(*) FILTER (WHERE status IN ('new','in_progress') AND due_at < now())::int AS overdue,
                COALESCE(avg(extract(epoch FROM (resolved_at - created_at))/3600) FILTER (WHERE resolved_at IS NOT NULL),0)::float8 AS avg_hours FROM complaints`)).rows[0];
      const reasons = (await c.query("SELECT reason_code,count(*)::int n FROM complaints GROUP BY reason_code ORDER BY n DESC LIMIT 5")).rows;
      return { avgRating: Math.round(f.avg * 100) / 100, rated: f.rated, waiting: f.waiting, complaints: k.total, openComplaints: k.open,
        overdueComplaints: k.overdue, avgResolveHours: Math.round(k.avg_hours * 10) / 10, complaintShare: shipped ? Math.round((k.total / shipped) * 1000) / 10 : 0, topReasons: reasons };
    });
  }
}
