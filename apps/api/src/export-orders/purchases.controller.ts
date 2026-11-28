import { BadRequestException, Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req } from "@nestjs/common";
import { z } from "zod";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { RequirePermission } from "../rbac/rbac.ts";
import { R } from "../crm/common.ts";
import { publish } from "../realtime/realtime.ts";
import { computeConsumption } from "./consumption.service.ts";
import { canMove, fabricLines, lineTotal, PLine, PStatus, STATUSES, sumLines, trimLines } from "./purchases.ts";

const Gen = z.object({ fabricSupplier: z.string().min(1).max(100).default("Uztex"), trimsSupplier: z.string().min(1).max(100).default("Eren Textile") });
const Status = z.object({
  version: z.number().int(), status: z.enum(STATUSES),
  expectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), paymentNote: z.string().max(500).nullish(), note: z.string().max(2000).nullish(),
});
const LinePatch = z.object({ qty: z.number().positive().optional(), priceUsd: z.number().min(0).optional() });

@Controller()
export class ExportPurchasesController {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}

  @Get("export-orders/:id/purchases") @RequirePermission("exportpurchases.view")
  list(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const ps = (await c.query(
        `SELECT id,number,kind,supplier,status,currency,expected_date::text,sent_at,confirmed_at,received_at,payment_note,note,total_usd::float8 AS total_usd,version
           FROM export_purchases WHERE order_id=$1 ORDER BY kind DESC, number`, [id])).rows;
      for (const p of ps) p.lines = (await c.query(
        "SELECT id,item_code,name,unit,qty::float8 AS qty,price_usd::float8 AS price_usd,total_usd::float8 AS total_usd FROM export_purchase_lines WHERE purchase_id=$1 ORDER BY sort", [p.id])).rows;
      return ps;
    });
  }

  /** Формирует заказы поставщикам по расчёту расхода. Пересоздаёт только черновики; если есть отправленные — отказ. */
  @Post("export-orders/:id/purchases/generate") @RequirePermission("exportpurchases.manage")
  generate(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = Gen.parse(body ?? {});
    return this.db.tx(req.user.tenantId, async (c) => {
      const o = (await c.query("SELECT number FROM export_orders WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!o) throw new NotFoundException();
      const busy = (await c.query("SELECT count(*)::int AS n FROM export_purchases WHERE order_id=$1 AND status<>'draft'", [id])).rows[0].n;
      if (busy) throw new ConflictException("Есть заказы поставщикам, уже отправленные или обработанные — пересоздать нельзя");
      const cons = await computeConsumption(c, id);
      if (!cons || !cons.models.length) throw new BadRequestException("В заказе нет моделей");
      const acc = (await c.query("SELECT code,name FROM export_accessories")).rows as { code: string; name: string }[];
      const names = Object.fromEntries(acc.map((a) => [a.code, a.name]));
      const fl = fabricLines(cons.fabrics.map((f: any) => ({ fabricId: f.fabricId, name: f.name, kgOrder: f.kgOrder, priceUsdKg: f.priceUsdKg })));
      const tl = trimLines(cons.trims as any, names, cons.accPrices as Record<string, number>);
      if (!fl.length && !tl.length) throw new BadRequestException("Расход не рассчитан: назначьте полотна и расход моделям");
      await c.query("DELETE FROM export_purchases WHERE order_id=$1 AND status='draft'", [id]);
      const made: { kind: string; number: string; lines: number; totalUsd: number }[] = [];
      for (const [kind, supplier, lines, suffix] of [["fabric", d.fabricSupplier, fl, "F"], ["trims", d.trimsSupplier, tl, "T"]] as [string, string, PLine[], string][]) {
        if (!lines.length) continue;
        const number = `PO-${o.number}-${suffix}`;
        const total = sumLines(lines);
        const pid = (await c.query(
          `INSERT INTO export_purchases (tenant_id,order_id,number,kind,supplier,total_usd,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (tenant_id, number) DO UPDATE SET supplier=EXCLUDED.supplier RETURNING id`,
          [req.user.tenantId, id, number, kind, supplier, total, req.user.id])).rows[0].id;
        for (const [i, l] of lines.entries())
          await c.query(
            `INSERT INTO export_purchase_lines (tenant_id,purchase_id,item_code,name,unit,qty,price_usd,total_usd,sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [req.user.tenantId, pid, l.itemCode, l.name, l.unit, l.qty, l.priceUsd, lineTotal(l.qty, l.priceUsd), i]);
        made.push({ kind, number, lines: lines.length, totalUsd: total });
      }
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "export_order", entityId: id, action: "purchases_generate", after: { made }, ip: req.ip });
      await publish(c, req.user.tenantId, { channel: "export_orders", kind: "updated", entity: "export_order", entityId: id, actorId: req.user.id });
      return { made, warnings: cons.warnings };
    });
  }

  @Patch("export-purchases/:id/status") @RequirePermission("exportpurchases.manage")
  setStatus(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = Status.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const p = (await c.query("SELECT * FROM export_purchases WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!p) throw new NotFoundException();
      if (p.version !== d.version) throw new ConflictException("Заказ изменён другим пользователем — обновите страницу");
      if (!canMove(p.status as PStatus, d.status)) throw new BadRequestException(`Нельзя перевести из «${p.status}» в «${d.status}»`);
      await c.query(
        `UPDATE export_purchases SET status=$2,
           sent_at = CASE WHEN $2='sent' THEN now() ELSE sent_at END,
           confirmed_at = CASE WHEN $2='confirmed' THEN now() ELSE confirmed_at END,
           received_at = CASE WHEN $2='received' THEN now() ELSE received_at END,
           expected_date = CASE WHEN $3::date IS NOT NULL THEN $3::date ELSE expected_date END,
           payment_note = COALESCE($4, payment_note), note = COALESCE($5, note), version=version+1 WHERE id=$1`,
        [id, d.status, d.expectedDate ?? null, d.paymentNote ?? null, d.note ?? null]);
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "export_purchase", entityId: id, action: "status_" + d.status, before: { status: p.status }, after: d, ip: req.ip });
      await publish(c, req.user.tenantId, { channel: "export_orders", kind: "updated", entity: "export_order", entityId: p.order_id, actorId: req.user.id });
      return { ok: true };
    });
  }

  /** Правка количества и цены строки — пока заказ поставщику черновик или отправлен. */
  @Patch("export-purchase-lines/:id") @RequirePermission("exportpurchases.manage")
  editLine(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = LinePatch.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const l = (await c.query(
        `SELECT l.*, p.status, p.order_id FROM export_purchase_lines l JOIN export_purchases p ON p.id=l.purchase_id WHERE l.id=$1 FOR UPDATE OF l`, [id])).rows[0];
      if (!l) throw new NotFoundException();
      if (!["draft", "sent"].includes(l.status)) throw new BadRequestException("Заказ поставщику уже подтверждён — строки менять нельзя");
      const qty = d.qty ?? Number(l.qty), price = d.priceUsd ?? Number(l.price_usd);
      await c.query("UPDATE export_purchase_lines SET qty=$2, price_usd=$3, total_usd=$4 WHERE id=$1", [id, qty, price, lineTotal(qty, price)]);
      await c.query("UPDATE export_purchases SET total_usd=(SELECT COALESCE(sum(total_usd),0) FROM export_purchase_lines WHERE purchase_id=$1), version=version+1 WHERE id=$1", [l.purchase_id]);
      await publish(c, req.user.tenantId, { channel: "export_orders", kind: "updated", entity: "export_order", entityId: l.order_id, actorId: req.user.id });
      return { ok: true };
    });
  }
}
