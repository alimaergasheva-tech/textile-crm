import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req } from "@nestjs/common";
import { z } from "zod";
import type pg from "pg";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { RequirePermission } from "../rbac/rbac.ts";
import { R } from "../crm/common.ts";
import { publish } from "../realtime/realtime.ts";
import { readXlsx } from "./xlsx.ts";
import { FabricSpec, parsePatternHints, parseStatus, StatusModel } from "./parsers.ts";
import { scaleQty } from "./scale.ts";

const Create = z.object({ clientId: z.string().uuid(), dealId: z.string().uuid().nullish(), brand: z.string().nullish(), collection: z.string().nullish(),
  poNo: z.string().nullish(), incoterms: z.string().default("FOB"), currency: z.enum(["UZS", "USD"]).default("USD"),
  targetExfactory: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), notes: z.string().nullish() });
const OrderPatch = z.object({ brand: z.string().nullish(), collection: z.string().nullish(), poNo: z.string().nullish(), incoterms: z.string().optional(),
  currency: z.enum(["UZS", "USD"]).optional(), targetExfactory: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), notes: z.string().nullish(),
  status: z.enum(["draft", "calculated", "quoted", "confirmed", "in_production", "shipped", "closed", "cancelled"]).optional(), version: z.number().int() });
const ModelPatch = z.object({ teePatternId: z.string().uuid().nullish(), skirtPatternId: z.string().uuid().nullish(),
  fabricTopId: z.string().uuid().nullish(), fabricBottomId: z.string().uuid().nullish(), fabricRibId: z.string().uuid().nullish(),
  sizeQty: z.record(z.string(), z.number().int().min(0)).optional(), packSize: z.string().nullish(), exFactory: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  patternConfirmed: z.boolean().optional(), version: z.number().int() });
const Import = z.object({ xlsxBase64: z.string().min(10), dryRun: z.boolean().default(true), qtyPerModel: z.number().int().positive().max(1_000_000).optional(),
  useReserve: z.boolean().default(false) });

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

@Controller("export-orders")
export class ExportOrdersController {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}

  private async number(c: pg.PoolClient): Promise<string> {
    const y = new Date().getFullYear();
    const n = Number((await c.query("SELECT count(*)::int AS n FROM export_orders")).rows[0].n) + 1;
    return `X-${y}-${String(n).padStart(4, "0")}`;
  }

  @Get() @RequirePermission("exportorders.view")
  list(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT o.id,o.number,o.brand,o.collection,o.status,o.currency,o.target_exfactory,o.version,o.created_at,cl.name AS client_name,
              (SELECT count(*)::int FROM export_models m WHERE m.order_id=o.id) AS models,
              (SELECT COALESCE(sum(qty),0)::int FROM export_models m WHERE m.order_id=o.id) AS qty
         FROM export_orders o JOIN clients cl ON cl.id=o.client_id ORDER BY o.created_at DESC LIMIT 500`)).rows);
  }

  @Get(":id") @RequirePermission("exportorders.view")
  get(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const o = (await c.query(
        `SELECT o.*,cl.name AS client_name FROM export_orders o JOIN clients cl ON cl.id=o.client_id WHERE o.id=$1`, [id])).rows[0];
      if (!o) throw new NotFoundException();
      o.models = (await c.query(
        `SELECT m.id,m.code,m.qty,m.size_qty,m.pack_size,m.ex_factory,m.spec,m.pattern_confirmed,m.version,m.sort,
                m.tee_pattern_id,m.skirt_pattern_id,m.fabric_top_id,m.fabric_bottom_id,m.fabric_rib_id,
                tp.code AS tee_pattern,sp.code AS skirt_pattern,ft.name AS fabric_top,fb.name AS fabric_bottom,fr.name AS fabric_rib
           FROM export_models m
           LEFT JOIN patterns tp ON tp.id=m.tee_pattern_id LEFT JOIN patterns sp ON sp.id=m.skirt_pattern_id
           LEFT JOIN export_fabrics ft ON ft.id=m.fabric_top_id LEFT JOIN export_fabrics fb ON fb.id=m.fabric_bottom_id LEFT JOIN export_fabrics fr ON fr.id=m.fabric_rib_id
          WHERE m.order_id=$1 ORDER BY m.sort,m.code`, [id])).rows;
      return o;
    });
  }

  @Post() @RequirePermission("exportorders.create")
  create(@Req() req: R, @Body() body: unknown) {
    const d = Create.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      if (!(await c.query("SELECT 1 FROM clients WHERE id=$1", [d.clientId])).rowCount) throw new BadRequestException("Клиент не найден");
      const number = await this.number(c);
      const id = (await c.query(
        `INSERT INTO export_orders (tenant_id,number,client_id,deal_id,brand,collection,po_no,incoterms,currency,target_exfactory,notes,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [req.user.tenantId, number, d.clientId, d.dealId ?? null, d.brand ?? null, d.collection ?? null, d.poNo ?? null, d.incoterms, d.currency,
         d.targetExfactory ?? null, d.notes ?? null, req.user.id])).rows[0].id;
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "export_order", entityId: id, action: "create", after: d, ip: req.ip });
      await publish(c, req.user.tenantId, { channel: "export_orders", kind: "created", entity: "export_order", entityId: id, actorId: req.user.id });
      return { id, number };
    });
  }

  /** Создать заказ из сделки: клиент берётся из сделки. */
  @Post("from-deal/:dealId") @RequirePermission("exportorders.create")
  fromDeal(@Req() req: R, @Param("dealId", ParseUUIDPipe) dealId: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const deal = (await c.query("SELECT id,client_id,title FROM deals WHERE id=$1", [dealId])).rows[0];
      if (!deal) throw new NotFoundException("Сделка не найдена");
      if (!deal.client_id) throw new BadRequestException("В сделке не указан клиент");
      const dup = (await c.query("SELECT id,number FROM export_orders WHERE deal_id=$1 LIMIT 1", [dealId])).rows[0];
      if (dup) return { id: dup.id, number: dup.number, existing: true };
      const number = await this.number(c);
      const id = (await c.query(
        `INSERT INTO export_orders (tenant_id,number,client_id,deal_id,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [req.user.tenantId, number, deal.client_id, dealId, deal.title, req.user.id])).rows[0].id;
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "export_order", entityId: id, action: "create", after: { dealId }, ip: req.ip });
      await publish(c, req.user.tenantId, { channel: "export_orders", kind: "created", entity: "export_order", entityId: id, actorId: req.user.id });
      return { id, number, existing: false };
    });
  }

  @Patch(":id") @RequirePermission("exportorders.edit")
  update(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = OrderPatch.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const r = await c.query(
        `UPDATE export_orders SET brand=CASE WHEN $3 THEN $4 ELSE brand END, collection=CASE WHEN $5 THEN $6 ELSE collection END,
                po_no=CASE WHEN $7 THEN $8 ELSE po_no END, incoterms=COALESCE($9,incoterms), currency=COALESCE($10,currency),
                target_exfactory=CASE WHEN $11 THEN $12::date ELSE target_exfactory END, notes=CASE WHEN $13 THEN $14 ELSE notes END,
                status=COALESCE($15,status), version=version+1
          WHERE id=$1 AND version=$2 RETURNING version`,
        [id, d.version, has(d, "brand"), d.brand ?? null, has(d, "collection"), d.collection ?? null, has(d, "poNo"), d.poNo ?? null,
         d.incoterms ?? null, d.currency ?? null, has(d, "targetExfactory"), d.targetExfactory ?? null, has(d, "notes"), d.notes ?? null, d.status ?? null]);
      if (!r.rowCount) {
        if (!(await c.query("SELECT 1 FROM export_orders WHERE id=$1", [id])).rowCount) throw new NotFoundException();
        throw new ConflictException("Заказ изменён другим пользователем, обновите страницу");
      }
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "export_order", entityId: id, action: "update", after: d, ip: req.ip });
      await publish(c, req.user.tenantId, { channel: "export_orders", kind: "updated", entity: "export_order", entityId: id, actorId: req.user.id });
      return { version: r.rows[0].version };
    });
  }

  @Delete(":id") @RequirePermission("exportorders.delete")
  remove(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const o = (await c.query("SELECT status FROM export_orders WHERE id=$1", [id])).rows[0];
      if (!o) throw new NotFoundException();
      if (o.status !== "draft") throw new ConflictException("Удалять можно только черновик");
      await c.query("DELETE FROM export_orders WHERE id=$1", [id]);
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "export_order", entityId: id, action: "delete", ip: req.ip });
      return { ok: true };
    });
  }

  @Patch(":id/models/:modelId") @RequirePermission("exportorders.edit")
  updateModel(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Param("modelId", ParseUUIDPipe) modelId: string, @Body() body: unknown) {
    const d = ModelPatch.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const qty = d.sizeQty ? Object.values(d.sizeQty).reduce((a, b) => a + b, 0) : null;
      const r = await c.query(
        `UPDATE export_models SET
           tee_pattern_id=CASE WHEN $4 THEN $5::uuid ELSE tee_pattern_id END, skirt_pattern_id=CASE WHEN $6 THEN $7::uuid ELSE skirt_pattern_id END,
           fabric_top_id=CASE WHEN $8 THEN $9::uuid ELSE fabric_top_id END, fabric_bottom_id=CASE WHEN $10 THEN $11::uuid ELSE fabric_bottom_id END,
           fabric_rib_id=CASE WHEN $12 THEN $13::uuid ELSE fabric_rib_id END,
           size_qty=COALESCE($14::jsonb,size_qty), qty=COALESCE($15,qty), pack_size=CASE WHEN $16 THEN $17 ELSE pack_size END,
           ex_factory=CASE WHEN $18 THEN $19::date ELSE ex_factory END, pattern_confirmed=COALESCE($20,pattern_confirmed), version=version+1
         WHERE id=$1 AND order_id=$2 AND version=$3 RETURNING version`,
        [modelId, id, d.version, has(d, "teePatternId"), d.teePatternId ?? null, has(d, "skirtPatternId"), d.skirtPatternId ?? null,
         has(d, "fabricTopId"), d.fabricTopId ?? null, has(d, "fabricBottomId"), d.fabricBottomId ?? null, has(d, "fabricRibId"), d.fabricRibId ?? null,
         d.sizeQty ? JSON.stringify(d.sizeQty) : null, qty, has(d, "packSize"), d.packSize ?? null, has(d, "exFactory"), d.exFactory ?? null, d.patternConfirmed ?? null]);
      if (!r.rowCount) {
        if (!(await c.query("SELECT 1 FROM export_models WHERE id=$1 AND order_id=$2", [modelId, id])).rowCount) throw new NotFoundException();
        throw new ConflictException("Модель изменена другим пользователем, обновите страницу");
      }
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "export_model", entityId: modelId, action: "update", after: d, ip: req.ip });
      await publish(c, req.user.tenantId, { channel: "export_orders", kind: "updated", entity: "export_model", entityId: modelId, actorId: req.user.id });
      return { version: r.rows[0].version };
    });
  }

  /** Импорт файла Status в существующий заказ. dryRun — только превью (ничего не пишется). */
  @Post(":id/import-status") @RequirePermission("exportorders.create")
  importStatus(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = Import.parse(body);
    let sheets, status: { models: StatusModel[]; warnings: string[] } | null = null;
    try { sheets = readXlsx(Buffer.from(d.xlsxBase64, "base64")); }
    catch (e) { throw new BadRequestException("Не удалось прочитать файл: " + (e as Error).message); }
    let lastErr = "";
    for (const sh of sheets) { try { status = parseStatus(sh); if (status.models.length) break; } catch (e) { lastErr = (e as Error).message; } }
    if (!status || !status.models.length) throw new BadRequestException(lastErr || "В файле не найдены модели");
    const hints = parsePatternHints(sheets);
    const models = status.models.map((m) => {
      const base = d.useReserve && m.qtyWithReserve ? m.qtyWithReserve : m.qty;
      const sizeQty = d.qtyPerModel ? scaleQty(m.sizeQty, d.qtyPerModel) : m.sizeQty;
      const qty = Object.values(sizeQty).reduce((a, b) => a + b, 0) || base;
      return { ...m, sizeQty, qty, teeHint: hints.get(m.code)?.tee ?? null, skirtHint: hints.get(m.code)?.skirt ?? null };
    });
    const preview = { models: models.map((m) => ({ code: m.code, qty: m.qty, sizeQty: m.sizeQty, tee: m.teeHint, skirt: m.skirtHint, exFactory: m.exFactory, packSize: m.packSize,
      top: m.top?.name ?? null, bottom: m.bottom?.name ?? null, rib: m.rib?.name ?? null })), warnings: status.warnings,
      totalQty: models.reduce((a, m) => a + m.qty, 0) };
    if (d.dryRun) return { dryRun: true, ...preview };

    return this.db.tx(req.user.tenantId, async (c) => {
      const o = (await c.query("SELECT status FROM export_orders WHERE id=$1", [id])).rows[0];
      if (!o) throw new NotFoundException();
      if (!["draft", "calculated"].includes(o.status)) throw new ConflictException("Модели можно загружать только в черновик или рассчитанный заказ");
      const tid = req.user.tenantId;
      const fabricId = async (f: FabricSpec | null): Promise<string | null> => {
        if (!f) return null;
        const ex = (await c.query("SELECT id FROM export_fabrics WHERE lower(name)=lower($1) AND gsm=$2 AND kind=$3 LIMIT 1", [f.name, f.gsm, f.kind])).rows[0];
        if (ex) return ex.id;
        const n = Number((await c.query("SELECT count(*)::int n FROM export_fabrics")).rows[0].n) + 1;
        return (await c.query(
          `INSERT INTO export_fabrics (tenant_id,code,name,composition,gsm,kind,is_aop) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [tid, `F${n}`, f.name, f.composition, f.gsm, f.kind, f.aop])).rows[0].id;
      };
      const patternId = async (code: string | null): Promise<string | null> =>
        code ? ((await c.query("SELECT id FROM patterns WHERE code=$1", [code])).rows[0]?.id ?? null) : null;
      let sort = 0;
      for (const m of models) {
        const params = [tid, id, m.code, await patternId(m.teeHint), await patternId(m.skirtHint), await fabricId(m.top), await fabricId(m.bottom), await fabricId(m.rib),
          JSON.stringify(m.sizeQty), m.qty, m.packSize, m.exFactory,
          JSON.stringify({ mainFabric: m.mainFabricText, extraFabric: m.extraFabricText, accessories: m.accessoriesText }), ++sort];
        await c.query(
          `INSERT INTO export_models (tenant_id,order_id,code,tee_pattern_id,skirt_pattern_id,fabric_top_id,fabric_bottom_id,fabric_rib_id,size_qty,qty,pack_size,ex_factory,spec,sort)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (order_id,code) DO UPDATE SET tee_pattern_id=EXCLUDED.tee_pattern_id,skirt_pattern_id=EXCLUDED.skirt_pattern_id,
             fabric_top_id=EXCLUDED.fabric_top_id,fabric_bottom_id=EXCLUDED.fabric_bottom_id,fabric_rib_id=EXCLUDED.fabric_rib_id,
             size_qty=EXCLUDED.size_qty,qty=EXCLUDED.qty,pack_size=EXCLUDED.pack_size,ex_factory=EXCLUDED.ex_factory,spec=EXCLUDED.spec,
             sort=EXCLUDED.sort,version=export_models.version+1`, params);
      }
      const ex = [...new Set(models.map((m) => m.exFactory).filter(Boolean))].sort().pop();
      if (ex) await c.query("UPDATE export_orders SET target_exfactory=COALESCE(target_exfactory,$2::date) WHERE id=$1", [id, ex]);
      await c.query("UPDATE export_orders SET version=version+1 WHERE id=$1", [id]);
      await this.audit.log(c, { tenantId: tid, userId: req.user.id, entity: "export_order", entityId: id, action: "import_status",
        after: { models: models.length, totalQty: preview.totalQty, qtyPerModel: d.qtyPerModel ?? null }, ip: req.ip });
      await publish(c, tid, { channel: "export_orders", kind: "updated", entity: "export_order", entityId: id, actorId: req.user.id });
      return { dryRun: false, ...preview };
    });
  }
}
