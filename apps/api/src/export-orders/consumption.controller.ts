import { Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Put, Req, ConflictException } from "@nestjs/common";
import { z } from "zod";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { RequirePermission } from "../rbac/rbac.ts";
import { R } from "../crm/common.ts";
import { publish } from "../realtime/realtime.ts";
import { mergeParams } from "./consumption.ts";
import { computeConsumption } from "./consumption.service.ts";

const frac = z.number().min(0).max(1);
const ParamsBody = z.object({
  wasteMain: frac.optional(), wasteRib: frac.optional(), ribStripCm: z.number().min(0).max(50).optional(), sleeveAllowanceGkt11: frac.optional(),
  fabricWidthM: z.number().positive().max(5).optional(), trimsReserve: frac.optional(), fabricOrderReserve: frac.optional(),
  bowCordCm: z.number().min(0).max(500).optional(), unitsPerCarton: z.number().int().positive().max(1000).optional(),
  cmtUsd: z.number().min(0).max(1000).optional(), otherPerSetUsd: z.number().min(0).max(1000).optional(), marginPct: z.number().min(0).max(0.9).optional(), logisticsUsd: z.number().min(0).max(1000).optional(), version: z.number().int(),
});
/** Расчёт расхода полотна и фурнитуры по заказу. Считается «на лету» из моделей, табелей мер и параметров (снимок — на этапе закупок). */
@Controller("export-orders")
export class ConsumptionController {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}

  @Get(":id/consumption") @RequirePermission("exportorders.view")
  get(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const r = await computeConsumption(c, id);
      if (!r) throw new NotFoundException();
      return r;
    });
  }

  @Put(":id/calc-params") @RequirePermission("exportorders.edit")
  setParams(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = ParamsBody.parse(body);
    const { version, ...changes } = d;
    return this.db.tx(req.user.tenantId, async (c) => {
      const r = await c.query(
        "UPDATE export_orders SET calc_params=calc_params || $3::jsonb, version=version+1 WHERE id=$1 AND version=$2 RETURNING version,calc_params",
        [id, version, JSON.stringify(changes)]);
      if (!r.rowCount) {
        if (!(await c.query("SELECT 1 FROM export_orders WHERE id=$1", [id])).rowCount) throw new NotFoundException();
        throw new ConflictException("Заказ изменён другим пользователем, обновите страницу");
      }
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "export_order", entityId: id, action: "calc_params", after: changes, ip: req.ip });
      await publish(c, req.user.tenantId, { channel: "export_orders", kind: "updated", entity: "export_order", entityId: id, actorId: req.user.id });
      return { version: r.rows[0].version, params: mergeParams(r.rows[0].calc_params) };
    });
  }
}
