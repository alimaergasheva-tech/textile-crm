import { Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Put, Req } from "@nestjs/common";
import { z } from "zod";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { RequirePermission } from "../rbac/rbac.ts";
import { R } from "../crm/common.ts";

@Controller("price-lists")
export class PricingController {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}

  @Get() @RequirePermission("pricing.view")
  list(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT pl.id,pl.name,pl.price_type,pl.currency,pl.is_active,(SELECT count(*)::int FROM prices p WHERE p.price_list_id=pl.id) AS items
         FROM price_lists pl ORDER BY pl.name`)).rows);
  }

  @Post() @RequirePermission("pricing.edit")
  create(@Req() req: R, @Body() body: unknown) {
    const d = z.object({ name: z.string().min(1), priceType: z.enum(["retail", "wholesale", "large_wholesale"]), currency: z.enum(["UZS", "USD"]) }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const id = (await c.query("INSERT INTO price_lists (tenant_id,name,price_type,currency) VALUES ($1,$2,$3,$4) RETURNING id",
        [req.user.tenantId, d.name, d.priceType, d.currency])).rows[0].id;
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "price_list", entityId: id, action: "create", after: d, ip: req.ip });
      return { id };
    });
  }

  @Get(":id/prices") @RequirePermission("pricing.view")
  prices(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT m.id AS model_id,m.code,m.name,p.amount::float8 AS amount
         FROM models m LEFT JOIN prices p ON p.model_id=m.id AND p.price_list_id=$1 WHERE m.is_active ORDER BY m.code`, [id])).rows);
  }

  /** Заменяет цены по переданным моделям; amount = null — убрать цену. Суммы в минимальных единицах. */
  @Put(":id/prices") @RequirePermission("pricing.edit")
  setPrices(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = z.object({ prices: z.array(z.object({ modelId: z.string().uuid(), amount: z.number().int().min(0).nullable() })) }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      if (!(await c.query("SELECT 1 FROM price_lists WHERE id=$1", [id])).rowCount) throw new NotFoundException();
      for (const p of d.prices) {
        if (p.amount === null) await c.query("DELETE FROM prices WHERE price_list_id=$1 AND model_id=$2", [id, p.modelId]);
        else await c.query(
          `INSERT INTO prices (tenant_id,price_list_id,model_id,amount) VALUES ($1,$2,$3,$4)
           ON CONFLICT (price_list_id,model_id) DO UPDATE SET amount=$4`, [req.user.tenantId, id, p.modelId, p.amount]);
      }
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "price_list", entityId: id, action: "set_prices", after: d.prices, ip: req.ip });
      return { updated: d.prices.length };
    });
  }
}
