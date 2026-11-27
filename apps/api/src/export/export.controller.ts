import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Put, Query, Req, Res } from "@nestjs/common";
import { z } from "zod";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { AuthUser, RequirePermission } from "../rbac/rbac.ts";

type R = { user: AuthUser; ip?: string };

/** Что выгружаем: таблица для записи внешнего ID и запрос для выгрузки (SAAS-6). Деньги — в минимальных единицах. */
const ENTITIES: Record<string, { table: string; sql: string }> = {
  clients: { table: "clients", sql: `SELECT id, external_id, name, type, tax_id, address, credit_limit, credit_currency, created_at FROM clients ORDER BY created_at` },
  models: { table: "models", sql: `SELECT id, external_id, code, name, collection, season, category, is_active FROM models ORDER BY code` },
  materials: { table: "materials", sql: `SELECT id, external_id, code, name, type, unit, min_stock, is_active FROM materials ORDER BY code` },
  orders: { table: "orders", sql: `SELECT o.id, o.external_id, o.number, c.external_id AS client_external_id, c.name AS client, o.status, o.currency, o.total, o.paid, o.discount, o.due_date, o.created_at
      FROM orders o JOIN clients c ON c.id=o.client_id ORDER BY o.created_at` },
  shipments: { table: "shipments", sql: `SELECT s.id, s.external_id, s.number, o.number AS order_number, o.external_id AS order_external_id, s.status, s.shipped_at
      FROM shipments s JOIN orders o ON o.id=s.order_id ORDER BY s.created_at` },
};

const cell = (v: unknown) => {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

@Controller("export")
export class ExportController {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}

  @Get(":entity") @RequirePermission("data.export")
  async get(@Req() req: R, @Param("entity") entity: string, @Query("format") format: string | undefined, @Res() res: any) {
    const e = ENTITIES[entity];
    if (!e) throw new NotFoundException();
    const rows = await this.db.tx(req.user.tenantId, async (c) => {
      const r = (await c.query(e.sql)).rows;
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "export", action: "export", after: { entity, rows: r.length }, ip: req.ip });
      return r;
    });
    if (format === "json") return res.json(rows);
    const cols = rows.length ? Object.keys(rows[0]) : [];
    const csv = "﻿" + [cols.join(","), ...rows.map((r) => cols.map((k) => cell(r[k])).join(","))].join("\r\n");
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="${entity}.csv"`);
    res.send(csv);
  }

  /** Привязка внешнего ID (код из 1С) к записи. Пустое значение снимает привязку. */
  @Put(":entity/:id/external-id") @RequirePermission("data.export")
  async setExt(@Req() req: R, @Param("entity") entity: string, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const e = ENTITIES[entity];
    if (!e) throw new NotFoundException();
    const { externalId } = z.object({ externalId: z.string().max(100).nullable() }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      try {
        const r = await c.query(`UPDATE ${e.table} SET external_id=$2 WHERE id=$1 RETURNING id`, [id, externalId || null]);
        if (!r.rowCount) throw new NotFoundException();
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw new BadRequestException("Такой внешний ID уже используется");
        throw err;
      }
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity, entityId: id, action: "set_external_id", after: { externalId }, ip: req.ip });
      return { ok: true };
    });
  }
}
