import { Controller, Get, Inject, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit, Param, ParseUUIDPipe, Req } from "@nestjs/common";
import type pg from "pg";
import { DbService } from "../db/db.service.ts";
import { RequirePermission } from "../rbac/rbac.ts";
import { R } from "../crm/common.ts";
import { notifyPermission } from "../production/flow.ts";

export interface Alert { key: string; kind: "purchase" | "sample" | "shipment" | "exfactory"; order: string; orderId: string; text: string; days: number; permission: string }
const TZ_OFFSET_H = 5, ALERT_HOUR = 9, EXFACTORY_WARN_DAYS = 14;

/** Все просрочки и риски по экспортным заказам (общее для экрана «Сводка» и ежедневной рассылки). */
export async function collectAlerts(c: pg.PoolClient): Promise<Alert[]> {
  const out: Alert[] = [];
  const P = (await c.query(
    `SELECT p.id,p.number,p.supplier,o.id AS oid,o.number AS onum,(current_date - p.expected_date)::int AS late
       FROM export_purchases p JOIN export_orders o ON o.id=p.order_id
      WHERE p.status NOT IN ('draft','received','cancelled') AND p.expected_date < current_date AND o.status NOT IN ('cancelled','closed')`)).rows;
  for (const r of P) out.push({ key: `purchase:${r.id}`, kind: "purchase", order: r.onum, orderId: r.oid, days: r.late, permission: "exportpurchases.manage", text: `Закупка ${r.number} (${r.supplier}) просрочена на ${r.late} дн.` });
  const S = (await c.query(
    `SELECT s.id,m.code,s.kind,s.round,o.id AS oid,o.number AS onum,(current_date - s.planned_send)::int AS late
       FROM export_samples s JOIN export_models m ON m.id=s.model_id JOIN export_orders o ON o.id=s.order_id
      WHERE s.status IN ('planned','made') AND s.planned_send < current_date AND o.status NOT IN ('cancelled','closed')`)).rows;
  for (const r of S) out.push({ key: `sample:${r.id}`, kind: "sample", order: r.onum, orderId: r.oid, days: r.late, permission: "exportsamples.manage", text: `Образец ${r.code} ${r.kind === "1fit" ? "1-fit" : "PP"}${r.round > 1 ? ` #${r.round}` : ""}: отправка просрочена на ${r.late} дн.` });
  const H = (await c.query(
    `SELECT s.id,s.number,s.status,o.id AS oid,o.number AS onum,
            CASE WHEN s.status='planned' THEN (current_date - s.loading_date) ELSE (current_date - s.eta) END::int AS late
       FROM export_shipments s JOIN export_orders o ON o.id=s.order_id
      WHERE (s.status='planned' AND s.loading_date < current_date) OR (s.status IN ('loaded','in_transit') AND s.eta < current_date)`)).rows;
  for (const r of H) out.push({ key: `shipment:${r.id}`, kind: "shipment", order: r.onum, orderId: r.oid, days: r.late, permission: "exportshipments.manage",
    text: r.status === "planned" ? `Отгрузка ${r.number}: погрузка просрочена на ${r.late} дн.` : `Отгрузка ${r.number}: прибытие просрочено на ${r.late} дн.` });
  const X = (await c.query(
    `SELECT o.id,o.number,(o.target_exfactory - current_date)::int AS left,
            COALESCE((SELECT sum(qty) FROM export_models WHERE order_id=o.id),0)::int AS qty,
            COALESCE((SELECT sum(qty) FROM export_production_log WHERE order_id=o.id AND stage='pack'),0)::int AS pack
       FROM export_orders o WHERE o.status IN ('confirmed','in_production') AND o.target_exfactory IS NOT NULL AND o.target_exfactory <= current_date + $1::int`, [EXFACTORY_WARN_DAYS])).rows;
  for (const r of X) if (r.pack < r.qty) out.push({ key: `exfactory:${r.id}`, kind: "exfactory", order: r.number, orderId: r.id, days: -r.left, permission: "exportproduction.manage",
    text: r.left >= 0 ? `Заказ ${r.number}: до ex-factory ${r.left} дн., упаковано ${r.pack} из ${r.qty}` : `Заказ ${r.number}: срок ex-factory прошёл ${-r.left} дн. назад, упаковано ${r.pack} из ${r.qty}` });
  return out;
}

@Controller()
export class ExportAlertsController {
  constructor(@Inject(DbService) private db: DbService) {}

  @Get("export-alerts") @RequirePermission("exportorders.view")
  list(@Req() req: R) { return this.db.tx(req.user.tenantId, (c) => collectAlerts(c)); }

  /** Печатная форма КП для клиента (английский): без себестоимости и прибыли. Цена за штуку — договорная из модели, иначе расчётная. */
  @Get("export-quotes/:id/print") @RequirePermission("exportquotes.view")
  print(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const q = (await c.query(
        `SELECT q.number,q.rev,q.status,q.currency,q.lines,q.promised_exfactory::text,q.valid_until::text,q.notes,q.created_at::date::text AS date,
                o.id AS order_id,o.number AS order_number,o.brand,o.collection,o.po_no,o.incoterms,cl.name AS client_name,cl.address AS client_address,
                (SELECT name FROM tenants WHERE id=q.tenant_id) AS seller
           FROM export_quotes q JOIN export_orders o ON o.id=q.order_id JOIN clients cl ON cl.id=o.client_id WHERE q.id=$1`, [id])).rows[0];
      if (!q) throw new NotFoundException();
      const prices = (await c.query("SELECT code,(spec->>'client_price_usd')::float8 AS p,spec->>'kind' AS kind FROM export_models WHERE order_id=$1", [q.order_id])).rows;
      const rows = (q.lines as { code: string; qty: number; pricePerSet: number }[]).map((l) => {
        const m = prices.find((x: any) => x.code === l.code);
        const unit = m?.p && m.p > 0 ? m.p : l.pricePerSet;
        return { code: l.code, kind: m?.kind ?? null, qty: l.qty, unitPrice: Math.round(unit * 10000) / 10000, amount: Math.round(unit * l.qty * 100) / 100 };
      });
      return { ...q, lines: undefined, rows, total: Math.round(rows.reduce((a, r) => a + r.amount, 0) * 100) / 100, qty: rows.reduce((a, r) => a + r.qty, 0) };
    });
  }
}

/** Ежедневная рассылка (09:00 Ташкент): кто отвечает за просроченное, получает сводку в Telegram. Одно и то же — не чаще раза в сутки. */
@Injectable()
export class ExportAlertsService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private last = new Map<string, string>();
  constructor(@Inject(DbService) private db: DbService) {}
  onModuleInit() { this.timer = setInterval(() => void this.tick(), 60_000); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async tick(now = new Date()) {
    if (this.busy) return;
    this.busy = true;
    try {
      const local = new Date(now.getTime() + TZ_OFFSET_H * 3600_000);
      const day = local.toISOString().slice(0, 10);
      if (local.getUTCHours() < ALERT_HOUR) return;
      const tenants = (await this.db.pool.query("SELECT id FROM tenants WHERE status='active'")).rows;
      for (const t of tenants) {
        if (this.last.get(t.id) === day) continue;
        this.last.set(t.id, day);
        await this.run(t.id);
      }
    } catch (e) { console.error("export alerts:", (e as Error).message); }
    finally { this.busy = false; }
  }

  async run(tenantId: string) {
    return this.db.tx(tenantId, async (c) => {
      const all = await collectAlerts(c);
      const byPerm = new Map<string, Alert[]>();
      for (const a of all) {
        const fresh = (await c.query("INSERT INTO export_alert_log (tenant_id,alert_key,day) VALUES ($1,$2,current_date) ON CONFLICT DO NOTHING", [tenantId, a.key])).rowCount;
        if (fresh) byPerm.set(a.permission, [...(byPerm.get(a.permission) ?? []), a]);
      }
      for (const [perm, list] of byPerm) await notifyPermission(c, tenantId, perm, "Экспортные заказы — просрочки:\n" + list.slice(0, 15).map((a) => `${a.order}: ${a.text}`).join("\n"));
      return all.length;
    });
  }
}
