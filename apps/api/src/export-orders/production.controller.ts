import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req } from "@nestjs/common";
import { z } from "zod";
import type pg from "pg";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { RequirePermission } from "../rbac/rbac.ts";
import { R } from "../crm/common.ts";
import { publish } from "../realtime/realtime.ts";
import { orderTotals } from "./production-data.ts";
import { canShip, checkProduction, checkRemoval, pct, shippable, SHIP_STATUSES, type ShipStatus, type Stage, type Totals } from "./production.ts";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const LogIn = z.object({ modelId: z.string().uuid(), stage: z.enum(["cut", "sew", "pack"]), day: date, qty: z.number().int().positive().max(1000000), note: z.string().max(300).nullish() });
const Lines = z.array(z.object({ modelId: z.string().uuid(), qty: z.number().int().positive(), cartons: z.number().int().nonnegative().nullish() })).min(1).max(50);
const ShipIn = z.object({
  carrier: z.string().max(120).nullish(), plate: z.string().max(40).nullish(), cmrNo: z.string().max(60).nullish(), destination: z.string().max(120).optional(),
  loadingDate: date.nullish(), eta: date.nullish(), volumeM3: z.number().nonnegative().max(200).nullish(), weightKg: z.number().nonnegative().max(100000).nullish(),
  cartons: z.number().int().nonnegative().nullish(), note: z.string().max(500).nullish(), lines: Lines });
const ShipPatch = z.object({ version: z.number().int(), carrier: z.string().max(120).nullish(), plate: z.string().max(40).nullish(), cmrNo: z.string().max(60).nullish(),
  loadingDate: date.nullish(), eta: date.nullish(), volumeM3: z.number().nonnegative().max(200).nullish(), weightKg: z.number().nonnegative().max(100000).nullish(),
  cartons: z.number().int().nonnegative().nullish(), note: z.string().max(500).nullish(), lines: Lines.optional() });
const ShipStatusIn = z.object({ version: z.number().int(), status: z.enum(SHIP_STATUSES) });

@Controller()
export class ExportProductionController {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}

  private async syncStatus(c: pg.PoolClient, tenantId: string, orderId: string) {
    const o = (await c.query("SELECT status FROM export_orders WHERE id=$1 FOR UPDATE", [orderId])).rows[0];
    if (!o) return;
    const logged = (await c.query("SELECT 1 FROM export_production_log WHERE order_id=$1 LIMIT 1", [orderId])).rowCount! > 0;
    const moving = (await c.query("SELECT 1 FROM export_shipments WHERE order_id=$1 AND status IN ('in_transit','delivered') LIMIT 1", [orderId])).rowCount! > 0;
    let next: string | null = null;
    if (moving && ["draft", "calculated", "quoted", "confirmed", "in_production"].includes(o.status)) next = "shipped";
    else if (logged && ["draft", "calculated", "quoted", "confirmed"].includes(o.status)) next = "in_production";
    if (next) {
      await c.query("UPDATE export_orders SET status=$2, version=version+1 WHERE id=$1", [orderId, next]);
      await publish(c, tenantId, { channel: "export_orders", kind: "updated", entity: "export_order", entityId: orderId, actorId: null });
    }
  }

  @Get("export-orders/:id/production") @RequirePermission("exportproduction.view")
  production(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const log = (await c.query(
        `SELECT p.id,p.model_id,m.code AS model,p.stage,p.day::text,p.qty,p.note FROM export_production_log p JOIN export_models m ON m.id=p.model_id
          WHERE p.order_id=$1 ORDER BY p.day DESC, p.created_at DESC LIMIT 300`, [id])).rows;
      return { models: await orderTotals(c, id), log };
    });
  }

  @Post("export-orders/:id/production") @RequirePermission("exportproduction.manage")
  addLog(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = LogIn.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const o = (await c.query("SELECT status FROM export_orders WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!o) throw new NotFoundException();
      if (["shipped", "closed", "cancelled"].includes(o.status)) throw new ConflictException("Заказ уже отгружен, закрыт или отменён — выпуск вносить нельзя");
      const mt = (await orderTotals(c, id)).find((m) => m.modelId === d.modelId);
      if (!mt) throw new NotFoundException("Модель не найдена в заказе");
      const err = checkProduction(mt, d.stage as Stage, d.qty, mt.qty);
      if (err) throw new BadRequestException(err);
      const rid = (await c.query(
        "INSERT INTO export_production_log (tenant_id,order_id,model_id,stage,day,qty,note,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
        [req.user.tenantId, id, d.modelId, d.stage, d.day, d.qty, d.note ?? null, req.user.id])).rows[0].id;
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "export_production", entityId: rid, action: "create", after: d, ip: req.ip });
      await this.syncStatus(c, req.user.tenantId, id);
      await publish(c, req.user.tenantId, { channel: "export_orders", kind: "updated", entity: "export_order", entityId: id, actorId: req.user.id });
      return { id: rid };
    });
  }

  @Delete("export-production/:id") @RequirePermission("exportproduction.manage")
  removeLog(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const r = (await c.query("SELECT order_id,model_id,stage,qty FROM export_production_log WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!r) throw new NotFoundException();
      const mt = (await orderTotals(c, r.order_id)).find((m) => m.modelId === r.model_id)!;
      const err = checkRemoval(mt, r.stage, r.qty, mt.shipped);
      if (err) throw new ConflictException(err);
      await c.query("DELETE FROM export_production_log WHERE id=$1", [id]);
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "export_production", entityId: id, action: "delete", before: r, ip: req.ip });
      await publish(c, req.user.tenantId, { channel: "export_orders", kind: "updated", entity: "export_order", entityId: r.order_id, actorId: req.user.id });
      return { ok: true };
    });
  }

  // ---- отгрузки ----
  private async loadShip(c: pg.PoolClient, id: string) {
    const s = (await c.query(
      `SELECT id,order_id,number,status,carrier,plate,cmr_no,destination,loading_date::text,eta::text,delivered_on::text,volume_m3::float8 AS volume_m3,weight_kg::float8 AS weight_kg,cartons,note,version FROM export_shipments WHERE id=$1`, [id])).rows[0];
    if (!s) throw new NotFoundException();
    s.lines = (await c.query("SELECT l.model_id,m.code AS model,l.qty,l.cartons FROM export_shipment_lines l JOIN export_models m ON m.id=l.model_id WHERE l.shipment_id=$1 ORDER BY m.sort,m.code", [id])).rows;
    return s;
  }

  /** Проверка строк: модель из заказа, по ней пройден финальный AQL, объём не больше упакованного и ещё не отгруженного. */
  private async checkLines(c: pg.PoolClient, orderId: string, lines: z.infer<typeof Lines>, excludeShipment?: string) {
    const tot = await orderTotals(c, orderId);
    let back: Record<string, number> = {};
    if (excludeShipment) {
      (await c.query("SELECT model_id,qty FROM export_shipment_lines WHERE shipment_id=$1", [excludeShipment])).rows.forEach((r: any) => (back[r.model_id] = Number(r.qty)));
    }
    const seen = new Set<string>();
    for (const l of lines) {
      if (seen.has(l.modelId)) throw new BadRequestException("Модель указана в отгрузке дважды");
      seen.add(l.modelId);
      const m = tot.find((x) => x.modelId === l.modelId);
      if (!m) throw new NotFoundException("Модель не найдена в заказе");
      if (m.aql !== "pass") throw new BadRequestException(`${m.code}: отгрузка возможна только после итогового отчёта AQL со статусом «принято»`);
      const free = m.shippable + (back[l.modelId] ?? 0);
      if (l.qty > free) throw new BadRequestException(`${m.code}: к отгрузке доступно ${free} шт (упаковано минус уже отгружено)`);
    }
  }

  @Get("export-orders/:id/shipments") @RequirePermission("exportshipments.view")
  shipments(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const ids = (await c.query("SELECT id FROM export_shipments WHERE order_id=$1 ORDER BY created_at", [id])).rows;
      return Promise.all(ids.map((r: { id: string }) => this.loadShip(c, r.id)));
    });
  }

  @Post("export-orders/:id/shipments") @RequirePermission("exportshipments.manage")
  createShip(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = ShipIn.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const o = (await c.query("SELECT status FROM export_orders WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!o) throw new NotFoundException();
      if (["closed", "cancelled"].includes(o.status)) throw new ConflictException("Заказ закрыт или отменён — отгрузку создать нельзя");
      await this.checkLines(c, id, d.lines);
      const n = Number((await c.query("SELECT count(*)::int AS n FROM export_shipments WHERE order_id=$1", [id])).rows[0].n) + 1;
      const num = `${(await c.query("SELECT number FROM export_orders WHERE id=$1", [id])).rows[0].number}-S${n}`;
      const sid = (await c.query(
        `INSERT INTO export_shipments (tenant_id,order_id,number,carrier,plate,cmr_no,destination,loading_date,eta,volume_m3,weight_kg,cartons,note,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [req.user.tenantId, id, num, d.carrier ?? null, d.plate ?? null, d.cmrNo ?? null, d.destination ?? "USA", d.loadingDate ?? null, d.eta ?? null, d.volumeM3 ?? null, d.weightKg ?? null, d.cartons ?? null, d.note ?? null, req.user.id])).rows[0].id;
      for (const l of d.lines) await c.query("INSERT INTO export_shipment_lines (tenant_id,shipment_id,model_id,qty,cartons) VALUES ($1,$2,$3,$4,$5)", [req.user.tenantId, sid, l.modelId, l.qty, l.cartons ?? null]);
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "export_shipment", entityId: sid, action: "create", after: { number: num, lines: d.lines }, ip: req.ip });
      await publish(c, req.user.tenantId, { channel: "export_orders", kind: "updated", entity: "export_order", entityId: id, actorId: req.user.id });
      return this.loadShip(c, sid);
    });
  }

  @Patch("export-shipments/:id") @RequirePermission("exportshipments.manage")
  updateShip(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = ShipPatch.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const s = (await c.query("SELECT * FROM export_shipments WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!s) throw new NotFoundException();
      if (s.status !== "planned") throw new BadRequestException("Менять можно только запланированную отгрузку");
      if (s.version !== d.version) throw new ConflictException("Отгрузка изменена другим пользователем — обновите страницу");
      if (d.lines) {
        await this.checkLines(c, s.order_id, d.lines, id);
        await c.query("DELETE FROM export_shipment_lines WHERE shipment_id=$1", [id]);
        for (const l of d.lines) await c.query("INSERT INTO export_shipment_lines (tenant_id,shipment_id,model_id,qty,cartons) VALUES ($1,$2,$3,$4,$5)", [req.user.tenantId, id, l.modelId, l.qty, l.cartons ?? null]);
      }
      const has = (k: keyof typeof d) => d[k] !== undefined;
      await c.query(
        `UPDATE export_shipments SET carrier=$2,plate=$3,cmr_no=$4,loading_date=$5,eta=$6,volume_m3=$7,weight_kg=$8,cartons=$9,note=$10,version=version+1 WHERE id=$1`,
        [id, has("carrier") ? d.carrier ?? null : s.carrier, has("plate") ? d.plate ?? null : s.plate, has("cmrNo") ? d.cmrNo ?? null : s.cmr_no,
         has("loadingDate") ? d.loadingDate ?? null : s.loading_date, has("eta") ? d.eta ?? null : s.eta, has("volumeM3") ? d.volumeM3 ?? null : s.volume_m3,
         has("weightKg") ? d.weightKg ?? null : s.weight_kg, has("cartons") ? d.cartons ?? null : s.cartons, has("note") ? d.note ?? null : s.note]);
      await publish(c, req.user.tenantId, { channel: "export_orders", kind: "updated", entity: "export_order", entityId: s.order_id, actorId: req.user.id });
      return this.loadShip(c, id);
    });
  }

  @Post("export-shipments/:id/status") @RequirePermission("exportshipments.manage")
  setStatus(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = ShipStatusIn.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const s = (await c.query("SELECT * FROM export_shipments WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!s) throw new NotFoundException();
      if (s.version !== d.version) throw new ConflictException("Отгрузка изменена другим пользователем — обновите страницу");
      if (!canShip(s.status as ShipStatus, d.status)) throw new BadRequestException(`Переход ${s.status} → ${d.status} недопустим`);
      if (d.status === "loaded" && (!s.carrier || !s.plate)) throw new BadRequestException("Перед погрузкой укажите перевозчика и номер машины");
      await c.query("UPDATE export_shipments SET status=$2, delivered_on=CASE WHEN $2='delivered' THEN current_date ELSE delivered_on END, version=version+1 WHERE id=$1", [id, d.status]);
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "export_shipment", entityId: id, action: "status", before: { status: s.status }, after: { status: d.status }, ip: req.ip });
      await this.syncStatus(c, req.user.tenantId, s.order_id);
      await publish(c, req.user.tenantId, { channel: "export_orders", kind: "updated", entity: "export_order", entityId: s.order_id, actorId: req.user.id });
      return this.loadShip(c, id);
    });
  }

  @Delete("export-shipments/:id") @RequirePermission("exportshipments.manage")
  removeShip(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const s = (await c.query("SELECT order_id,status FROM export_shipments WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!s) throw new NotFoundException();
      if (!["planned", "cancelled"].includes(s.status)) throw new BadRequestException("Удалить можно только запланированную или отменённую отгрузку");
      await c.query("DELETE FROM export_shipments WHERE id=$1", [id]);
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "export_shipment", entityId: id, action: "delete", ip: req.ip });
      await publish(c, req.user.tenantId, { channel: "export_orders", kind: "updated", entity: "export_order", entityId: s.order_id, actorId: req.user.id });
      return { ok: true };
    });
  }

  // ---- сводка по всем экспортным заказам ----
  @Get("export-dashboard") @RequirePermission("exportorders.view")
  dashboard(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const orders = (await c.query(
        `SELECT o.id,o.number,o.brand,o.collection,o.status,o.target_exfactory::text AS exfactory,
                COALESCE((SELECT sum(qty) FROM export_models WHERE order_id=o.id),0)::int AS qty
           FROM export_orders o WHERE o.status NOT IN ('cancelled') ORDER BY o.target_exfactory NULLS LAST, o.created_at DESC`)).rows;
      const out = [];
      for (const o of orders) {
        const m = await orderTotals(c, o.id);
        const sum = (k: "cut" | "sew" | "pack" | "shipped") => m.reduce((a, x) => a + x[k], 0);
        const po = (await c.query("SELECT count(*)::int AS n, count(*) FILTER (WHERE status NOT IN ('received','cancelled') AND expected_date < current_date)::int AS late FROM export_purchases WHERE order_id=$1", [o.id])).rows[0];
        const days = o.exfactory ? Math.ceil((new Date(o.exfactory).getTime() - Date.now()) / 86400000) : null;
        out.push({ ...o, cut: sum("cut"), sew: sum("sew"), pack: sum("pack"), shipped: sum("shipped"), pctPack: pct(sum("pack"), o.qty), pctShipped: pct(sum("shipped"), o.qty),
          aqlPass: m.filter((x) => x.aql === "pass").length, aqlFail: m.filter((x) => x.aql === "fail").length, models: m.length, daysLeft: days, lateOrders: po.late });
      }
      return out;
    });
  }
}
