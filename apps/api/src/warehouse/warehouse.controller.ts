import { BadRequestException, Body, Controller, Get, Headers, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, Req } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { RequirePermission } from "../rbac/rbac.ts";
import { R } from "../crm/common.ts";
import { idem } from "../production/flow.ts";
import { applyMovement, availableForVariant, reconcile, transfer } from "./stock.ts";

const uuid = z.string().uuid();
const item = z.object({ materialId: uuid.optional(), variantId: uuid.optional(), lotId: uuid.optional(), rollId: uuid.optional() });
const qtyPos = z.number().positive();

@Controller()
export class WarehouseController {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}

  private log(c: any, req: R, entity: string, entityId: string | null, action: string, after: unknown) {
    return this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity, entityId, action, after, ip: req.ip });
  }

  // ---------- склады и ячейки ----------
  @Get("warehouses") @RequirePermission("warehouse.view")
  warehouses(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT w.id,w.name,w.kind,w.is_active,
              COALESCE(json_agg(json_build_object('id',l.id,'code',l.code,'name',l.name) ORDER BY l.code) FILTER (WHERE l.id IS NOT NULL),'[]') AS locations
         FROM warehouses w LEFT JOIN locations l ON l.warehouse_id=w.id GROUP BY w.id ORDER BY w.name`)).rows);
  }
  @Post("warehouses") @RequirePermission("warehouse.manage")
  addWarehouse(@Req() req: R, @Body() body: unknown) {
    const d = z.object({ name: z.string().min(1), kind: z.enum(["raw", "wip", "finished"]) }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const id = (await c.query("INSERT INTO warehouses (tenant_id,name,kind) VALUES ($1,$2,$3) RETURNING id", [req.user.tenantId, d.name, d.kind])).rows[0].id;
      await c.query("INSERT INTO locations (tenant_id,warehouse_id,code,name) VALUES ($1,$2,'MAIN','Основная')", [req.user.tenantId, id]);
      await this.log(c, req, "warehouse", id, "create", d);
      return { id };
    });
  }
  @Post("locations") @RequirePermission("warehouse.manage")
  addLocation(@Req() req: R, @Body() body: unknown) {
    const d = z.object({ warehouseId: uuid, code: z.string().min(1).max(30), name: z.string().optional() }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const id = (await c.query("INSERT INTO locations (tenant_id,warehouse_id,code,name) VALUES ($1,$2,$3,$4) RETURNING id",
        [req.user.tenantId, d.warehouseId, d.code, d.name ?? null])).rows[0].id;
      await this.log(c, req, "location", id, "create", d);
      return { id };
    });
  }

  // ---------- партии и рулоны ткани ----------
  @Get("fabric-lots") @RequirePermission("warehouse.view")
  lots(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT fl.id,fl.lot_number,fl.color_name,fl.shade,fl.width_cm::float8,fl.density_gsm::float8,fl.supplier,fl.received_at,
              m.code AS material_code,m.name AS material_name,m.unit,
              count(r.id)::int AS rolls, COALESCE(sum(r.qty_remaining),0)::float8 AS remaining
         FROM fabric_lots fl JOIN materials m ON m.id=fl.material_id LEFT JOIN fabric_rolls r ON r.lot_id=fl.id
        GROUP BY fl.id,m.id ORDER BY fl.received_at DESC LIMIT 200`)).rows);
  }
  @Get("fabric-lots/:id/rolls") @RequirePermission("warehouse.view")
  rolls(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      "SELECT id,roll_no,qty_initial::float8,qty_remaining::float8,barcode FROM fabric_rolls WHERE lot_id=$1 ORDER BY roll_no", [id])).rows);
  }
  /** Приход ткани партией: на каждый рулон — своя запись и своё движение. */
  @Post("fabric-lots") @RequirePermission("warehouse.write")
  receiveLot(@Req() req: R, @Body() body: unknown) {
    const d = z.object({
      materialId: uuid, locationId: uuid, lotNumber: z.string().min(1), colorName: z.string().optional(), shade: z.string().optional(),
      widthCm: z.number().positive().optional(), densityGsm: z.number().positive().optional(), supplier: z.string().optional(),
      rolls: z.array(qtyPos).min(1).max(500),
    }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const t = req.user.tenantId;
      const lotId = (await c.query(
        `INSERT INTO fabric_lots (tenant_id,material_id,lot_number,color_name,shade,width_cm,density_gsm,supplier) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [t, d.materialId, d.lotNumber, d.colorName ?? null, d.shade ?? null, d.widthCm ?? null, d.densityGsm ?? null, d.supplier ?? null])).rows[0].id;
      let n = 0;
      for (const q of d.rolls) {
        n++;
        const barcode = "RL" + randomBytes(5).toString("hex").toUpperCase();
        const rollId = (await c.query(
          "INSERT INTO fabric_rolls (tenant_id,lot_id,roll_no,qty_initial,qty_remaining,barcode,location_id) VALUES ($1,$2,$3,$4,0,$5,$6) RETURNING id",
          [t, lotId, String(n), q, barcode, d.locationId])).rows[0].id;
        await applyMovement(c, t, req.user.id, { type: "receipt", materialId: d.materialId, lotId, rollId, locationId: d.locationId, qty: q, docType: "fabric_lot", docId: lotId });
      }
      await this.log(c, req, "fabric_lot", lotId, "receive", { ...d, rolls: d.rolls.length });
      return { id: lotId, rolls: n };
    });
  }

  // ---------- операции ----------
  @Post("stock/receipts") @RequirePermission("warehouse.write")
  receipt(@Req() req: R, @Body() body: unknown, @Headers("idempotency-key") key?: string) {
    const d = item.extend({ locationId: uuid, qty: qtyPos, comment: z.string().optional(), isReturn: z.boolean().optional() }).parse(body);
    return this.op(req, "receipt", d, 1, d.isReturn ? "return" : "receipt", key);
  }
  @Post("stock/issues") @RequirePermission("warehouse.write")
  issue(@Req() req: R, @Body() body: unknown, @Headers("idempotency-key") key?: string) {
    const d = item.extend({ locationId: uuid, qty: qtyPos, comment: z.string().optional() }).parse(body);
    return this.op(req, "issue", d, -1, "issue", key);
  }
  @Post("stock/writeoffs") @RequirePermission("warehouse.write")
  writeoff(@Req() req: R, @Body() body: unknown, @Headers("idempotency-key") key?: string) {
    const d = item.extend({ locationId: uuid, qty: qtyPos, comment: z.string().min(1, "Укажите причину") }).parse(body);
    return this.op(req, "writeoff", d, -1, "writeoff", key);
  }
  private op(req: R, name: string, d: any, sign: 1 | -1, type: "receipt" | "return" | "issue" | "writeoff", key?: string) {
    return this.db.tx(req.user.tenantId, (c) => idem(c, req.user.tenantId, req.user.id, key, async () => {
      await applyMovement(c, req.user.tenantId, req.user.id, {
        type, locationId: d.locationId, qty: sign * d.qty, materialId: d.materialId, variantId: d.variantId, lotId: d.lotId, rollId: d.rollId, comment: d.comment });
      await this.log(c, req, "stock", null, name, d);
      return { ok: true };
    }));
  }
  @Post("stock/transfers") @RequirePermission("warehouse.write")
  move(@Req() req: R, @Body() body: unknown) {
    const d = item.extend({ fromLocationId: uuid, toLocationId: uuid, qty: qtyPos, comment: z.string().optional() }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      await transfer(c, req.user.tenantId, req.user.id, d.fromLocationId, d.toLocationId,
        { materialId: d.materialId, variantId: d.variantId, lotId: d.lotId, rollId: d.rollId }, d.qty, d.comment);
      await this.log(c, req, "stock", null, "transfer", d);
      return { ok: true };
    });
  }

  // ---------- просмотр ----------
  @Get("stock/balances") @RequirePermission("warehouse.view")
  balances(@Req() req: R, @Query("kind") kind?: string, @Query("q") q?: string) {
    const isVar = kind === "variant";
    return this.db.tx(req.user.tenantId, async (c) => {
      if (isVar) return (await c.query(
        `SELECT sb.variant_id AS id, mo.code AS model_code, mo.name AS model_name, s.label AS size, col.name_ru AS color, v.sku, v.barcode,
                sum(sb.qty)::float8 AS qty,
                COALESCE((SELECT sum(r.qty) FROM reservations r WHERE r.variant_id=sb.variant_id AND r.status='active'),0)::float8 AS reserved
           FROM stock_balances sb JOIN variants v ON v.id=sb.variant_id JOIN models mo ON mo.id=v.model_id
           JOIN sizes s ON s.id=v.size_id JOIN colors col ON col.id=v.color_id
          WHERE sb.variant_id IS NOT NULL AND ($1::text IS NULL OR mo.code ILIKE $1 OR mo.name ILIKE $1 OR v.sku ILIKE $1)
          GROUP BY sb.variant_id,mo.id,s.id,col.id,v.id HAVING sum(sb.qty) <> 0 ORDER BY mo.code,v.sku LIMIT 500`, [q ? `%${q}%` : null])).rows;
      return (await c.query(
        `SELECT m.id,m.code,m.name,m.unit,m.type,m.min_stock::float8,COALESCE(sum(sb.qty),0)::float8 AS qty
           FROM materials m LEFT JOIN stock_balances sb ON sb.material_id=m.id
          WHERE m.is_active AND ($1::text IS NULL OR m.code ILIKE $1 OR m.name ILIKE $1)
          GROUP BY m.id ORDER BY m.code LIMIT 500`, [q ? `%${q}%` : null])).rows;
    });
  }
  @Get("stock/low") @RequirePermission("warehouse.view")
  low(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT m.id,m.code,m.name,m.unit,m.min_stock::float8,COALESCE(sum(sb.qty),0)::float8 AS qty
         FROM materials m LEFT JOIN stock_balances sb ON sb.material_id=m.id
        WHERE m.is_active AND m.min_stock > 0 GROUP BY m.id HAVING COALESCE(sum(sb.qty),0) < m.min_stock ORDER BY m.code`)).rows);
  }
  @Get("stock/available/:variantId") @RequirePermission("warehouse.view")
  available(@Req() req: R, @Param("variantId", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, (c) => availableForVariant(c, id));
  }
  @Get("stock/movements") @RequirePermission("warehouse.view")
  movements(@Req() req: R, @Query("limit") limit?: string) {
    const n = Math.min(Math.max(parseInt(limit ?? "100", 10) || 100, 1), 500);
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT sm.id,sm.type,sm.qty::float8,sm.comment,sm.created_at,u.full_name AS user_name,
              COALESCE(m.code, mo.code || ' ' || v.sku) AS item, COALESCE(m.name, mo.name) AS item_name,
              l.code AS location, w.name AS warehouse, fl.lot_number
         FROM stock_movements sm JOIN locations l ON l.id=sm.location_id JOIN warehouses w ON w.id=l.warehouse_id
         LEFT JOIN materials m ON m.id=sm.material_id LEFT JOIN variants v ON v.id=sm.variant_id LEFT JOIN models mo ON mo.id=v.model_id
         LEFT JOIN users u ON u.id=sm.created_by LEFT JOIN fabric_lots fl ON fl.id=sm.lot_id
        ORDER BY sm.id DESC LIMIT $1`, [n])).rows);
  }
  /** Сканирование: штрихкод варианта, штрихкод рулона или код материала. */
  @Get("stock/scan") @RequirePermission("warehouse.view")
  scan(@Req() req: R, @Query("code") code: string) {
    if (!code) throw new BadRequestException("Нет кода");
    return this.db.tx(req.user.tenantId, async (c) => {
      let r = await c.query("SELECT v.id AS \"variantId\", mo.code||' '||v.sku AS label FROM variants v JOIN models mo ON mo.id=v.model_id WHERE v.barcode=$1", [code]);
      if (r.rowCount) return { kind: "variant", ...r.rows[0] };
      r = await c.query("SELECT r.id AS \"rollId\", fl.id AS \"lotId\", fl.material_id AS \"materialId\", fl.lot_number||' / '||r.roll_no AS label, r.qty_remaining::float8 AS qty FROM fabric_rolls r JOIN fabric_lots fl ON fl.id=r.lot_id WHERE r.barcode=$1", [code]);
      if (r.rowCount) return { kind: "roll", ...r.rows[0] };
      r = await c.query("SELECT id AS \"materialId\", code||' '||name AS label FROM materials WHERE code=$1", [code]);
      if (r.rowCount) return { kind: "material", ...r.rows[0] };
      throw new NotFoundException("Код не найден");
    });
  }

  // ---------- резервы ----------
  @Get("reservations") @RequirePermission("warehouse.view")
  reservations(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT r.id,r.qty::float8,r.status,r.note,r.created_at,mo.code||' '||v.sku AS item FROM reservations r
         JOIN variants v ON v.id=r.variant_id JOIN models mo ON mo.id=v.model_id ORDER BY r.created_at DESC LIMIT 200`)).rows);
  }
  @Post("reservations") @RequirePermission("warehouse.write")
  reserve(@Req() req: R, @Body() body: unknown) {
    const d = z.object({ variantId: uuid, qty: qtyPos, note: z.string().optional(), refType: z.string().optional(), refId: uuid.optional() }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [d.variantId]);   // два резерва одного товара не обгоняют друг друга
      const a = await availableForVariant(c, d.variantId);
      if (d.qty > a.available) throw new BadRequestException(`Доступно только ${a.available}`);
      const id = (await c.query("INSERT INTO reservations (tenant_id,variant_id,qty,note,ref_type,ref_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
        [req.user.tenantId, d.variantId, d.qty, d.note ?? null, d.refType ?? null, d.refId ?? null, req.user.id])).rows[0].id;
      await this.log(c, req, "reservation", id, "create", d);
      return { id };
    });
  }
  @Post("reservations/:id/release") @RequirePermission("warehouse.write")
  release(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const r = await c.query("UPDATE reservations SET status='released', closed_at=now() WHERE id=$1 AND status='active'", [id]);
      if (!r.rowCount) throw new NotFoundException();
      await this.log(c, req, "reservation", id, "release", {});
      return { ok: true };
    });
  }

  // ---------- сверка баланса ----------
  @Post("stock/reconcile") @RequirePermission("warehouse.manage")
  recon(@Req() req: R, @Body() body: unknown) {
    const d = z.object({ fix: z.boolean().default(false) }).parse(body ?? {});
    return this.db.tx(req.user.tenantId, async (c) => {
      const diffs = await reconcile(c, d.fix);
      if (diffs.length) await this.log(c, req, "stock", null, d.fix ? "reconcile_fix" : "reconcile_check", { count: diffs.length });
      return { discrepancies: diffs };
    });
  }

  // ---------- инвентаризация ----------
  @Get("inventory") @RequirePermission("warehouse.view")
  invList(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT s.id,s.status,s.created_at,s.closed_at,w.name AS warehouse,
              (SELECT count(*)::int FROM inventory_lines l WHERE l.session_id=s.id) AS lines,
              (SELECT count(*)::int FROM inventory_lines l WHERE l.session_id=s.id AND l.qty_counted IS NOT NULL) AS counted
         FROM inventory_sessions s JOIN warehouses w ON w.id=s.warehouse_id ORDER BY s.created_at DESC LIMIT 50`)).rows);
  }
  @Post("inventory") @RequirePermission("warehouse.inventory")
  invStart(@Req() req: R, @Body() body: unknown) {
    const d = z.object({ warehouseId: uuid }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const t = req.user.tenantId;
      const id = (await c.query("INSERT INTO inventory_sessions (tenant_id,warehouse_id,created_by) VALUES ($1,$2,$3) RETURNING id", [t, d.warehouseId, req.user.id])).rows[0].id;
      await c.query(
        `INSERT INTO inventory_lines (tenant_id,session_id,location_id,material_id,variant_id,lot_id,qty_system)
         SELECT $1,$2,sb.location_id,sb.material_id,sb.variant_id,sb.lot_id,sb.qty FROM stock_balances sb
           JOIN locations l ON l.id=sb.location_id WHERE l.warehouse_id=$3 AND sb.qty > 0`, [t, id, d.warehouseId]);
      await this.log(c, req, "inventory", id, "start", d);
      return { id };
    });
  }
  @Get("inventory/:id") @RequirePermission("warehouse.view")
  invGet(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const s = (await c.query("SELECT id,status FROM inventory_sessions WHERE id=$1", [id])).rows[0];
      if (!s) throw new NotFoundException();
      const lines = (await c.query(
        `SELECT il.id,il.qty_system::float8,il.qty_counted::float8,l.code AS location,
                COALESCE(m.code, mo.code||' '||v.sku) AS item, COALESCE(m.name, mo.name) AS item_name, fl.lot_number
           FROM inventory_lines il JOIN locations l ON l.id=il.location_id LEFT JOIN materials m ON m.id=il.material_id
           LEFT JOIN variants v ON v.id=il.variant_id LEFT JOIN models mo ON mo.id=v.model_id LEFT JOIN fabric_lots fl ON fl.id=il.lot_id
          WHERE il.session_id=$1 ORDER BY item`, [id])).rows;
      return { ...s, lines };
    });
  }
  @Put("inventory/:id/lines") @RequirePermission("warehouse.inventory")
  invCount(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = z.object({ counts: z.array(z.object({ lineId: uuid, counted: z.number().min(0).nullable() })) }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      if (!(await c.query("SELECT 1 FROM inventory_sessions WHERE id=$1 AND status='open'", [id])).rowCount) throw new BadRequestException("Инвентаризация закрыта");
      for (const x of d.counts) await c.query("UPDATE inventory_lines SET qty_counted=$2 WHERE id=$1 AND session_id=$3", [x.lineId, x.counted, id]);
      return { ok: true };
    });
  }
  /** Закрытие: расхождения превращаются в движения «корректировка». Остальные движения за время подсчёта учитываются автоматически. */
  @Post("inventory/:id/close") @RequirePermission("warehouse.inventory")
  invClose(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      if (!(await c.query("SELECT 1 FROM inventory_sessions WHERE id=$1 AND status='open' FOR UPDATE", [id])).rowCount) throw new BadRequestException("Инвентаризация закрыта");
      const lines = (await c.query("SELECT * FROM inventory_lines WHERE session_id=$1 AND qty_counted IS NOT NULL AND qty_counted <> qty_system", [id])).rows;
      for (const l of lines) {
        await applyMovement(c, req.user.tenantId, req.user.id, {
          type: "inventory_adjust", locationId: l.location_id, materialId: l.material_id, variantId: l.variant_id, lotId: l.lot_id,
          qty: Number(l.qty_counted) - Number(l.qty_system), docType: "inventory", docId: id, comment: "Инвентаризация" });
      }
      await c.query("UPDATE inventory_sessions SET status='closed', closed_at=now() WHERE id=$1", [id]);
      await this.log(c, req, "inventory", id, "close", { adjusted: lines.length });
      return { adjusted: lines.length };
    });
  }
}
