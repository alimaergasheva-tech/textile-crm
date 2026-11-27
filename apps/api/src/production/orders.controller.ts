import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";
import type pg from "pg";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { RequirePermission } from "../rbac/rbac.ts";
import { R } from "../crm/common.ts";
import { availableForVariant } from "../warehouse/stock.ts";
import { nextNumber, notifyPermission, reserveAndPlan } from "./flow.ts";

const uuid = z.string().uuid();

/** Перевод суммы между валютами по последнему курсу фабрики. */
async function convert(c: pg.PoolClient, amount: number, from: string, to: string): Promise<number> {
  if (from === to) return amount;
  const rate = Number((await c.query("SELECT uzs_per_usd FROM exchange_rates ORDER BY valid_from DESC LIMIT 1")).rows[0]?.uzs_per_usd);
  if (!rate) throw new BadRequestException("Не задан курс валют");
  return from === "USD" ? Math.round(amount * rate) : Math.round(amount / rate);
}

@Controller("orders")
export class OrdersController {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}
  private log(c: pg.PoolClient, req: R, id: string, action: string, after: unknown) {
    return this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "order", entityId: id, action, after, ip: req.ip });
  }

  @Get() @RequirePermission("orders.view")
  list(@Req() req: R, @Query("status") status?: string) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT o.id,o.number,o.status,o.due_date,o.currency,o.total::float8,o.paid::float8,o.created_at,cl.name AS client,
              (SELECT COALESCE(sum(qty),0)::int FROM order_items i WHERE i.order_id=o.id) AS qty
         FROM orders o JOIN clients cl ON cl.id=o.client_id WHERE ($1::text IS NULL OR o.status=$1) ORDER BY o.created_at DESC LIMIT 200`, [status ?? null])).rows);
  }

  @Get("won-deals") @RequirePermission("orders.create")
  wonDeals(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT d.id,d.title,cl.name AS client FROM deals d JOIN pipeline_stages s ON s.id=d.stage_id JOIN clients cl ON cl.id=d.client_id
        WHERE s.kind='won' AND d.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.deal_id=d.id) ORDER BY d.closed_at DESC NULLS LAST`)).rows);
  }

  @Get(":id") @RequirePermission("orders.view")
  get(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const o = (await c.query("SELECT o.*,o.total::float8 AS total_n,cl.name AS client,cl.credit_limit::float8,cl.credit_currency FROM orders o JOIN clients cl ON cl.id=o.client_id WHERE o.id=$1", [id])).rows[0];
      if (!o) throw new NotFoundException();
      const items = (await c.query(
        `SELECT oi.id,oi.variant_id,oi.qty,oi.reserved,oi.shipped,oi.unit_price::float8,v.sku,mo.code AS model_code,mo.name AS model_name
           FROM order_items oi JOIN variants v ON v.id=oi.variant_id JOIN models mo ON mo.id=v.model_id WHERE oi.order_id=$1 ORDER BY v.sku`, [id])).rows;
      const prod = (await c.query("SELECT po.id,po.number,po.status,po.deadline,mo.code AS model_code FROM production_orders po JOIN models mo ON mo.id=po.model_id WHERE po.order_id=$1 ORDER BY po.number", [id])).rows;
      const ships = (await c.query("SELECT id,number,status,shipped_at FROM shipments WHERE order_id=$1 ORDER BY created_at", [id])).rows;
      return { ...o, total: o.total_n, paid: Number(o.paid), items, production: prod, shipments: ships };
    });
  }

  @Get(":id/availability") @RequirePermission("orders.view")
  availability(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const items = (await c.query("SELECT id,variant_id,qty,reserved FROM order_items WHERE order_id=$1", [id])).rows;
      const out = [];
      for (const i of items) out.push({ itemId: i.id, need: i.qty - i.reserved, ...(await availableForVariant(c, i.variant_id)) });
      return out;
    });
  }

  /** Заказ из выигранной сделки одним действием (CRM-6). Размерный ряд приходит уже раскрытым в строки. */
  @Post("from-deal/:dealId") @RequirePermission("orders.create")
  fromDeal(@Req() req: R, @Param("dealId", ParseUUIDPipe) dealId: string, @Body() body: unknown) {
    const d = z.object({
      items: z.array(z.object({ variantId: uuid, qty: z.number().int().positive() })).min(1),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), note: z.string().optional(),
    }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const t = req.user.tenantId;
      const deal = (await c.query("SELECT d.id,d.client_id,s.kind FROM deals d JOIN pipeline_stages s ON s.id=d.stage_id WHERE d.id=$1 AND d.deleted_at IS NULL", [dealId])).rows[0];
      if (!deal) throw new NotFoundException();
      if (deal.kind !== "won") throw new BadRequestException("Заказ создаётся только из выигранной сделки");
      if ((await c.query("SELECT 1 FROM orders WHERE deal_id=$1", [dealId])).rowCount) throw new BadRequestException("Заказ по этой сделке уже создан");
      const client = (await c.query("SELECT price_type,credit_limit::float8,credit_currency FROM clients WHERE id=$1", [deal.client_id])).rows[0];

      const merged = new Map<string, number>();
      for (const i of d.items) merged.set(i.variantId, (merged.get(i.variantId) ?? 0) + i.qty);
      let currency: string | null = null, total = 0;
      const lines: { variantId: string; qty: number; price: number }[] = [];
      for (const [variantId, qty] of merged) {
        const p = (await c.query(
          `SELECT p.amount::float8 AS amount, pl.currency FROM variants v JOIN prices p ON p.model_id=v.model_id JOIN price_lists pl ON pl.id=p.price_list_id
            WHERE v.id=$1 AND pl.price_type=$2 AND pl.is_active ORDER BY pl.name LIMIT 1`, [variantId, client.price_type])).rows[0];
        if (!p) throw new BadRequestException("Нет цены для одной из моделей в прайс-листе клиента");
        if (currency && currency !== p.currency) throw new BadRequestException("Цены в разных валютах — оформите заказы отдельно");
        currency = p.currency; total += p.amount * qty; lines.push({ variantId, qty, price: p.amount });
      }
      const number = await nextNumber(c, "orders", "O");
      const id = (await c.query(
        `INSERT INTO orders (tenant_id,number,client_id,deal_id,currency,total,due_date,note,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [t, number, deal.client_id, dealId, currency, total, d.dueDate ?? null, d.note ?? null, req.user.id])).rows[0].id;
      for (const l of lines) await c.query("INSERT INTO order_items (tenant_id,order_id,variant_id,qty,unit_price) VALUES ($1,$2,$3,$4,$5)", [t, id, l.variantId, l.qty, l.price]);

      // Кредитный лимит: долг (активные заказы) + сумма заказа ≤ лимит
      let status = "draft";
      if (client.credit_limit > 0) {
        const rows = (await c.query("SELECT currency,sum(total - paid - discount)::float8 AS s FROM orders WHERE client_id=$1 AND id<>$2 AND status IN ('confirmed','in_production','ready','shipped') GROUP BY currency", [deal.client_id, id])).rows;
        let debt = 0;
        for (const r of rows) debt += await convert(c, r.s, r.currency, client.credit_currency);
        const mine = await convert(c, total, currency!, client.credit_currency);
        if (debt + mine > client.credit_limit) status = "pending_approval";
      }
      await c.query("UPDATE orders SET status=$2 WHERE id=$1", [id, status]);
      if (status === "pending_approval") await notifyPermission(c, t, "orders.approve", `Заказ ${number} превышает кредитный лимит клиента и ждёт подтверждения`);
      let productions = 0;
      if (status === "draft") productions = await reserveAndPlan(c, t, req.user.id, id);
      await this.log(c, req, id, "create", { dealId, number, status, total, productions });
      return { id, number, status, productions };
    });
  }

  /** Подтверждение заказа, ожидающего решения по лимиту, — только с правом orders.approve. */
  @Post(":id/confirm") @RequirePermission("orders.create")
  confirm(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const o = (await c.query("SELECT status FROM orders WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!o) throw new NotFoundException();
      if (o.status === "pending_approval" && !req.user.perms.has("orders.approve")) throw new ForbiddenException("Нужно подтверждение руководителя");
      if (!["pending_approval", "draft"].includes(o.status)) throw new BadRequestException("Заказ уже подтверждён или закрыт");
      if (o.status === "pending_approval") await c.query("UPDATE orders SET approved_by=$2 WHERE id=$1", [id, req.user.id]);
      const productions = await reserveAndPlan(c, req.user.tenantId, req.user.id, id);
      await this.log(c, req, id, "confirm", { productions });
      return { productions };
    });
  }

  /** Оплачено по заказу (счета и оплаты — после MVP); нужно для проверки кредитного лимита. */
  @Post(":id/paid") @RequirePermission("orders.approve")
  paid(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = z.object({ paid: z.number().int().min(0) }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const o = (await c.query("SELECT total::float8 t FROM orders WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!o) throw new NotFoundException();
      if (d.paid > o.t) throw new BadRequestException("Оплата больше суммы заказа");
      await c.query("UPDATE orders SET paid=$2 WHERE id=$1", [id, d.paid]);
      await this.log(c, req, id, "set_paid", d);
      return { ok: true };
    });
  }

  @Post(":id/cancel") @RequirePermission("orders.create")
  cancel(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const o = (await c.query("SELECT status FROM orders WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!o) throw new NotFoundException();
      if (["shipped", "cancelled"].includes(o.status)) throw new BadRequestException("Заказ нельзя отменить");
      const busy = (await c.query("SELECT count(*)::int n FROM production_orders WHERE order_id=$1 AND status NOT IN ('draft','planned','cancelled')", [id])).rows[0].n;
      if (busy) throw new BadRequestException("Производство уже идёт — сначала остановите задания");
      await c.query("UPDATE production_orders SET status='cancelled' WHERE order_id=$1 AND status IN ('draft','planned')", [id]);
      await c.query("UPDATE reservations SET status='released', closed_at=now() WHERE status='active' AND ref_type='order_item' AND ref_id IN (SELECT id FROM order_items WHERE order_id=$1)", [id]);
      await c.query("UPDATE order_items SET reserved=0 WHERE order_id=$1", [id]);
      await c.query("UPDATE orders SET status='cancelled' WHERE id=$1", [id]);
      await this.log(c, req, id, "cancel", {});
      return { ok: true };
    });
  }
}
