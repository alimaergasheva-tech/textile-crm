import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res, StreamableFile } from "@nestjs/common";
import { z } from "zod";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { RequirePermission } from "../rbac/rbac.ts";
import { R } from "../crm/common.ts";
import { calcRequirement } from "./bom.ts";
import { ean13 } from "./ean.ts";
import { buildLabelsPdf } from "./labels.ts";

const uuid = z.string().uuid();
const Model = z.object({
  code: z.string().min(1).max(40), name: z.string().min(1), collection: z.string().optional(), season: z.string().optional(),
  category: z.string().optional(), fabricComposition: z.string().optional(), care: z.string().optional(),
  description: z.string().optional(), sizeGridId: uuid.optional(), photoFileId: uuid.optional(),
});
const Material = z.object({
  code: z.string().min(1), name: z.string().min(1), type: z.enum(["fabric", "lining", "thread", "trim", "packaging"]),
  unit: z.enum(["m", "kg", "pcs", "roll", "set", "spool"]), minStock: z.number().min(0).default(0), isActive: z.boolean().default(true),
});
const Bom = z.object({ lines: z.array(z.object({ materialId: uuid, sizeId: uuid.nullable().default(null),
  qtyPerUnit: z.number().min(0), wastePercent: z.number().min(0).lt(100).default(0) })) });
const Route = z.object({ operations: z.array(z.object({ name: z.string().min(1), normMinutes: z.number().min(0).default(0),
  pieceRate: z.number().int().min(0).default(0), currency: z.enum(["UZS", "USD"]).default("UZS") })) });

@Controller()
export class CatalogController {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}

  private log(c: import("pg").PoolClient, req: R, entity: string, id: string, action: string, after?: unknown, before?: unknown) {
    return this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity, entityId: id, action, after, before, ip: req.ip });
  }

  // ---- размерные сетки и цвета ----
  @Get("size-grids") @RequirePermission("models.view")
  grids(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT g.id,g.name,COALESCE(json_agg(json_build_object('id',s.id,'label',s.label) ORDER BY s.sort) FILTER (WHERE s.id IS NOT NULL),'[]') AS sizes
         FROM size_grids g LEFT JOIN sizes s ON s.grid_id=g.id GROUP BY g.id ORDER BY g.name`)).rows);
  }

  @Post("size-grids") @RequirePermission("models.edit")
  addGrid(@Req() req: R, @Body() body: unknown) {
    const d = z.object({ name: z.string().min(1), sizes: z.array(z.string().min(1)).min(1) }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const id = (await c.query("INSERT INTO size_grids (tenant_id,name) VALUES ($1,$2) RETURNING id", [req.user.tenantId, d.name])).rows[0].id;
      for (const [i, label] of d.sizes.entries())
        await c.query("INSERT INTO sizes (tenant_id,grid_id,label,sort) VALUES ($1,$2,$3,$4)", [req.user.tenantId, id, label, i + 1]);
      await this.log(c, req, "size_grid", id, "create", d);
      return { id };
    });
  }

  @Get("colors") @RequirePermission("models.view")
  colors(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query("SELECT id,code,name_ru,name_uz,name_en,name_tr,hex FROM colors ORDER BY name_ru")).rows);
  }

  @Post("colors") @RequirePermission("models.edit")
  addColor(@Req() req: R, @Body() body: unknown) {
    const d = z.object({ code: z.string().min(1), nameRu: z.string().min(1), nameUz: z.string().optional(), nameEn: z.string().optional(), nameTr: z.string().optional(), hex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const id = (await c.query(
        `INSERT INTO colors (tenant_id,code,name_ru,name_uz,name_en,name_tr,hex) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (tenant_id,code) DO UPDATE SET name_ru=$3,name_uz=$4,name_en=$5,name_tr=$6,hex=$7 RETURNING id`,
        [req.user.tenantId, d.code, d.nameRu, d.nameUz ?? null, d.nameEn ?? null, d.nameTr ?? null, d.hex ?? null])).rows[0].id;
      await this.log(c, req, "color", id, "upsert", d);
      return { id };
    });
  }

  // ---- материалы ----
  @Get("materials") @RequirePermission("materials.view")
  materials(@Req() req: R, @Query("type") type?: string) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT id,code,name,type,unit,min_stock::float8 AS min_stock,is_active FROM materials
        WHERE ($1::text IS NULL OR type=$1) ORDER BY name`, [type ?? null])).rows);
  }

  @Post("materials") @RequirePermission("materials.create")
  addMaterial(@Req() req: R, @Body() body: unknown) {
    const d = Material.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const id = (await c.query(
        "INSERT INTO materials (tenant_id,code,name,type,unit,min_stock) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
        [req.user.tenantId, d.code, d.name, d.type, d.unit, d.minStock])).rows[0].id;
      await this.log(c, req, "material", id, "create", d);
      return { id };
    });
  }

  @Patch("materials/:id") @RequirePermission("materials.edit")
  editMaterial(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = Material.partial().parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const r = await c.query(
        `UPDATE materials SET name=COALESCE($2,name),min_stock=COALESCE($3,min_stock),is_active=COALESCE($4,is_active) WHERE id=$1`,
        [id, d.name ?? null, d.minStock ?? null, d.isActive ?? null]);
      if (!r.rowCount) throw new NotFoundException();
      await this.log(c, req, "material", id, "update", d);
      return { updated: true };
    });
  }

  // ---- модели ----
  @Get("models") @RequirePermission("models.view")
  models(@Req() req: R, @Query("q") q = "") {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT m.id,m.code,m.name,m.collection,m.season,m.category,m.is_active,
              (SELECT count(*)::int FROM variants v WHERE v.model_id=m.id) AS variants_count
         FROM models m WHERE $1='' OR m.name ILIKE '%'||$1||'%' OR m.code ILIKE '%'||$1||'%' ORDER BY m.code LIMIT 500`, [q])).rows);
  }

  /** Этикетки со штрихкодом EAN-13. ?format=a4|thermal &copies=1..100 &variantIds=id1,id2 (иначе все варианты модели). */
  @Get("models/:id/labels") @RequirePermission("models.view")
  async labels(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Query("format") format: string | undefined,
    @Query("copies") copiesRaw: string | undefined, @Query("variantIds") variantIds: string | undefined, @Res({ passthrough: true }) res: any) {
    const copies = Math.min(100, Math.max(1, Math.floor(Number(copiesRaw ?? 1)) || 1));
    const ids = variantIds ? variantIds.split(",").filter(Boolean) : [];
    if (!ids.every((x) => uuid.safeParse(x).success)) throw new BadRequestException("Неверный список вариантов");
    const items = await this.db.tx(req.user.tenantId, async (c) => {
      const m = (await c.query("SELECT code,name FROM models WHERE id=$1", [id])).rows[0];
      if (!m) throw new NotFoundException();
      const rows = (await c.query(
        `SELECT v.sku,v.barcode,col.name_ru AS color,s.label AS size
           FROM variants v JOIN sizes s ON s.id=v.size_id JOIN colors col ON col.id=v.color_id
          WHERE v.model_id=$1 AND v.is_active AND ($2::uuid[] IS NULL OR v.id = ANY($2::uuid[])) ORDER BY col.name_ru,s.sort`,
        [id, ids.length ? ids : null])).rows;
      return rows.map((r) => ({ ...r, model_code: m.code, model_name: m.name }));
    });
    if (items.length * copies > 2000) throw new BadRequestException("Слишком много этикеток за раз (максимум 2000)");
    const buf = await buildLabelsPdf(items, format === "thermal" ? "thermal" : "a4", copies);
    res.set({ "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="labels-${id}.pdf"` });
    return new StreamableFile(buf);
  }

  @Get("models/:id") @RequirePermission("models.view")
  model(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const model = (await c.query(
        `SELECT id,code,name,collection,season,category,fabric_composition,care,description,size_grid_id,photo_file_id,is_active FROM models WHERE id=$1`, [id])).rows[0];
      if (!model) throw new NotFoundException();
      const variants = (await c.query(
        `SELECT v.id,v.sku,v.barcode,v.is_active,v.size_id,s.label AS size,v.color_id,col.name_ru AS color
           FROM variants v JOIN sizes s ON s.id=v.size_id JOIN colors col ON col.id=v.color_id
          WHERE v.model_id=$1 ORDER BY col.name_ru,s.sort`, [id])).rows;
      const bom = (await c.query(
        `SELECT b.id,b.material_id,mt.name AS material,mt.unit,b.size_id,s.label AS size,b.qty_per_unit::float8 AS qty_per_unit,b.waste_percent::float8 AS waste_percent
           FROM bom_lines b JOIN materials mt ON mt.id=b.material_id LEFT JOIN sizes s ON s.id=b.size_id
          WHERE b.model_id=$1 ORDER BY mt.name,s.sort NULLS FIRST`, [id])).rows;
      const route = (await c.query(
        `SELECT step,name,norm_minutes::float8 AS norm_minutes,piece_rate::float8 AS piece_rate,currency FROM route_operations WHERE model_id=$1 ORDER BY step`, [id])).rows;
      const prices = (await c.query(
        `SELECT pl.id AS price_list_id,pl.name,pl.currency,p.amount::float8 AS amount
           FROM price_lists pl LEFT JOIN prices p ON p.price_list_id=pl.id AND p.model_id=$1 WHERE pl.is_active ORDER BY pl.name`, [id])).rows;
      return { model, variants, bom, route, prices };
    });
  }

  @Post("models") @RequirePermission("models.create")
  addModel(@Req() req: R, @Body() body: unknown) {
    const d = Model.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const id = (await c.query(
        `INSERT INTO models (tenant_id,code,name,collection,season,category,fabric_composition,care,description,size_grid_id,photo_file_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [req.user.tenantId, d.code, d.name, d.collection ?? null, d.season ?? null, d.category ?? null, d.fabricComposition ?? null,
         d.care ?? null, d.description ?? null, d.sizeGridId ?? null, d.photoFileId ?? null])).rows[0].id;
      await this.log(c, req, "model", id, "create", d);
      return { id };
    });
  }

  @Patch("models/:id") @RequirePermission("models.edit")
  editModel(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = Model.partial().extend({ isActive: z.boolean().optional() }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const before = (await c.query("SELECT name,collection,season,category,fabric_composition,size_grid_id,is_active FROM models WHERE id=$1", [id])).rows[0];
      if (!before) throw new NotFoundException();
      await c.query(
        `UPDATE models SET name=COALESCE($2,name),collection=COALESCE($3,collection),season=COALESCE($4,season),category=COALESCE($5,category),
                fabric_composition=COALESCE($6,fabric_composition),care=COALESCE($7,care),description=COALESCE($8,description),
                size_grid_id=COALESCE($9,size_grid_id),photo_file_id=COALESCE($10,photo_file_id),is_active=COALESCE($11,is_active) WHERE id=$1`,
        [id, d.name ?? null, d.collection ?? null, d.season ?? null, d.category ?? null, d.fabricComposition ?? null, d.care ?? null,
         d.description ?? null, d.sizeGridId ?? null, d.photoFileId ?? null, d.isActive ?? null]);
      await this.log(c, req, "model", id, "update", d, before);
      return { updated: true };
    });
  }

  /** Создаёт варианты «все размеры сетки модели × выбранные цвета». Существующие не трогает. */
  @Post("models/:id/variants/generate") @RequirePermission("models.edit")
  generate(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = z.object({ colorIds: z.array(uuid).min(1) }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const m = (await c.query("SELECT code,size_grid_id FROM models WHERE id=$1", [id])).rows[0];
      if (!m) throw new NotFoundException();
      if (!m.size_grid_id) throw new BadRequestException("У модели не выбрана размерная сетка");
      const sizes = (await c.query("SELECT id,label FROM sizes WHERE grid_id=$1 ORDER BY sort", [m.size_grid_id])).rows;
      const colors = (await c.query("SELECT id,code FROM colors WHERE id = ANY($1::uuid[])", [d.colorIds])).rows;
      if (colors.length !== d.colorIds.length) throw new BadRequestException("Неизвестный цвет");
      let created = 0;
      for (const col of colors) for (const s of sizes) {
        if ((await c.query("SELECT 1 FROM variants WHERE model_id=$1 AND size_id=$2 AND color_id=$3", [id, s.id, col.id])).rowCount) continue;
        const seq = Number((await c.query("SELECT nextval('barcode_seq') AS n")).rows[0].n);
        await c.query(
          "INSERT INTO variants (tenant_id,model_id,size_id,color_id,sku,barcode) VALUES ($1,$2,$3,$4,$5,$6)",
          [req.user.tenantId, id, s.id, col.id, `${m.code}-${col.code}-${s.label}`.toUpperCase().replace(/\s+/g, ""), ean13(seq)]);
        created++;
      }
      await this.log(c, req, "model", id, "generate_variants", { colorIds: d.colorIds, created });
      return { created };
    });
  }

  @Patch("variants/:id") @RequirePermission("models.edit")
  editVariant(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = z.object({ isActive: z.boolean() }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const r = await c.query("UPDATE variants SET is_active=$2 WHERE id=$1", [id, d.isActive]);
      if (!r.rowCount) throw new NotFoundException();
      await this.log(c, req, "variant", id, "update", d);
      return { updated: true };
    });
  }

  /** BOM заменяется целиком одной операцией: так проще редактировать таблицу в интерфейсе. */
  @Put("models/:id/bom") @RequirePermission("models.edit")
  setBom(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = Bom.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      if (!(await c.query("SELECT 1 FROM models WHERE id=$1", [id])).rowCount) throw new NotFoundException();
      const before = (await c.query("SELECT material_id,size_id,qty_per_unit::float8,waste_percent::float8 FROM bom_lines WHERE model_id=$1", [id])).rows;
      await c.query("DELETE FROM bom_lines WHERE model_id=$1", [id]);
      for (const l of d.lines)
        await c.query("INSERT INTO bom_lines (tenant_id,model_id,material_id,size_id,qty_per_unit,waste_percent) VALUES ($1,$2,$3,$4,$5,$6)",
          [req.user.tenantId, id, l.materialId, l.sizeId, l.qtyPerUnit, l.wastePercent]);
      await this.log(c, req, "bom", id, "replace", d.lines, before);
      return { lines: d.lines.length };
    });
  }

  @Put("models/:id/route") @RequirePermission("models.edit")
  setRoute(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = Route.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      if (!(await c.query("SELECT 1 FROM models WHERE id=$1", [id])).rowCount) throw new NotFoundException();
      const before = (await c.query("SELECT step,name,norm_minutes::float8,piece_rate::float8,currency FROM route_operations WHERE model_id=$1 ORDER BY step", [id])).rows;
      await c.query("DELETE FROM route_operations WHERE model_id=$1", [id]);
      for (const [i, o] of d.operations.entries())
        await c.query("INSERT INTO route_operations (tenant_id,model_id,step,name,norm_minutes,piece_rate,currency) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [req.user.tenantId, id, i + 1, o.name, o.normMinutes, o.pieceRate, o.currency]);
      await this.log(c, req, "route", id, "replace", d.operations, before);
      return { operations: d.operations.length };
    });
  }

  /** Расчёт потребности в материалах на партию (размер → количество). */
  @Post("models/:id/requirement") @RequirePermission("models.view")
  requirement(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = z.object({ items: z.array(z.object({ sizeId: uuid, qty: z.number().int().min(0) })) }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const rows = (await c.query(
        `SELECT b.material_id,b.size_id,b.qty_per_unit::float8 AS q,b.waste_percent::float8 AS w,m.name,m.unit
           FROM bom_lines b JOIN materials m ON m.id=b.material_id WHERE b.model_id=$1`, [id])).rows;
      const need = calcRequirement(
        rows.map((r) => ({ materialId: r.material_id, sizeId: r.size_id, qtyPerUnit: r.q, wastePercent: r.w })), d.items);
      return [...need].map(([materialId, qty]) => {
        const m = rows.find((r) => r.material_id === materialId);
        return { materialId, name: m.name, unit: m.unit, qty };
      });
    });
  }
}
