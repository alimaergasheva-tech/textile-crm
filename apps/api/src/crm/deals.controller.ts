import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req } from "@nestjs/common";
import { z } from "zod";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { RequirePermission } from "../rbac/rbac.ts";
import { R, ownerClause, addInteraction } from "./common.ts";

const Deal = z.object({
  title: z.string().min(1), clientId: z.string().uuid(), stageId: z.string().uuid().optional(),
  amount: z.number().int().min(0).default(0), currency: z.enum(["UZS", "USD"]).default("UZS"),
  expectedClose: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), ownerId: z.string().uuid().optional(),
});
const DealPatch = z.object({ title: z.string().min(1).optional(), amount: z.number().int().min(0).optional(),
  currency: z.enum(["UZS", "USD"]).optional(), expectedClose: z.string().optional(), ownerId: z.string().uuid().optional() });
const StageMove = z.object({ stageId: z.string().uuid(), lostReasonCode: z.string().optional() });

@Controller()
export class DealsController {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}

  /** Справочники для форм CRM: читать их может любой вошедший пользователь, это не настройки. */
  @Get("dictionaries")
  dictionaries(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT dictionary,code,name_ru,name_uz,name_en,name_tr FROM reference_values
        WHERE is_active AND dictionary IN ('lead_source','loss_reason') ORDER BY dictionary,sort`)).rows);
  }

  @Get("pipeline-stages") @RequirePermission("deals.view")
  stages(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) =>
      (await c.query("SELECT id,name,sort,kind FROM pipeline_stages WHERE is_active ORDER BY sort")).rows);
  }

  /** Данные канбана: этапы и сделки (суммы по этапам считает клиент по валютам). */
  @Get("deals") @RequirePermission("deals.view")
  list(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const own = ownerClause(req.user, "deals.view", "d.owner_id", 1);
      const stages = (await c.query("SELECT id,name,sort,kind FROM pipeline_stages WHERE is_active ORDER BY sort")).rows;
      const deals = (await c.query(
        `SELECT d.id,d.title,d.stage_id,d.amount::float8 AS amount,d.currency,d.owner_id,d.expected_close::text,
                d.last_activity_at,cl.id AS client_id,cl.name AS client_name,u.full_name AS owner_name
           FROM deals d JOIN clients cl ON cl.id=d.client_id LEFT JOIN users u ON u.id=d.owner_id
          WHERE d.deleted_at IS NULL${own.sql} ORDER BY d.last_activity_at DESC LIMIT 1000`, own.params)).rows;
      return { stages, deals };
    });
  }

  @Post("deals") @RequirePermission("deals.create")
  create(@Req() req: R, @Body() body: unknown) {
    const d = Deal.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      if (!(await c.query("SELECT 1 FROM clients WHERE id=$1 AND deleted_at IS NULL", [d.clientId])).rowCount)
        throw new BadRequestException("Клиент не найден");
      const stage = d.stageId
        ? (await c.query("SELECT id FROM pipeline_stages WHERE id=$1 AND kind='open'", [d.stageId])).rows[0]
        : (await c.query("SELECT id FROM pipeline_stages WHERE kind='open' AND is_active ORDER BY sort LIMIT 1")).rows[0];
      if (!stage) throw new BadRequestException("Этап не найден");
      const id = (await c.query(
        `INSERT INTO deals (tenant_id,title,client_id,stage_id,amount,currency,expected_close,owner_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [req.user.tenantId, d.title, d.clientId, stage.id, d.amount, d.currency, d.expectedClose ?? null, d.ownerId ?? req.user.id])).rows[0].id;
      await addInteraction(c, req.user.tenantId, "client", d.clientId, "system", `Создана сделка «${d.title}»`, req.user.id);
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "deal", entityId: id,
        action: "create", after: d, ip: req.ip });
      return { id };
    });
  }

  @Patch("deals/:id") @RequirePermission("deals.edit")
  update(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = DealPatch.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const own = ownerClause(req.user, "deals.edit", "owner_id", 2);
      const before = (await c.query(
        `SELECT title,amount::float8 AS amount,currency,expected_close::text,owner_id FROM deals WHERE id=$1 AND deleted_at IS NULL${own.sql}`,
        [id, ...own.params])).rows[0];
      if (!before) throw new NotFoundException();
      await c.query(
        `UPDATE deals SET title=COALESCE($2,title),amount=COALESCE($3,amount),currency=COALESCE($4,currency),
                expected_close=COALESCE($5::date,expected_close),owner_id=COALESCE($6,owner_id),last_activity_at=now() WHERE id=$1`,
        [id, d.title ?? null, d.amount ?? null, d.currency ?? null, d.expectedClose ?? null, d.ownerId ?? null]);
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "deal", entityId: id,
        action: "update", before, after: d, ip: req.ip });
      return { updated: true };
    });
  }

  /** Перенос по этапам. Проигрыш требует причину из справочника loss_reason (CRM-2). */
  @Patch("deals/:id/stage") @RequirePermission("deals.edit")
  move(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = StageMove.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const own = ownerClause(req.user, "deals.edit", "owner_id", 2);
      const deal = (await c.query(
        `SELECT d.stage_id,d.client_id,s.name AS from_name FROM deals d JOIN pipeline_stages s ON s.id=d.stage_id
          WHERE d.id=$1 AND d.deleted_at IS NULL${own.sql.replace("owner_id", "d.owner_id")} FOR UPDATE OF d`, [id, ...own.params])).rows[0];
      if (!deal) throw new NotFoundException();
      const to = (await c.query("SELECT id,name,kind FROM pipeline_stages WHERE id=$1 AND is_active", [d.stageId])).rows[0];
      if (!to) throw new BadRequestException("Этап не найден");
      if (to.kind === "lost") {
        if (!d.lostReasonCode) throw new BadRequestException("Укажите причину проигрыша");
        if (!(await c.query("SELECT 1 FROM reference_values WHERE dictionary='loss_reason' AND code=$1", [d.lostReasonCode])).rowCount)
          throw new BadRequestException("Неизвестная причина проигрыша");
      }
      await c.query(
        `UPDATE deals SET stage_id=$2, lost_reason_code=$3, closed_at=CASE WHEN $4 IN ('won','lost') THEN now() ELSE NULL END,
                last_activity_at=now() WHERE id=$1`,
        [id, to.id, to.kind === "lost" ? d.lostReasonCode : null, to.kind]);
      await addInteraction(c, req.user.tenantId, "client", deal.client_id, "stage_change",
        `${deal.from_name} → ${to.name}${to.kind === "lost" ? ` (${d.lostReasonCode})` : ""}`, req.user.id);
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "deal", entityId: id,
        action: "move_stage", before: { stageId: deal.stage_id }, after: d, ip: req.ip });
      return { stageId: to.id, kind: to.kind };
    });
  }
}
