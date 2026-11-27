import { BadRequestException, Body, Controller, Delete, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { RequirePermission } from "../rbac/rbac.ts";
import { R, ownerClause, addInteraction } from "./common.ts";

const Client = z.object({
  name: z.string().min(1), type: z.enum(["wholesale", "corporate", "retail", "distributor"]).default("wholesale"),
  priceType: z.enum(["retail", "wholesale", "large_wholesale"]).default("wholesale"),
  segment: z.string().optional(), taxId: z.string().optional(), address: z.string().optional(),
  creditLimit: z.number().int().min(0).default(0), creditCurrency: z.enum(["UZS", "USD"]).default("UZS"),
  ownerId: z.string().uuid().optional(),
});
const ClientPatch = Client.partial();
const Contact = z.object({ name: z.string().min(1), position: z.string().optional(), phone: z.string().optional(),
  email: z.string().email().optional(), isPrimary: z.boolean().default(false) });

@Controller()
export class ClientsController {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}

  @Get("clients") @RequirePermission("clients.view")
  list(@Req() req: R, @Query("q") q = "", @Query("page") page = "1", @Query("limit") limit = "50") {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const off = (Math.max(Number(page) || 1, 1) - 1) * lim;
    return this.db.tx(req.user.tenantId, async (c) => {
      const own = ownerClause(req.user, "clients.view", "c.owner_id", 2);
      const where = `c.deleted_at IS NULL AND ($1 = '' OR c.name ILIKE '%' || $1 || '%')${own.sql}`;
      const params = [q, ...own.params];
      const rows = (await c.query(
        `SELECT c.id,c.name,c.type,c.segment,c.credit_limit::float8 AS credit_limit,c.credit_currency,c.owner_id,
                (SELECT count(*)::int FROM deals d WHERE d.client_id=c.id AND d.deleted_at IS NULL) AS deals_count
           FROM clients c WHERE ${where} ORDER BY c.name LIMIT ${lim} OFFSET ${off}`, params)).rows;
      const total = (await c.query(`SELECT count(*)::int n FROM clients c WHERE ${where}`, params)).rows[0].n;
      return { items: rows, total };
    });
  }

  @Get("clients/:id") @RequirePermission("clients.view")
  card(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const own = ownerClause(req.user, "clients.view", "owner_id", 2);
      const client = (await c.query(
        `SELECT id,name,type,price_type,segment,tax_id,address,credit_limit::float8 AS credit_limit,credit_currency,owner_id,external_id
           FROM clients WHERE id=$1 AND deleted_at IS NULL${own.sql}`, [id, ...own.params])).rows[0];
      if (!client) throw new NotFoundException();
      const contacts = (await c.query(
        "SELECT id,name,position,phone,email,is_primary FROM contacts WHERE client_id=$1 ORDER BY is_primary DESC,name", [id])).rows;
      const deals = (await c.query(
        `SELECT d.id,d.title,d.amount::float8 AS amount,d.currency,s.name AS stage,s.kind
           FROM deals d JOIN pipeline_stages s ON s.id=d.stage_id
          WHERE d.client_id=$1 AND d.deleted_at IS NULL ORDER BY d.created_at DESC`, [id])).rows;
      const timeline = (await c.query(
        `SELECT i.id,i.type,i.text,i.created_at,u.full_name AS author
           FROM interactions i LEFT JOIN users u ON u.id=i.created_by
          WHERE i.entity='client' AND i.entity_id=$1 ORDER BY i.id DESC LIMIT 200`, [id])).rows;
      return { client, contacts, deals, timeline };
    });
  }

  @Post("clients") @RequirePermission("clients.create")
  create(@Req() req: R, @Body() body: unknown) {
    const d = Client.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const id = (await c.query(
        `INSERT INTO clients (tenant_id,name,type,price_type,segment,tax_id,address,credit_limit,credit_currency,owner_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [req.user.tenantId, d.name, d.type, d.priceType, d.segment ?? null, d.taxId ?? null, d.address ?? null,
         d.creditLimit, d.creditCurrency, d.ownerId ?? req.user.id])).rows[0].id;
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "client", entityId: id,
        action: "create", after: d, ip: req.ip });
      return { id };
    });
  }

  @Patch("clients/:id") @RequirePermission("clients.edit")
  update(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = ClientPatch.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const own = ownerClause(req.user, "clients.edit", "owner_id", 2);
      const before = (await c.query(
        `SELECT name,type,price_type,segment,tax_id,address,credit_limit::float8 AS credit_limit,credit_currency,owner_id
           FROM clients WHERE id=$1 AND deleted_at IS NULL${own.sql}`, [id, ...own.params])).rows[0];
      if (!before) throw new NotFoundException();
      await c.query(
        `UPDATE clients SET name=COALESCE($2,name),type=COALESCE($3,type),price_type=COALESCE($4,price_type),
                segment=COALESCE($5,segment),tax_id=COALESCE($6,tax_id),address=COALESCE($7,address),
                credit_limit=COALESCE($8,credit_limit),credit_currency=COALESCE($9,credit_currency),
                owner_id=COALESCE($10,owner_id) WHERE id=$1`,
        [id, d.name ?? null, d.type ?? null, d.priceType ?? null, d.segment ?? null, d.taxId ?? null, d.address ?? null,
         d.creditLimit ?? null, d.creditCurrency ?? null, d.ownerId ?? null]);
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "client", entityId: id,
        action: "update", before, after: d, ip: req.ip });
      return { updated: true };
    });
  }

  @Delete("clients/:id") @RequirePermission("clients.delete")
  remove(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const r = await c.query("UPDATE clients SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL", [id]);
      if (r.rowCount) await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id,
        entity: "client", entityId: id, action: "delete", ip: req.ip });
      return { deleted: !!r.rowCount };
    });
  }

  @Post("clients/:id/contacts") @RequirePermission("clients.edit")
  addContact(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = Contact.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const own = ownerClause(req.user, "clients.edit", "owner_id", 2);
      if (!(await c.query(`SELECT 1 FROM clients WHERE id=$1 AND deleted_at IS NULL${own.sql}`, [id, ...own.params])).rowCount)
        throw new NotFoundException();
      if (d.isPrimary) await c.query("UPDATE contacts SET is_primary=false WHERE client_id=$1", [id]);
      const cid = (await c.query(
        `INSERT INTO contacts (tenant_id,client_id,name,position,phone,email,is_primary) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [req.user.tenantId, id, d.name, d.position ?? null, d.phone ?? null, d.email ?? null, d.isPrimary])).rows[0].id;
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "contact", entityId: cid,
        action: "create", after: { clientId: id, ...d }, ip: req.ip });
      return { id: cid };
    });
  }

  @Delete("contacts/:id") @RequirePermission("clients.edit")
  removeContact(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const own = ownerClause(req.user, "clients.edit", "cl.owner_id", 2);
      const r = await c.query(
        `DELETE FROM contacts ct USING clients cl WHERE ct.id=$1 AND cl.id=ct.client_id${own.sql}`, [id, ...own.params]);
      if (r.rowCount) await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id,
        entity: "contact", entityId: id, action: "delete", ip: req.ip });
      return { deleted: !!r.rowCount };
    });
  }

  /** Запись в таймлайн клиента: звонок, сообщение, встреча или заметка. */
  @Post("clients/:id/interactions") @RequirePermission("clients.edit")
  addInteraction(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = z.object({ type: z.enum(["call", "message", "meeting", "note"]), text: z.string().min(1) }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const own = ownerClause(req.user, "clients.edit", "owner_id", 2);
      if (!(await c.query(`SELECT 1 FROM clients WHERE id=$1 AND deleted_at IS NULL${own.sql}`, [id, ...own.params])).rowCount)
        throw new BadRequestException("client");
      await addInteraction(c, req.user.tenantId, "client", id, d.type, d.text, req.user.id);
      return { ok: true };
    });
  }
}
