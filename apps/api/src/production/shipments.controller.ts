import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req, Res, StreamableFile } from "@nestjs/common";
import { z } from "zod";
import type pg from "pg";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { RequirePermission } from "../rbac/rbac.ts";
import { R } from "../crm/common.ts";
import { applyMovement } from "../warehouse/stock.ts";
import { nextNumber, notify } from "./flow.ts";
import { randomBytes } from "node:crypto";
import { buildShipmentPdf } from "./pdf.ts";

const uuid = z.string().uuid();

async function toCur(c: pg.PoolClient, amount: number, from: string, to: string): Promise<number> {
  if (from === to) return amount;
  const rate = Number((await c.query("SELECT uzs_per_usd FROM exchange_rates ORDER BY valid_from DESC LIMIT 1")).rows[0]?.uzs_per_usd);
  if (!rate) throw new BadRequestException("Не задан курс валют");
  return from === "USD" ? Math.round(amount * rate) : Math.round(amount / rate);
}

@Controller("shipments")
export class ShipmentsController {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}
  private log(c: pg.PoolClient, req: R, id: string, action: string, after: unknown) {
    return this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "shipment", entityId: id, action, after, ip: req.ip });
  }

  @Get() @RequirePermission("shipments.view")
  list(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT s.id,s.number,s.status,s.shipped_at,s.created_at,o.number AS order_number,cl.name AS client,
              (SELECT COALESCE(sum(qty),0)::int FROM shipment_items i WHERE i.shipment_id=s.id) AS qty
         FROM shipments s JOIN orders o ON o.id=s.order_id JOIN clients cl ON cl.id=o.client_id ORDER BY s.created_at DESC LIMIT 200`)).rows);
  }

  /** Накладная и упаковочный лист одним PDF. ?lang=ru|uz|en|tr */
  @Get(":id/pdf") @RequirePermission("shipments.view")
  async pdf(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Query("lang") lang: string | undefined, @Res({ passthrough: true }) res: any) {
    const data = await this.get(req, id);
    const l = (["ru", "uz", "en", "tr"].includes(lang ?? "") ? lang : "ru") as "ru" | "uz" | "en" | "tr";
    const buf = await buildShipmentPdf(data as any, l);
    res.set({ "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${(data as any).number}.pdf"` });
    return new StreamableFile(buf);
  }

  /** Данные для накладной и упаковочного листа. */
  @Get(":id") @RequirePermission("shipments.view")
  get(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const s = (await c.query(
        `SELECT s.id,s.number,s.status,s.note,s.shipped_at,s.created_at,o.id AS order_id,o.number AS order_number,o.currency,
                cl.name AS client,(SELECT ct.phone FROM contacts ct WHERE ct.client_id=cl.id ORDER BY ct.is_primary DESC LIMIT 1) AS client_phone,tn.name AS factory
           FROM shipments s JOIN orders o ON o.id=s.order_id JOIN clients cl ON cl.id=o.client_id JOIN tenants tn ON tn.id=s.tenant_id WHERE s.id=$1`, [id])).rows[0];
      if (!s) throw new NotFoundException();
      const items = (await c.query(
        `SELECT si.id,si.qty,oi.unit_price::float8,v.sku,v.barcode,mo.code AS model_code,mo.name AS model_name,sz.label AS size,col.name_ru AS color
           FROM shipment_items si JOIN order_items oi ON oi.id=si.order_item_id JOIN variants v ON v.id=si.variant_id JOIN models mo ON mo.id=v.model_id
           JOIN sizes sz ON sz.id=v.size_id JOIN colors col ON col.id=v.color_id WHERE si.shipment_id=$1 ORDER BY v.sku`, [id])).rows;
      return { ...s, items, totalQty: items.reduce((a: number, i: any) => a + i.qty, 0), totalAmount: items.reduce((a: number, i: any) => a + i.qty * i.unit_price, 0) };
    });
  }

  /** Черновик отгрузки: можно отгрузить только то, что уже зарезервировано (лежит на складе). */
  @Post() @RequirePermission("shipments.create")
  create(@Req() req: R, @Body() body: unknown) {
    const d = z.object({ orderId: uuid, note: z.string().optional(), items: z.array(z.object({ orderItemId: uuid, qty: z.number().int().positive() })).min(1) }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const t = req.user.tenantId;
      const o = (await c.query("SELECT status FROM orders WHERE id=$1 FOR UPDATE", [d.orderId])).rows[0];
      if (!o) throw new NotFoundException();
      if (!["confirmed", "in_production", "ready"].includes(o.status)) throw new BadRequestException("Заказ не готов к отгрузке");
      const number = await nextNumber(c, "shipments", "SH");
      const id = (await c.query("INSERT INTO shipments (tenant_id,number,order_id,note,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id", [t, number, d.orderId, d.note ?? null, req.user.id])).rows[0].id;
      for (const i of d.items) {
        const oi = (await c.query("SELECT variant_id,reserved FROM order_items WHERE id=$1 AND order_id=$2", [i.orderItemId, d.orderId])).rows[0];
        if (!oi) throw new BadRequestException("Строка не из этого заказа");
        if (i.qty > oi.reserved) throw new BadRequestException(`Можно отгрузить не больше зарезервированного (${oi.reserved})`);
        await c.query("INSERT INTO shipment_items (tenant_id,shipment_id,order_item_id,variant_id,qty) VALUES ($1,$2,$3,$4,$5)", [t, id, i.orderItemId, oi.variant_id, i.qty]);
      }
      await this.log(c, req, id, "create", d);
      return { id, number };
    });
  }

  /** Проведение: расход со склада готовой продукции, снятие резерва, учёт отгруженного. Лимит клиента проверяется заново. */
  @Post(":id/ship") @RequirePermission("shipments.create")
  ship(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const t = req.user.tenantId;
      const s = (await c.query("SELECT * FROM shipments WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!s) throw new NotFoundException();
      if (s.status !== "draft") throw new BadRequestException("Отгрузка уже проведена или отменена");
      const o = (await c.query("SELECT o.id,o.client_id,o.currency,o.total::float8,o.paid::float8,o.status,cl.credit_limit::float8,cl.credit_currency FROM orders o JOIN clients cl ON cl.id=o.client_id WHERE o.id=$1 FOR UPDATE OF o", [s.order_id])).rows[0];
      if (!["confirmed", "in_production", "ready"].includes(o.status)) throw new BadRequestException("Заказ не готов к отгрузке");

      if (o.credit_limit > 0) {
        const rows = (await c.query("SELECT currency,sum(total - paid - discount)::float8 AS s FROM orders WHERE client_id=$1 AND status IN ('confirmed','in_production','ready','shipped') GROUP BY currency", [o.client_id])).rows;
        let debt = 0;
        for (const r of rows) debt += await toCur(c, r.s, r.currency, o.credit_currency);
        if (debt > o.credit_limit && !req.user.perms.has("orders.approve")) throw new ForbiddenException("Превышен кредитный лимит клиента — нужно разрешение руководителя");
      }

      const items = (await c.query("SELECT si.order_item_id,si.variant_id,si.qty FROM shipment_items si WHERE si.shipment_id=$1", [id])).rows;
      for (const i of items) {
        const oi = (await c.query("SELECT reserved FROM order_items WHERE id=$1 FOR UPDATE", [i.order_item_id])).rows[0];
        if (i.qty > oi.reserved) throw new BadRequestException("Резерв по строке изменился — обновите отгрузку");
        let left = i.qty;
        const bals = (await c.query(
          `SELECT sb.location_id,sb.qty::float8 q FROM stock_balances sb JOIN locations l ON l.id=sb.location_id JOIN warehouses w ON w.id=l.warehouse_id
            WHERE sb.variant_id=$1 AND w.kind='finished' AND sb.qty>0 ORDER BY sb.qty DESC`, [i.variant_id])).rows;
        for (const b of bals) {
          if (left <= 0) break;
          const take = Math.min(left, Math.floor(b.q));
          if (take <= 0) continue;
          await applyMovement(c, t, req.user.id, { type: "issue", variantId: i.variant_id, locationId: b.location_id, qty: -take, docType: "shipment", docId: id, comment: "Отгрузка" });
          left -= take;
        }
        if (left > 0) throw new BadRequestException("На складе готовой продукции не хватает товара");
        // снять резерв по строке: закрыть целиком или уменьшить
        let rest = i.qty;
        const rs = (await c.query("SELECT id,qty FROM reservations WHERE status='active' AND ref_type='order_item' AND ref_id=$1 ORDER BY created_at FOR UPDATE", [i.order_item_id])).rows;
        for (const r of rs) {
          if (rest <= 0) break;
          if (Number(r.qty) <= rest) { await c.query("UPDATE reservations SET status='fulfilled', closed_at=now() WHERE id=$1", [r.id]); rest -= Number(r.qty); }
          else { await c.query("UPDATE reservations SET qty = qty - $2 WHERE id=$1", [r.id, rest]); rest = 0; }
        }
        await c.query("UPDATE order_items SET reserved = reserved - $2, shipped = shipped + $2 WHERE id=$1", [i.order_item_id, i.qty]);
      }
      await c.query("UPDATE shipments SET status='shipped', shipped_at=now() WHERE id=$1", [id]);
      // Запрос оценки у клиента через день после отгрузки (FB-1); срок настраивается переменной FEEDBACK_DELAY_HOURS
      const delayH = Number(process.env.FEEDBACK_DELAY_HOURS ?? 24);
      await c.query(
        "INSERT INTO feedback (tenant_id,order_id,shipment_id,client_id,token,request_at) VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' hours')::interval) ON CONFLICT DO NOTHING",
        [t, s.order_id, id, o.client_id, `${t}.${randomBytes(18).toString("base64url")}`, String(delayH)]);
      const open = (await c.query("SELECT count(*)::int n FROM order_items WHERE order_id=$1 AND shipped < qty", [s.order_id])).rows[0].n;
      if (!open) await c.query("UPDATE orders SET status='shipped' WHERE id=$1", [s.order_id]);
      const mgr = (await c.query("SELECT cl.owner_id,o.number FROM orders o JOIN clients cl ON cl.id=o.client_id WHERE o.id=$1", [s.order_id])).rows[0];
      if (mgr?.owner_id) await notify(c, t, mgr.owner_id, `Отгрузка ${s.number} по заказу ${mgr.number} проведена`);
      await this.log(c, req, id, "ship", { orderClosed: !open });
      return { ok: true, orderClosed: !open };
    });
  }

  @Post(":id/cancel") @RequirePermission("shipments.create")
  cancel(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const r = await c.query("UPDATE shipments SET status='cancelled' WHERE id=$1 AND status='draft'", [id]);
      if (!r.rowCount) throw new BadRequestException("Отменить можно только черновик");
      await this.log(c, req, id, "cancel", {});
      return { ok: true };
    });
  }
}
