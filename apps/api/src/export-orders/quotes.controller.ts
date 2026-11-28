import { BadRequestException, Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req } from "@nestjs/common";
import { z } from "zod";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { RequirePermission } from "../rbac/rbac.ts";
import { R } from "../crm/common.ts";
import { publish } from "../realtime/realtime.ts";
import { computeConsumption } from "./consumption.service.ts";
import { costOrder } from "./costing.ts";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Create = z.object({ promisedExfactory: date.nullish(), validUntil: date.nullish(), notes: z.string().max(2000).nullish() });
const Status = z.object({
  status: z.enum(["sent", "confirmed", "rejected"]), version: z.number().int(),
  confirmedByName: z.string().min(2).max(200).optional(), note: z.string().max(2000).optional(),
});
// Допустимые переходы: черновик → отправлено → подтверждено/отклонено; черновик можно отправить или отклонить.
const NEXT: Record<string, string[]> = { draft: ["sent", "rejected"], sent: ["confirmed", "rejected"] };

@Controller()
export class QuotesController {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}

  private async costing(c: Parameters<typeof computeConsumption>[0], orderId: string) {
    const cons = await computeConsumption(c, orderId);
    if (!cons) throw new NotFoundException();
    if (!cons.models.length) throw new BadRequestException("В заказе нет моделей");
    return { cons, cost: costOrder({ params: cons.params, accPrices: cons.accPrices, models: cons.models }) };
  }

  /** Живой расчёт себестоимости и цены (без фиксации). */
  @Get("export-orders/:id/costing") @RequirePermission("exportquotes.view")
  costingGet(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const { cons, cost } = await this.costing(c, id);
      return { params: cons.params, version: cons.version, ...cost, warnings: [...cost.warnings, ...cons.warnings] };
    });
  }

  @Get("export-orders/:id/quotes") @RequirePermission("exportquotes.view")
  list(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT id,number,rev,status,currency,totals,promised_exfactory,valid_until,notes,sent_at,decided_at,decided_note,confirmed_by_name,version,created_at
         FROM export_quotes WHERE order_id=$1 ORDER BY rev DESC`, [id])).rows);
  }

  @Get("export-quotes/:id") @RequirePermission("exportquotes.view")
  one(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const q = (await c.query("SELECT * FROM export_quotes WHERE id=$1", [id])).rows[0];
      if (!q) throw new NotFoundException();
      return q;
    });
  }

  /** Зафиксировать КП: снимок текущего расчёта. Предыдущие неотправленные черновики заменяются. */
  @Post("export-orders/:id/quotes") @RequirePermission("exportquotes.manage")
  create(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = Create.parse(body ?? {});
    return this.db.tx(req.user.tenantId, async (c) => {
      const order = (await c.query("SELECT number,currency,status FROM export_orders WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!order) throw new NotFoundException();
      if (["in_production", "shipped", "closed", "cancelled"].includes(order.status)) throw new ConflictException("Заказ уже в работе или закрыт");
      if ((await c.query("SELECT 1 FROM export_quotes WHERE order_id=$1 AND status='confirmed'", [id])).rowCount) throw new ConflictException("По заказу уже есть подтверждённое КП");
      const { cons, cost } = await this.costing(c, id);
      const rev = Number((await c.query("SELECT COALESCE(max(rev),0)+1 AS n FROM export_quotes WHERE order_id=$1", [id])).rows[0].n);
      await c.query("UPDATE export_quotes SET status='superseded',version=version+1 WHERE order_id=$1 AND status IN ('draft','sent')", [id]);
      const number = `Q-${order.number.replace(/^X-/, "")}-${rev}`;
      const qid = (await c.query(
        `INSERT INTO export_quotes (tenant_id,order_id,number,rev,currency,params,lines,totals,promised_exfactory,valid_until,notes,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [req.user.tenantId, id, number, rev, order.currency, JSON.stringify(cons.params), JSON.stringify(cost.lines), JSON.stringify(cost.totals),
         d.promisedExfactory ?? null, d.validUntil ?? null, d.notes ?? null, req.user.id])).rows[0].id;
      await c.query("UPDATE export_orders SET status=CASE WHEN status='draft' THEN 'calculated' ELSE status END, version=version+1 WHERE id=$1", [id]);
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "export_quote", entityId: qid, action: "create", after: { number, totals: cost.totals }, ip: req.ip });
      await publish(c, req.user.tenantId, { channel: "export_orders", kind: "updated", entity: "export_order", entityId: id, actorId: req.user.id });
      return { id: qid, number, rev };
    });
  }

  /** Смена статуса КП: отправлено клиенту → подтверждено/отклонено. Подтверждение переводит заказ в «подтверждён». */
  @Patch("export-quotes/:id/status") @RequirePermission("exportquotes.manage")
  setStatus(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = Status.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const q = (await c.query("SELECT id,order_id,status,version FROM export_quotes WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!q) throw new NotFoundException();
      if (q.version !== d.version) throw new ConflictException("КП изменено другим пользователем, обновите страницу");
      if (!NEXT[q.status]?.includes(d.status)) throw new ConflictException(`Переход «${q.status}» → «${d.status}» невозможен`);
      if (d.status === "confirmed" && !d.confirmedByName) throw new BadRequestException("Укажите, кто со стороны клиента подтвердил цену и срок");
      await c.query(
        `UPDATE export_quotes SET status=$2,version=version+1,
                sent_at=CASE WHEN $2='sent' THEN now() ELSE sent_at END, sent_by=CASE WHEN $2='sent' THEN $3::uuid ELSE sent_by END,
                decided_at=CASE WHEN $2 IN ('confirmed','rejected') THEN now() ELSE decided_at END,
                decided_note=COALESCE($4,decided_note), confirmed_by_name=COALESCE($5,confirmed_by_name) WHERE id=$1`,
        [id, d.status, req.user.id, d.note ?? null, d.confirmedByName ?? null]);
      if (d.status === "sent") await c.query("UPDATE export_orders SET status='quoted',version=version+1 WHERE id=$1 AND status IN ('draft','calculated')", [q.order_id]);
      if (d.status === "confirmed") await c.query("UPDATE export_orders SET status='confirmed',version=version+1 WHERE id=$1 AND status IN ('draft','calculated','quoted')", [q.order_id]);
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "export_quote", entityId: id, action: "status_" + d.status, after: d, ip: req.ip });
      await publish(c, req.user.tenantId, { channel: "export_orders", kind: "updated", entity: "export_order", entityId: q.order_id, actorId: req.user.id });
      return { ok: true };
    });
  }
}
