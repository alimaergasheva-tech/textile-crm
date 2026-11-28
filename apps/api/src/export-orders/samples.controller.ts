import { BadRequestException, Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req } from "@nestjs/common";
import { z } from "zod";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { RequirePermission } from "../rbac/rbac.ts";
import { R } from "../crm/common.ts";
import { publish } from "../realtime/realtime.ts";
import { checkDates, deriveStatus, isApproved } from "./samples.ts";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Gen = z.object({ kinds: z.array(z.enum(["1fit", "pp"])).min(1).default(["1fit", "pp"]) });
const NewRound = z.object({ modelId: z.string().uuid(), kind: z.enum(["1fit", "pp"]) });
const Patch_ = z.object({
  version: z.number().int(),
  plannedSend: date.nullish(), madeAt: date.nullish(), sentAt: date.nullish(), deliveredAt: date.nullish(), decidedAt: date.nullish(),
  decision: z.enum(["approved", "approved_comments", "rejected"]).nullish(),
  courier: z.string().max(100).nullish(), awb: z.string().max(100).nullish(), clientComment: z.string().max(3000).nullish(), note: z.string().max(2000).nullish(),
});
const dstr = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : ((v as string | null) ?? null));

@Controller()
export class ExportSamplesController {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}

  @Get("export-orders/:id/samples") @RequirePermission("exportsamples.view")
  list(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT s.id,s.model_id,m.code AS model,s.kind,s.round,s.status,s.planned_send::text,s.made_at::text,s.sent_at::text,s.delivered_at::text,s.decided_at::text,
              s.courier,s.awb,s.client_comment,s.note,s.version
         FROM export_samples s JOIN export_models m ON m.id=s.model_id WHERE s.order_id=$1 ORDER BY m.sort, m.code, s.kind DESC, s.round`, [id])).rows);
  }

  /** Создаёт строки образцов по всем моделям заказа (1-й круг). Повторный вызов ничего не дублирует. */
  @Post("export-orders/:id/samples/generate") @RequirePermission("exportsamples.manage")
  generate(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = Gen.parse(body ?? {});
    return this.db.tx(req.user.tenantId, async (c) => {
      if (!(await c.query("SELECT 1 FROM export_orders WHERE id=$1 FOR UPDATE", [id])).rowCount) throw new NotFoundException();
      const models = (await c.query("SELECT id FROM export_models WHERE order_id=$1", [id])).rows;
      if (!models.length) throw new BadRequestException("В заказе нет моделей");
      let created = 0;
      for (const m of models) for (const kind of d.kinds)
        created += (await c.query(
          "INSERT INTO export_samples (tenant_id,order_id,model_id,kind,round) VALUES ($1,$2,$3,$4,1) ON CONFLICT (model_id,kind,round) DO NOTHING",
          [req.user.tenantId, id, m.id, kind])).rowCount ?? 0;
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "export_order", entityId: id, action: "samples_generate", after: { created }, ip: req.ip });
      await publish(c, req.user.tenantId, { channel: "export_orders", kind: "updated", entity: "export_order", entityId: id, actorId: req.user.id });
      return { created };
    });
  }

  /** Новый круг образца по модели — после замечаний клиента или отказа. */
  @Post("export-orders/:id/samples/round") @RequirePermission("exportsamples.manage")
  newRound(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = NewRound.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const last = (await c.query("SELECT round,status FROM export_samples WHERE order_id=$1 AND model_id=$2 AND kind=$3 ORDER BY round DESC LIMIT 1 FOR UPDATE", [id, d.modelId, d.kind])).rows[0];
      if (!last) throw new NotFoundException("Образец не найден — сначала сформируйте образцы");
      if (!["approved_comments", "rejected"].includes(last.status)) throw new BadRequestException("Новый круг нужен только после замечаний или отказа клиента");
      await c.query("INSERT INTO export_samples (tenant_id,order_id,model_id,kind,round) VALUES ($1,$2,$3,$4,$5)", [req.user.tenantId, id, d.modelId, d.kind, last.round + 1]);
      await publish(c, req.user.tenantId, { channel: "export_orders", kind: "updated", entity: "export_order", entityId: id, actorId: req.user.id });
      return { round: last.round + 1 };
    });
  }

  @Patch("export-samples/:id") @RequirePermission("exportsamples.manage")
  update(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = Patch_.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const s = (await c.query("SELECT * FROM export_samples WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!s) throw new NotFoundException();
      if (s.version !== d.version) throw new ConflictException("Запись изменена другим пользователем — обновите страницу");
      const pick = <T,>(nv: T | null | undefined, ov: T | null) => (nv === undefined ? ov : nv);
      const f = {
        plannedSend: pick(d.plannedSend, dstr(s.planned_send)), madeAt: pick(d.madeAt, dstr(s.made_at)), sentAt: pick(d.sentAt, dstr(s.sent_at)),
        deliveredAt: pick(d.deliveredAt, dstr(s.delivered_at)), decidedAt: pick(d.decidedAt, dstr(s.decided_at)),
        decision: d.decision === undefined ? (["approved", "approved_comments", "rejected"].includes(s.status) ? s.status : null) : d.decision,
      };
      if (f.decision && !f.decidedAt) f.decidedAt = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
      const err = checkDates(f);
      if (err) throw new BadRequestException(err);
      // PP отправляется только после подтверждённого 1-fit по этой модели
      if (s.kind === "pp" && f.sentAt) {
        const ok = (await c.query("SELECT status FROM export_samples WHERE model_id=$1 AND kind='1fit' ORDER BY round DESC LIMIT 1", [s.model_id])).rows[0];
        if (!ok || !isApproved(ok.status)) throw new BadRequestException("PP нельзя отправлять, пока клиент не подтвердил 1-fit по этой модели");
      }
      const status = deriveStatus(f);
      await c.query(
        `UPDATE export_samples SET planned_send=$2, made_at=$3, sent_at=$4, delivered_at=$5, decided_at=$6, status=$7,
           courier=CASE WHEN $8 THEN $9 ELSE courier END, awb=CASE WHEN $10 THEN $11 ELSE awb END,
           client_comment=CASE WHEN $12 THEN $13 ELSE client_comment END, note=CASE WHEN $14 THEN $15 ELSE note END, version=version+1 WHERE id=$1`,
        [id, f.plannedSend, f.madeAt, f.sentAt, f.deliveredAt, f.decidedAt, status,
          d.courier !== undefined, d.courier ?? null, d.awb !== undefined, d.awb ?? null, d.clientComment !== undefined, d.clientComment ?? null, d.note !== undefined, d.note ?? null]);
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "export_sample", entityId: id, action: "update", before: { status: s.status }, after: { status, awb: d.awb }, ip: req.ip });
      await publish(c, req.user.tenantId, { channel: "export_orders", kind: "updated", entity: "export_order", entityId: s.order_id, actorId: req.user.id });
      return { ok: true, status };
    });
  }
}
