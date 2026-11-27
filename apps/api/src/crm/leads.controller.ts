import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { RequirePermission } from "../rbac/rbac.ts";
import { R, ownerClause, addInteraction } from "./common.ts";

const Lead = z.object({
  name: z.string().min(1), company: z.string().optional(), phone: z.string().optional(), email: z.string().email().optional(),
  sourceCode: z.string().min(1, "Источник обязателен"), note: z.string().optional(), ownerId: z.string().uuid().optional(),
});
const LeadPatch = z.object({ status: z.enum(["new", "in_work", "rejected"]).optional(), note: z.string().optional(),
  ownerId: z.string().uuid().optional() });

@Controller("leads")
export class LeadsController {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}

  @Get() @RequirePermission("leads.view")
  list(@Req() req: R, @Query("status") status?: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const own = ownerClause(req.user, "leads.view", "l.owner_id", 2);
      return (await c.query(
        `SELECT l.id,l.name,l.company,l.phone,l.email,l.source_code,l.note,l.status,l.owner_id,l.client_id,l.created_at
           FROM leads l WHERE ($1::text IS NULL OR l.status=$1)${own.sql} ORDER BY l.created_at DESC LIMIT 500`,
        [status ?? null, ...own.params])).rows;
    });
  }

  @Post() @RequirePermission("leads.create")
  create(@Req() req: R, @Body() body: unknown) {
    const d = Lead.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      // Источник должен быть значением справочника фабрики (CRM-1).
      const ok = await c.query("SELECT 1 FROM reference_values WHERE dictionary='lead_source' AND code=$1 AND is_active", [d.sourceCode]);
      if (!ok.rowCount) throw new BadRequestException("Неизвестный источник лида");
      const id = (await c.query(
        `INSERT INTO leads (tenant_id,name,company,phone,email,source_code,note,owner_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [req.user.tenantId, d.name, d.company ?? null, d.phone ?? null, d.email ?? null, d.sourceCode, d.note ?? null,
         d.ownerId ?? req.user.id])).rows[0].id;
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "lead", entityId: id,
        action: "create", after: d, ip: req.ip });
      return { id };
    });
  }

  @Patch(":id") @RequirePermission("leads.edit")
  update(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = LeadPatch.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const own = ownerClause(req.user, "leads.edit", "owner_id", 2);
      const before = (await c.query(`SELECT status,note,owner_id FROM leads WHERE id=$1${own.sql}`, [id, ...own.params])).rows[0];
      if (!before) throw new NotFoundException();
      await c.query("UPDATE leads SET status=COALESCE($2,status),note=COALESCE($3,note),owner_id=COALESCE($4,owner_id) WHERE id=$1",
        [id, d.status ?? null, d.note ?? null, d.ownerId ?? null]);
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "lead", entityId: id,
        action: "update", before, after: d, ip: req.ip });
      return { updated: true };
    });
  }

  /** Лид → клиент (+ контакт) и, по желанию, первая сделка на первом этапе воронки. */
  @Post(":id/convert") @RequirePermission("leads.edit")
  convert(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = z.object({ createDeal: z.boolean().default(true), dealTitle: z.string().optional() }).parse(body ?? {});
    return this.db.tx(req.user.tenantId, async (c) => {
      const own = ownerClause(req.user, "leads.edit", "owner_id", 2);
      const lead = (await c.query(`SELECT * FROM leads WHERE id=$1 AND status<>'converted'${own.sql} FOR UPDATE`, [id, ...own.params])).rows[0];
      if (!lead) throw new NotFoundException();
      const clientId = (await c.query(
        "INSERT INTO clients (tenant_id,name,owner_id) VALUES ($1,$2,$3) RETURNING id",
        [req.user.tenantId, lead.company || lead.name, lead.owner_id ?? req.user.id])).rows[0].id;
      await c.query("INSERT INTO contacts (tenant_id,client_id,name,phone,email,is_primary) VALUES ($1,$2,$3,$4,$5,true)",
        [req.user.tenantId, clientId, lead.name, lead.phone, lead.email]);
      let dealId: string | null = null;
      if (d.createDeal) {
        const stage = (await c.query("SELECT id FROM pipeline_stages WHERE kind='open' AND is_active ORDER BY sort LIMIT 1")).rows[0];
        if (!stage) throw new BadRequestException("В воронке нет открытых этапов");
        dealId = (await c.query(
          `INSERT INTO deals (tenant_id,title,client_id,stage_id,owner_id,lead_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [req.user.tenantId, d.dealTitle || `Сделка: ${lead.company || lead.name}`, clientId, stage.id, lead.owner_id ?? req.user.id, id])).rows[0].id;
      }
      await c.query("UPDATE leads SET status='converted', client_id=$2 WHERE id=$1", [id, clientId]);
      await addInteraction(c, req.user.tenantId, "client", clientId, "system", `Создан из лида (источник: ${lead.source_code})`, req.user.id);
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "lead", entityId: id,
        action: "convert", after: { clientId, dealId }, ip: req.ip });
      return { clientId, dealId };
    });
  }
}
