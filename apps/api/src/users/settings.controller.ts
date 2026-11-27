import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Put, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { AuthUser, RequirePermission } from "../rbac/rbac.ts";

type R = { user: AuthUser; ip?: string };
const SetPerms = z.object({ permissions: z.array(z.object({ code: z.string(), ownOnly: z.boolean().default(false) })) });
const Rate = z.object({ validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), uzsPerUsd: z.number().positive() });
const RefValue = z.object({ dictionary: z.string().min(1), code: z.string().min(1), nameRu: z.string().min(1),
  nameUz: z.string().optional(), nameEn: z.string().optional(), nameTr: z.string().optional(), sort: z.number().int().default(0), isActive: z.boolean().default(true) });

@Controller()
export class SettingsController {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}

  @Get("roles") @RequirePermission("roles.view")
  roles(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT r.id,r.code,r.name,r.is_system,
              COALESCE(json_agg(json_build_object('code',rp.permission_code,'ownOnly',rp.own_only))
                       FILTER (WHERE rp.permission_code IS NOT NULL),'[]') AS permissions
         FROM roles r LEFT JOIN role_permissions rp ON rp.role_id=r.id GROUP BY r.id ORDER BY r.name`)).rows);
  }

  @Get("permissions") @RequirePermission("roles.view")
  async permissions(@Req() req: R) {
    return (await this.db.pool.query("SELECT code,module,action,description FROM permissions ORDER BY module,action")).rows;
  }

  @Put("roles/:id/permissions") @RequirePermission("roles.manage")
  setPermissions(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = SetPerms.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const before = (await c.query("SELECT permission_code,own_only FROM role_permissions WHERE role_id=$1", [id])).rows;
      await c.query("DELETE FROM role_permissions WHERE role_id=$1", [id]);
      for (const p of d.permissions)
        await c.query("INSERT INTO role_permissions (tenant_id,role_id,permission_code,own_only) VALUES ($1,$2,$3,$4)",
          [req.user.tenantId, id, p.code, p.ownOnly]);
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "role", entityId: id,
        action: "set_permissions", before, after: d.permissions, ip: req.ip });
      return { ok: true };
    });
  }

  @Get("reference-values") @RequirePermission("settings.view")
  refs(@Req() req: R, @Query("dictionary") dictionary?: string) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT id,dictionary,code,name_ru,name_uz,name_en,name_tr,sort,is_active FROM reference_values
        WHERE ($1::text IS NULL OR dictionary=$1) ORDER BY dictionary,sort,name_ru`, [dictionary ?? null])).rows);
  }

  @Put("reference-values") @RequirePermission("settings.manage")
  upsertRef(@Req() req: R, @Body() body: unknown) {
    const d = RefValue.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const id = (await c.query(
        `INSERT INTO reference_values (tenant_id,dictionary,code,name_ru,name_uz,name_en,name_tr,sort,is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (tenant_id,dictionary,code) DO UPDATE
           SET name_ru=$4,name_uz=$5,name_en=$6,name_tr=$7,sort=$8,is_active=$9 RETURNING id`,
        [req.user.tenantId, d.dictionary, d.code, d.nameRu, d.nameUz ?? null, d.nameEn ?? null, d.nameTr ?? null, d.sort, d.isActive])).rows[0].id;
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "reference_value",
        entityId: id, action: "upsert", after: d, ip: req.ip });
      return { id };
    });
  }

  @Get("audit") @RequirePermission("audit.view")
  auditList(@Req() req: R, @Query("entity") entity?: string, @Query("limit") limit = "100") {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT id,user_id,entity,entity_id,action,before,after,created_at FROM audit_log
        WHERE ($1::text IS NULL OR entity=$1) ORDER BY id DESC LIMIT $2`,
      [entity ?? null, Math.min(Number(limit) || 100, 500)])).rows);
  }

  @Get("exchange-rates") @RequirePermission("settings.view")
  rates(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      "SELECT id, valid_from::text, uzs_per_usd::float AS uzs_per_usd FROM exchange_rates ORDER BY valid_from DESC LIMIT 100")).rows);
  }

  @Put("exchange-rates") @RequirePermission("settings.manage")
  setRate(@Req() req: R, @Body() body: unknown) {
    const d = Rate.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const id = (await c.query(
        `INSERT INTO exchange_rates (tenant_id,valid_from,uzs_per_usd,created_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id,valid_from) DO UPDATE SET uzs_per_usd=$3, created_by=$4 RETURNING id`,
        [req.user.tenantId, d.validFrom, d.uzsPerUsd, req.user.id])).rows[0].id;
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "exchange_rate",
        entityId: id, action: "upsert", after: d, ip: req.ip });
      return { id };
    });
  }
}
