import { BadRequestException, Body, Controller, Delete, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req, ConflictException } from "@nestjs/common";
import { z } from "zod";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { RequirePermission } from "../rbac/rbac.ts";
import { R } from "../crm/common.ts";
import { readXlsx } from "./xlsx.ts";
import { parsePatterns } from "./parsers.ts";

const Fabric = z.object({ code: z.string().min(1).max(30), name: z.string().min(1), composition: z.string().nullish(), gsm: z.number().int().positive(),
  kind: z.enum(["main", "rib"]).default("main"), isAop: z.boolean().default(false), priceUsdKg: z.number().min(0).default(0), supplier: z.string().nullish() });
const FabricPatch = Fabric.partial().extend({ isActive: z.boolean().optional(), version: z.number().int() });
const Acc = z.object({ code: z.string().min(1).max(30), name: z.string().min(1), unit: z.string().min(1), priceUsd: z.number().min(0).default(0), supplier: z.string().nullish() });
const AccPatch = Acc.partial().extend({ isActive: z.boolean().optional(), version: z.number().int() });
const PatImport = z.object({ xlsxBase64: z.string().min(10), dryRun: z.boolean().default(true) });

@Controller()
export class ExportCatalogController {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}

  // ---- полотна ----
  @Get("export-fabrics") @RequirePermission("patterns.view")
  fabrics(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT id,code,name,composition,gsm,kind,is_aop,price_usd_kg,supplier,is_active,version FROM export_fabrics ORDER BY kind,code`)).rows);
  }
  @Post("export-fabrics") @RequirePermission("patterns.manage")
  createFabric(@Req() req: R, @Body() body: unknown) {
    const d = Fabric.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const id = (await c.query(
        `INSERT INTO export_fabrics (tenant_id,code,name,composition,gsm,kind,is_aop,price_usd_kg,supplier) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [req.user.tenantId, d.code, d.name, d.composition ?? null, d.gsm, d.kind, d.isAop, d.priceUsdKg, d.supplier ?? null])).rows[0].id;
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "export_fabric", entityId: id, action: "create", after: d, ip: req.ip });
      return { id };
    });
  }
  @Patch("export-fabrics/:id") @RequirePermission("patterns.manage")
  updateFabric(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = FabricPatch.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const r = await c.query(
        `UPDATE export_fabrics SET code=COALESCE($3,code),name=COALESCE($4,name),composition=COALESCE($5,composition),gsm=COALESCE($6,gsm),kind=COALESCE($7,kind),
                is_aop=COALESCE($8,is_aop),price_usd_kg=COALESCE($9,price_usd_kg),supplier=COALESCE($10,supplier),is_active=COALESCE($11,is_active),version=version+1
          WHERE id=$1 AND version=$2 RETURNING version`,
        [id, d.version, d.code ?? null, d.name ?? null, d.composition ?? null, d.gsm ?? null, d.kind ?? null, d.isAop ?? null, d.priceUsdKg ?? null, d.supplier ?? null, d.isActive ?? null]);
      if (!r.rowCount) {
        if (!(await c.query("SELECT 1 FROM export_fabrics WHERE id=$1", [id])).rowCount) throw new NotFoundException();
        throw new ConflictException("Запись изменена другим пользователем, обновите страницу");
      }
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "export_fabric", entityId: id, action: "update", after: d, ip: req.ip });
      return { version: r.rows[0].version };
    });
  }

  // ---- фурнитура ----
  @Get("export-accessories") @RequirePermission("patterns.view")
  accessories(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT id,code,name,unit,price_usd,supplier,is_active,version FROM export_accessories ORDER BY code`)).rows);
  }
  @Post("export-accessories") @RequirePermission("patterns.manage")
  createAcc(@Req() req: R, @Body() body: unknown) {
    const d = Acc.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const id = (await c.query(
        `INSERT INTO export_accessories (tenant_id,code,name,unit,price_usd,supplier) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [req.user.tenantId, d.code, d.name, d.unit, d.priceUsd, d.supplier ?? null])).rows[0].id;
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "export_accessory", entityId: id, action: "create", after: d, ip: req.ip });
      return { id };
    });
  }
  @Patch("export-accessories/:id") @RequirePermission("patterns.manage")
  updateAcc(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = AccPatch.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const r = await c.query(
        `UPDATE export_accessories SET code=COALESCE($3,code),name=COALESCE($4,name),unit=COALESCE($5,unit),price_usd=COALESCE($6,price_usd),
                supplier=COALESCE($7,supplier),is_active=COALESCE($8,is_active),version=version+1 WHERE id=$1 AND version=$2 RETURNING version`,
        [id, d.version, d.code ?? null, d.name ?? null, d.unit ?? null, d.priceUsd ?? null, d.supplier ?? null, d.isActive ?? null]);
      if (!r.rowCount) {
        if (!(await c.query("SELECT 1 FROM export_accessories WHERE id=$1", [id])).rowCount) throw new NotFoundException();
        throw new ConflictException("Запись изменена другим пользователем, обновите страницу");
      }
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "export_accessory", entityId: id, action: "update", after: d, ip: req.ip });
      return { version: r.rows[0].version };
    });
  }

  // ---- выкройки и табели мер ----
  @Get("patterns") @RequirePermission("patterns.view")
  patterns(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT p.id,p.code,p.kind,p.notes,(SELECT count(*)::int FROM pattern_measures m WHERE m.pattern_id=p.id) AS measures FROM patterns p ORDER BY p.code`)).rows);
  }
  @Get("patterns/:id") @RequirePermission("patterns.view")
  pattern(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const p = (await c.query("SELECT id,code,kind,notes FROM patterns WHERE id=$1", [id])).rows[0];
      if (!p) throw new NotFoundException();
      p.measures = (await c.query("SELECT name,tolerance,vals FROM pattern_measures WHERE pattern_id=$1 ORDER BY sort", [id])).rows;
      return p;
    });
  }
  /** Импорт файла «Табель мер»: dryRun возвращает превью, иначе заменяет мерки найденных выкроек. */
  @Post("patterns/import") @RequirePermission("patterns.manage")
  importPatterns(@Req() req: R, @Body() body: unknown) {
    const d = PatImport.parse(body);
    let parsed;
    try { parsed = parsePatterns(readXlsx(Buffer.from(d.xlsxBase64, "base64"))); }
    catch (e) { throw new BadRequestException("Не удалось прочитать файл: " + (e as Error).message); }
    const summary = parsed.patterns.map((p) => ({ code: p.code, kind: p.kind, measures: p.measures.length }));
    if (d.dryRun) return { dryRun: true, patterns: summary, warnings: parsed.warnings };
    return this.db.tx(req.user.tenantId, async (c) => {
      for (const p of parsed.patterns) {
        const id = (await c.query(
          `INSERT INTO patterns (tenant_id,code,kind) VALUES ($1,$2,$3)
           ON CONFLICT (tenant_id,code) DO UPDATE SET kind=EXCLUDED.kind,updated_at=now() RETURNING id`, [req.user.tenantId, p.code, p.kind])).rows[0].id;
        await c.query("DELETE FROM pattern_measures WHERE pattern_id=$1", [id]);
        for (const [i, m] of p.measures.entries())
          await c.query(`INSERT INTO pattern_measures (tenant_id,pattern_id,sort,name,tolerance,vals) VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (pattern_id,name) DO UPDATE SET vals=EXCLUDED.vals,tolerance=EXCLUDED.tolerance,sort=EXCLUDED.sort`,
            [req.user.tenantId, id, i, m.name, m.tolerance, JSON.stringify(m.values)]);
      }
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "pattern", action: "import", after: { patterns: summary }, ip: req.ip });
      return { dryRun: false, patterns: summary, warnings: parsed.warnings };
    });
  }
  @Delete("patterns/:id") @RequirePermission("patterns.manage")
  removePattern(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const used = (await c.query("SELECT 1 FROM export_models WHERE tee_pattern_id=$1 OR skirt_pattern_id=$1 LIMIT 1", [id])).rowCount;
      if (used) throw new ConflictException("Выкройка используется в моделях заказа");
      await c.query("DELETE FROM patterns WHERE id=$1", [id]);
      return { ok: true };
    });
  }
}
