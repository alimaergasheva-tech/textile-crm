import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { RequirePermission } from "../rbac/rbac.ts";
import { R } from "../crm/common.ts";
import { planLoad, TRUCKS } from "./logistics.ts";
import { orderTotals } from "./production-data.ts";
import { publish } from "../realtime/realtime.ts";

const Specs = z.object({ specs: z.array(z.object({
  modelId: z.string().uuid(), pcsPerCarton: z.number().int().positive().max(1000),
  cartonL: z.number().positive().max(300), cartonW: z.number().positive().max(300), cartonH: z.number().positive().max(300), cartonKg: z.number().positive().max(100),
})).min(1).max(50) });

const Carrier = z.object({ name: z.string().min(2).max(120), contact: z.string().max(120).nullish(), phone: z.string().max(60).nullish(), email: z.string().max(120).nullish(),
  ratePerTruck: z.number().nonnegative().max(1e9).nullish(), currency: z.enum(["USD", "UZS", "EUR"]).optional(), transitDays: z.number().int().positive().max(120).nullish(),
  route: z.string().max(200).nullish(), note: z.string().max(500).nullish(), isActive: z.boolean().optional() });
const FromPlan = z.object({ truck: z.string(), fill: z.number().min(0.5).max(1).optional(), carrierId: z.string().uuid().nullish() });

@Controller()
export class ExportLogisticsController {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}

  /** Упаковка моделей и расчёт машин. basis=order — весь заказ; basis=remaining — заказано минус отгружено. */
  @Get("export-orders/:id/logistics") @RequirePermission("exportlogistics.view")
  get(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Query("truck") truckCode = "tilt", @Query("basis") basis = "order", @Query("fill") fillQ = "0.9", @Query("price") priceQ = "") {
    const truck = TRUCKS.find((t) => t.code === truckCode);
    if (!truck) throw new BadRequestException("Неизвестный тип машины");
    const fill = Number(fillQ);
    if (!(fill >= 0.5 && fill <= 1)) throw new BadRequestException("Коэффициент укладки от 0.5 до 1");
    return this.db.tx(req.user.tenantId, async (c) => {
      if (!(await c.query("SELECT 1 FROM export_orders WHERE id=$1", [id])).rowCount) throw new NotFoundException();
      const rows = (await c.query(
        `SELECT m.id,m.code,m.qty,
                COALESCE((SELECT sum(l.qty) FROM export_shipment_lines l JOIN export_shipments s ON s.id=l.shipment_id WHERE l.model_id=m.id AND s.status<>'cancelled'),0)::int AS shipped,
                p.pcs_per_carton,p.carton_l_cm::float8 AS l,p.carton_w_cm::float8 AS w,p.carton_h_cm::float8 AS h,p.carton_kg::float8 AS kg
           FROM export_models m LEFT JOIN export_pack_specs p ON p.model_id=m.id WHERE m.order_id=$1 ORDER BY m.sort,m.code`, [id])).rows;
      const specs = rows.map((r: any) => ({ modelId: r.id, code: r.code, qty: Number(r.qty), shipped: r.shipped, pcsPerCarton: r.pcs_per_carton, cartonL: r.l, cartonW: r.w, cartonH: r.h, cartonKg: r.kg }));
      const ready = specs.filter((s) => s.pcsPerCarton);
      const missing = specs.filter((s) => !s.pcsPerCarton).map((s) => s.code);
      let plan = null, error: string | null = null;
      try {
        plan = planLoad(ready.map((s) => ({ id: s.modelId, code: s.code, qty: basis === "remaining" ? Math.max(0, s.qty - s.shipped) : s.qty, pcsPerCarton: s.pcsPerCarton!, cartonL: s.cartonL!, cartonW: s.cartonW!, cartonH: s.cartonH!, cartonKg: s.cartonKg! })), truck, fill);
      } catch (e) { error = e instanceof Error ? e.message : String(e); }
      const price = priceQ === "" ? null : Number(priceQ);
      return { specs, missing, trucks: TRUCKS, plan, error, cost: plan && price && price > 0 ? Math.round(price * plan.trucks.length * 100) / 100 : null };
    });
  }

  @Put("export-orders/:id/pack-specs") @RequirePermission("exportlogistics.manage")
  save(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = Specs.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const ids = (await c.query("SELECT id FROM export_models WHERE order_id=$1", [id])).rows.map((r: { id: string }) => r.id);
      for (const s of d.specs) {
        if (!ids.includes(s.modelId)) throw new NotFoundException("Модель не найдена в заказе");
        await c.query(
          `INSERT INTO export_pack_specs (tenant_id,model_id,pcs_per_carton,carton_l_cm,carton_w_cm,carton_h_cm,carton_kg,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (model_id) DO UPDATE SET pcs_per_carton=$3,carton_l_cm=$4,carton_w_cm=$5,carton_h_cm=$6,carton_kg=$7,updated_by=$8,updated_at=now()`,
          [req.user.tenantId, s.modelId, s.pcsPerCarton, s.cartonL, s.cartonW, s.cartonH, s.cartonKg, req.user.id]);
      }
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "export_pack_specs", entityId: id, action: "save", after: d, ip: req.ip });
      return { ok: true };
    });
  }

  // ---- справочник перевозчиков ----
  @Get("export-carriers") @RequirePermission("exportlogistics.view")
  carriers(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT id,name,contact,phone,email,rate_per_truck::float8 AS rate_per_truck,currency,transit_days,route,note,is_active FROM export_carriers ORDER BY is_active DESC, name`)).rows);
  }

  @Post("export-carriers") @RequirePermission("exportlogistics.manage")
  addCarrier(@Req() req: R, @Body() body: unknown) {
    const d = Carrier.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      if ((await c.query("SELECT 1 FROM export_carriers WHERE lower(name)=lower($1)", [d.name])).rowCount) throw new ConflictException("Перевозчик с таким названием уже есть");
      const id = (await c.query(
        "INSERT INTO export_carriers (tenant_id,name,contact,phone,email,rate_per_truck,currency,transit_days,route,note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id",
        [req.user.tenantId, d.name, d.contact ?? null, d.phone ?? null, d.email ?? null, d.ratePerTruck ?? null, d.currency ?? "USD", d.transitDays ?? null, d.route ?? null, d.note ?? null])).rows[0].id;
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "export_carrier", entityId: id, action: "create", after: d, ip: req.ip });
      return { id };
    });
  }

  @Put("export-carriers/:id") @RequirePermission("exportlogistics.manage")
  updCarrier(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = Carrier.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const r = await c.query(
        `UPDATE export_carriers SET name=$2,contact=$3,phone=$4,email=$5,rate_per_truck=$6,currency=$7,transit_days=$8,route=$9,note=$10,is_active=COALESCE($11,is_active) WHERE id=$1`,
        [id, d.name, d.contact ?? null, d.phone ?? null, d.email ?? null, d.ratePerTruck ?? null, d.currency ?? "USD", d.transitDays ?? null, d.route ?? null, d.note ?? null, d.isActive ?? null]);
      if (!r.rowCount) throw new NotFoundException();
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "export_carrier", entityId: id, action: "update", after: d, ip: req.ip });
      return { ok: true };
    });
  }

  @Delete("export-carriers/:id") @RequirePermission("exportlogistics.manage")
  delCarrier(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      if (!(await c.query("DELETE FROM export_carriers WHERE id=$1", [id])).rowCount) throw new NotFoundException();
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "export_carrier", entityId: id, action: "delete", ip: req.ip });
      return { ok: true };
    });
  }

  /**
   * Создать запланированные отгрузки по плану машин. В план входит только то, что можно отгрузить сейчас:
   * упаковано минус уже отгружено, и только по моделям с итоговым AQL «принято».
   */
  @Post("export-orders/:id/logistics/create-shipments") @RequirePermission("exportshipments.manage")
  fromPlan(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = FromPlan.parse(body);
    const truck = TRUCKS.find((t) => t.code === d.truck);
    if (!truck) throw new BadRequestException("Неизвестный тип машины");
    return this.db.tx(req.user.tenantId, async (c) => {
      const o = (await c.query("SELECT number,status FROM export_orders WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!o) throw new NotFoundException();
      if (["closed", "cancelled"].includes(o.status)) throw new ConflictException("Заказ закрыт или отменён — отгрузку создать нельзя");
      const carrier = d.carrierId ? (await c.query("SELECT name,transit_days FROM export_carriers WHERE id=$1", [d.carrierId])).rows[0] : null;
      if (d.carrierId && !carrier) throw new NotFoundException("Перевозчик не найден");
      const tot = (await orderTotals(c, id)).filter((m) => m.aql === "pass" && m.shippable > 0);
      if (!tot.length) throw new BadRequestException("Нечего отгружать: нужны упакованные изделия и итоговый AQL «принято»");
      const specs = (await c.query("SELECT model_id,pcs_per_carton,carton_l_cm::float8 AS l,carton_w_cm::float8 AS w,carton_h_cm::float8 AS h,carton_kg::float8 AS kg FROM export_pack_specs WHERE model_id = ANY($1)", [tot.map((m) => m.modelId)])).rows;
      const noSpec = tot.filter((m) => !specs.find((s: any) => s.model_id === m.modelId)).map((m) => m.code);
      if (noSpec.length) throw new BadRequestException(`Не задана упаковка: ${noSpec.join(", ")}`);
      const plan = planLoad(tot.map((m) => { const s = specs.find((x: any) => x.model_id === m.modelId); return { id: m.modelId, code: m.code, qty: m.shippable, pcsPerCarton: s.pcs_per_carton, cartonL: s.l, cartonW: s.w, cartonH: s.h, cartonKg: s.kg }; }), truck, d.fill ?? 0.9);
      let n = Number((await c.query("SELECT count(*)::int AS n FROM export_shipments WHERE order_id=$1", [id])).rows[0].n);
      const created: string[] = [];
      for (const t of plan.trucks) {
        n += 1;
        const num = `${o.number}-S${n}`;
        const sid = (await c.query(
          `INSERT INTO export_shipments (tenant_id,order_id,number,carrier,volume_m3,weight_kg,cartons,note,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [req.user.tenantId, id, num, carrier?.name ?? null, t.m3, t.kg, t.cartons, `Из плана машин (${truck.name}, загрузка ${t.fillM3}% по объёму)`, req.user.id])).rows[0].id;
        for (const it of t.items) await c.query("INSERT INTO export_shipment_lines (tenant_id,shipment_id,model_id,qty,cartons) VALUES ($1,$2,$3,$4,$5)", [req.user.tenantId, sid, it.id, it.pcs, it.cartons]);
        created.push(num);
      }
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "export_shipment", entityId: id, action: "create_from_plan", after: { created }, ip: req.ip });
      await publish(c, req.user.tenantId, { channel: "export_orders", kind: "updated", entity: "export_order", entityId: id, actorId: req.user.id });
      return { created };
    });
  }
}
