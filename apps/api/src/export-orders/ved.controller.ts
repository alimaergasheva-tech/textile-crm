import { Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Put, Req } from "@nestjs/common";
import { z } from "zod";
import type pg from "pg";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { RequirePermission } from "../rbac/rbac.ts";
import { R } from "../crm/common.ts";
import { computeDocs, type Details } from "./ved.ts";

const str = (n: number) => z.string().max(n).optional();
const Party = z.object({ name: str(200), address: str(500), tin: str(60), bank: str(500) }).optional();
const Model = z.object({ description: str(300), hs: str(20), composition: str(200), netKg: z.number().nonnegative().max(100).optional() });
const Save = z.object({
  version: z.number().int(),
  details: z.object({
    seller: Party, consignee: Party, invoiceNo: str(60), invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), incoterms: str(20), place: str(120), origin: str(60), paymentTerms: str(200),
    loadingPlace: str(200), deliveryPlace: str(200), driver: str(120), trailer: str(40), remarks: str(1000), models: z.record(z.string().uuid(), Model).optional(), gtd: z.record(z.string().max(40), z.string().max(500)).optional(),
  }),
});

@Controller()
export class ExportVedController {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}

  private async load(c: pg.PoolClient, tenantId: string, shipId: string) {
    const s = (await c.query(
      `SELECT s.id,s.order_id,s.number,s.status,s.carrier,s.plate,s.cmr_no,s.destination,s.loading_date::text,s.eta::text,s.volume_m3::float8 AS volume_m3,s.weight_kg::float8 AS weight_kg,s.cartons,
              o.number AS order_number,o.brand,o.collection,o.po_no,o.incoterms,o.currency,cl.name AS client_name,cl.address AS client_address,cl.tax_id AS client_tin
         FROM export_shipments s JOIN export_orders o ON o.id=s.order_id JOIN clients cl ON cl.id=o.client_id WHERE s.id=$1`, [shipId])).rows[0];
    if (!s) throw new NotFoundException();
    const lines = (await c.query(
      `SELECT l.model_id AS "modelId",m.code AS model,l.qty,l.cartons,(m.spec->>'client_price_usd')::float8 AS "unitPrice",m.spec->>'kind' AS kind
         FROM export_shipment_lines l JOIN export_models m ON m.id=l.model_id WHERE l.shipment_id=$1 ORDER BY m.sort,m.code`, [shipId])).rows;
    const saved = (await c.query("SELECT details,version FROM export_ved WHERE shipment_id=$1", [shipId])).rows[0];
    const tenant = (await c.query("SELECT name FROM tenants WHERE id=$1", [tenantId])).rows[0];
    const stored: Details = saved?.details ?? {};
    // подстановки по умолчанию: покупатель из карточки клиента, Incoterms и номер инвойса из заказа/отгрузки
    const details: Details = {
      origin: "Uzbekistan", ...stored,
      seller: { name: tenant?.name, ...stored.seller },
      consignee: { name: s.client_name, address: s.client_address ?? undefined, tin: s.client_tin ?? undefined, ...stored.consignee },
      invoiceNo: stored.invoiceNo ?? s.number, incoterms: stored.incoterms ?? s.incoterms, deliveryPlace: stored.deliveryPlace ?? s.destination,
    };
    const docs = computeDocs(s, lines, details);
    return { shipment: s, details, version: saved?.version ?? 0, ...docs, models: lines.map((l: any) => ({ modelId: l.modelId, model: l.model, kind: l.kind })) };
  }

  @Get("export-shipments/:id/ved") @RequirePermission("exportved.view")
  one(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) { return this.db.tx(req.user.tenantId, (c) => this.load(c, req.user.tenantId, id)); }

  @Put("export-shipments/:id/ved") @RequirePermission("exportved.manage")
  save(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = Save.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      if (!(await c.query("SELECT 1 FROM export_shipments WHERE id=$1", [id])).rowCount) throw new NotFoundException();
      const cur = (await c.query("SELECT version FROM export_ved WHERE shipment_id=$1 FOR UPDATE", [id])).rows[0];
      if ((cur?.version ?? 0) !== d.version) throw new ConflictException("Данные изменены другим пользователем — обновите страницу");
      if (cur) await c.query("UPDATE export_ved SET details=$2::jsonb, version=version+1, updated_by=$3, updated_at=now() WHERE shipment_id=$1", [id, JSON.stringify(d.details), req.user.id]);
      else await c.query("INSERT INTO export_ved (tenant_id,shipment_id,details,updated_by) VALUES ($1,$2,$3::jsonb,$4)", [req.user.tenantId, id, JSON.stringify(d.details), req.user.id]);
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "export_ved", entityId: id, action: "save", after: { invoiceNo: d.details.invoiceNo }, ip: req.ip });
      return this.load(c, req.user.tenantId, id);
    });
  }
}
