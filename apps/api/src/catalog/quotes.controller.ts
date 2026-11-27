import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req } from "@nestjs/common";
import { z } from "zod";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { RequirePermission } from "../rbac/rbac.ts";
import { R, ownerClause, addInteraction } from "../crm/common.ts";

const Quote = z.object({
  clientId: z.string().uuid(), dealId: z.string().uuid().optional(), currency: z.enum(["UZS", "USD"]),
  discountPercent: z.number().min(0).max(100).default(0), validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  lines: z.array(z.object({ variantId: z.string().uuid(), qty: z.number().int().positive() })).min(1),
});

@Controller("quotes")
export class QuotesController {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}

  @Get() @RequirePermission("quotes.view")
  list(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const own = ownerClause(req.user, "quotes.view", "q.owner_id", 1);
      return (await c.query(
        `SELECT q.id,q.number,q.status,q.currency,q.total::float8 AS total,q.created_at,cl.id AS client_id,cl.name AS client_name
           FROM quotes q JOIN clients cl ON cl.id=q.client_id WHERE true${own.sql} ORDER BY q.created_at DESC LIMIT 300`, own.params)).rows;
    });
  }

  @Get(":id") @RequirePermission("quotes.view")
  one(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const own = ownerClause(req.user, "quotes.view", "q.owner_id", 2);
      const quote = (await c.query(
        `SELECT q.id,q.number,q.status,q.currency,q.discount_percent::float8 AS discount_percent,q.total::float8 AS total,q.valid_until::text,q.created_at,
                cl.id AS client_id,cl.name AS client_name,cl.address,cl.tax_id,u.full_name AS owner_name
           FROM quotes q JOIN clients cl ON cl.id=q.client_id LEFT JOIN users u ON u.id=q.owner_id WHERE q.id=$1${own.sql}`, [id, ...own.params])).rows[0];
      if (!quote) throw new NotFoundException();
      const lines = (await c.query(
        `SELECT l.qty,l.unit_price::float8 AS unit_price,v.sku,s.label AS size,col.name_ru AS color,m.name AS model,m.code AS model_code
           FROM quote_lines l JOIN variants v ON v.id=l.variant_id JOIN sizes s ON s.id=v.size_id
           JOIN colors col ON col.id=v.color_id JOIN models m ON m.id=v.model_id
          WHERE l.quote_id=$1 ORDER BY m.code,col.name_ru,s.sort`, [id])).rows;
      return { quote, lines };
    });
  }

  /**
   * Цена берётся из активного прайс-листа с типом цены клиента и валютой КП и фиксируется в строке.
   * Наличие на складе в строке появится вместе со складом (этап 4).
   */
  @Post() @RequirePermission("quotes.create")
  create(@Req() req: R, @Body() body: unknown) {
    const d = Quote.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      // Менеджеру с правом «только свои» доступны КП только на своих клиентов.
      const own = ownerClause(req.user, "clients.view", "owner_id", 2);
      const client = (await c.query(`SELECT id,price_type,owner_id FROM clients WHERE id=$1 AND deleted_at IS NULL${own.sql}`, [d.clientId, ...own.params])).rows[0];
      if (!client) throw new BadRequestException("Клиент не найден");
      const variants = (await c.query(
        `SELECT v.id,v.model_id,m.name AS model,p.amount::float8 AS price
           FROM variants v JOIN models m ON m.id=v.model_id
           LEFT JOIN (SELECT p.model_id,p.amount FROM prices p JOIN price_lists pl ON pl.id=p.price_list_id
                       WHERE pl.is_active AND pl.price_type=$2 AND pl.currency=$3) p ON p.model_id=v.model_id
          WHERE v.id = ANY($1::uuid[]) AND v.is_active`, [d.lines.map((l) => l.variantId), client.price_type, d.currency])).rows;
      const byId = new Map(variants.map((v) => [v.id as string, v]));
      let sum = 0;
      const prepared = d.lines.map((l) => {
        const v = byId.get(l.variantId);
        if (!v) throw new BadRequestException("Вариант не найден или отключён");
        if (v.price === null) throw new BadRequestException(`Нет цены для модели «${v.model}» (${client.price_type}, ${d.currency})`);
        sum += l.qty * v.price;
        return { ...l, price: v.price as number };
      });
      const total = Math.round(sum * (1 - d.discountPercent / 100));
      // Нумерация без пропусков и дублей: блокировка на фабрику в рамках транзакции.
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`quote:${req.user.tenantId}`]);
      const year = new Date().getFullYear();
      const n = (await c.query("SELECT count(*)::int + 1 AS n FROM quotes WHERE number LIKE $1", [`Q-${year}-%`])).rows[0].n;
      const number = `Q-${year}-${String(n).padStart(4, "0")}`;
      const id = (await c.query(
        `INSERT INTO quotes (tenant_id,number,client_id,deal_id,currency,discount_percent,valid_until,total,owner_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [req.user.tenantId, number, d.clientId, d.dealId ?? null, d.currency, d.discountPercent, d.validUntil ?? null, total, req.user.id])).rows[0].id;
      for (const l of prepared)
        await c.query("INSERT INTO quote_lines (tenant_id,quote_id,variant_id,qty,unit_price) VALUES ($1,$2,$3,$4,$5)",
          [req.user.tenantId, id, l.variantId, l.qty, l.price]);
      await addInteraction(c, req.user.tenantId, "client", d.clientId, "system", `Создано КП ${number}`, req.user.id);
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "quote", entityId: id, action: "create",
        after: { number, total, lines: prepared.length }, ip: req.ip });
      return { id, number, total };
    });
  }

  @Patch(":id/status") @RequirePermission("quotes.edit")
  status(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = z.object({ status: z.enum(["draft", "sent", "accepted", "rejected"]) }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const own = ownerClause(req.user, "quotes.edit", "owner_id", 3);
      const r = await c.query(`UPDATE quotes SET status=$2 WHERE id=$1${own.sql}`, [id, d.status, ...own.params]);
      if (!r.rowCount) throw new NotFoundException();
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "quote", entityId: id, action: "status", after: d, ip: req.ip });
      return { updated: true };
    });
  }
}
