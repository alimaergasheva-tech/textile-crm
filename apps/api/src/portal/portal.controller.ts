import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Req, UnauthorizedException } from "@nestjs/common";
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import type pg from "pg";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { config } from "../config.ts";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { Public, RequirePermission } from "../rbac/rbac.ts";
import { R } from "../crm/common.ts";
import { verifyInitData } from "../miniapp/telegram.ts";
import { idem, nextNumber, notify } from "../production/flow.ts";

type PR = { headers: Record<string, string | undefined>; ip?: string };
type Acct = { id: string; clientId: string; tenantId: string; name: string };
const uuid = z.string().uuid();
const Items = z.array(z.object({ variantId: uuid, qty: z.number().int().positive().max(100000) })).min(1).max(300);

/**
 * Клиентский портал (экран клиента в Mini App). Клиенты — отдельные аккаунты, не сотрудники: у них свои токены
 * и свои эндпоинты /client/*, каждый запрос ограничен строками именно этого клиента. Заказ клиента остаётся
 * черновиком («заявкой»), пока менеджер не подтвердит его обычным способом (проверка кредитного лимита, резерв).
 */
@Controller()
export class ClientPortalController {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}

  private sign(a: { id: string }, tid: string) { return jwt.sign({ cli: a.id, tid }, config.clientSecret(), { expiresIn: "12h" }); }

  /** Проверяет токен клиента и выполняет fn в транзакции фабрики с загруженным аккаунтом. */
  private async run<T>(req: PR, fn: (c: pg.PoolClient, a: Acct) => Promise<T>): Promise<T> {
    const h = String(req.headers.authorization ?? "");
    if (!h.startsWith("Bearer ")) throw new UnauthorizedException();
    let p: { cli: string; tid: string };
    try { p = jwt.verify(h.slice(7), config.clientSecret()) as typeof p; } catch { throw new UnauthorizedException(); }
    return this.db.tx(p.tid, async (c) => {
      const a = (await c.query(
        `SELECT a.id,a.client_id,a.name FROM client_accounts a JOIN tenants t ON t.id=a.tenant_id WHERE a.id=$1 AND a.is_active AND t.status='active'`, [p.cli])).rows[0];
      if (!a) throw new UnauthorizedException();
      return fn(c, { id: a.id, clientId: a.client_id, tenantId: p.tid, name: a.name });
    });
  }

  private async tenantBySlug(slug: string) {
    const t = (await this.db.pool.query("SELECT id,status FROM tenants WHERE slug=$1", [slug])).rows[0];
    if (!t || t.status !== "active") throw new UnauthorizedException();
    return t as { id: string };
  }

  // ---------- вход ----------
  @Public() @Post("client/auth/telegram") @HttpCode(200)
  async tgLogin(@Body() body: unknown) {
    const d = z.object({ tenant: z.string(), initData: z.string() }).parse(body);
    const tg = verifyInitData(d.initData, config.botToken());
    const t = await this.tenantBySlug(d.tenant);
    const a = await this.db.tx(t.id, async (c) => (await c.query("SELECT id FROM client_accounts WHERE telegram_id=$1 AND is_active", [tg.user.id])).rows[0]);
    if (!a) throw new UnauthorizedException("Аккаунт не привязан");
    return { accessToken: this.sign(a, t.id) };
  }

  @Public() @Post("client/auth/link") @HttpCode(200)
  async tgLink(@Body() body: unknown) {
    const d = z.object({ tenant: z.string(), initData: z.string(), token: z.string() }).parse(body);
    const tg = verifyInitData(d.initData, config.botToken());
    const t = await this.tenantBySlug(d.tenant);
    return this.db.tx(t.id, async (c) => {
      try {
        const a = (await c.query(
          "UPDATE client_accounts SET telegram_id=$2, invite_token=NULL WHERE invite_token=$1 AND invite_expires > now() AND is_active RETURNING id", [d.token, tg.user.id])).rows[0];
        if (!a) throw new UnauthorizedException("Приглашение недействительно или уже использовано");
        return { accessToken: this.sign(a, t.id) };
      } catch (e) {
        if ((e as { code?: string }).code === "23505") throw new UnauthorizedException("Этот Telegram уже привязан к другому аккаунту");
        throw e;
      }
    });
  }

  /** Вход по почте и паролю: для проверки вне Telegram. */
  @Public() @Post("client/auth/login") @HttpCode(200)
  async login(@Body() body: unknown) {
    const d = z.object({ tenant: z.string(), email: z.string(), password: z.string() }).parse(body);
    const t = await this.tenantBySlug(d.tenant).catch(() => { throw new UnauthorizedException("Неверные данные для входа"); });
    const a = await this.db.tx(t.id, async (c) => (await c.query("SELECT id,password_hash FROM client_accounts WHERE lower(email)=lower($1) AND is_active", [d.email])).rows[0]);
    if (!a?.password_hash || !(await argon2.verify(a.password_hash, d.password))) throw new UnauthorizedException("Неверные данные для входа");
    return { accessToken: this.sign(a, t.id) };
  }

  // ---------- управление аккаунтами (сотрудник с правом clients.edit) ----------
  @Get("clients/:id/portal-accounts") @RequirePermission("clients.edit")
  listAccounts(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT id,name,email,is_active,(telegram_id IS NOT NULL) AS linked,(invite_token IS NOT NULL AND invite_expires > now()) AS invite_pending,created_at
         FROM client_accounts WHERE client_id=$1 ORDER BY created_at`, [id])).rows);
  }

  @Post("clients/:id/portal-accounts") @RequirePermission("clients.edit")
  createAccount(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = z.object({ name: z.string().min(1), email: z.string().email().optional(), password: z.string().min(8).optional() }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      if (!(await c.query("SELECT 1 FROM clients WHERE id=$1", [id])).rowCount) throw new NotFoundException();
      const a = (await c.query(
        `INSERT INTO client_accounts (tenant_id,client_id,name,email,password_hash,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [req.user.tenantId, id, d.name, d.email ?? null, d.password ? await argon2.hash(d.password) : null, req.user.id])).rows[0];
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "client_account", entityId: a.id, action: "create", after: { clientId: id, name: d.name }, ip: req.ip });
      return { id: a.id, ...(await this.invite(c, req.user.tenantId, a.id)) };
    });
  }

  @Post("portal-accounts/:accId/invite") @RequirePermission("clients.edit")
  newInvite(@Req() req: R, @Param("accId", ParseUUIDPipe) accId: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      if (!(await c.query("SELECT 1 FROM client_accounts WHERE id=$1", [accId])).rowCount) throw new NotFoundException();
      return this.invite(c, req.user.tenantId, accId);
    });
  }

  @Post("portal-accounts/:accId/deactivate") @RequirePermission("clients.edit")
  deactivate(@Req() req: R, @Param("accId", ParseUUIDPipe) accId: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      await c.query("UPDATE client_accounts SET is_active=false, invite_token=NULL WHERE id=$1", [accId]);
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "client_account", entityId: accId, action: "deactivate", ip: req.ip });
      return { ok: true };
    });
  }

  private async invite(c: pg.PoolClient, tenantId: string, accId: string) {
    const slug = (await c.query("SELECT slug FROM tenants WHERE id=$1", [tenantId])).rows[0].slug as string;
    const token = `${slug.replace(/[^A-Za-z0-9-]/g, "")}_${randomBytes(12).toString("base64url").replace(/[^A-Za-z0-9]/g, "x")}`;
    await c.query("UPDATE client_accounts SET invite_token=$2, invite_expires=now() + interval '7 days' WHERE id=$1", [accId, token]);
    const bot = config.botUsername();
    return { token, link: bot ? `https://t.me/${bot}?startapp=${token}` : null, expires: "7d" };
  }

  // ---------- экран клиента ----------
  @Public() @Get("client/me")
  me(@Req() req: PR) {
    return this.run(req, async (c, a) => ({ name: a.name, client: (await c.query("SELECT name FROM clients WHERE id=$1", [a.clientId])).rows[0].name,
      factory: (await c.query("SELECT name FROM tenants WHERE id=$1", [a.tenantId])).rows[0].name }));
  }

  /** Каталог с ценами по типу цен клиента и наличием (свободный остаток = остаток − резервы). Модели без цены не показываем. */
  @Public() @Get("client/catalog")
  catalog(@Req() req: PR) {
    return this.run(req, async (c, a) => {
      const pt = (await c.query("SELECT price_type FROM clients WHERE id=$1", [a.clientId])).rows[0].price_type;
      const models = (await c.query(
        `SELECT m.id,m.code,m.name,m.category,pr.amount::float8 AS price,pr.currency
           FROM models m
           CROSS JOIN LATERAL (SELECT p.amount,pl.currency FROM prices p JOIN price_lists pl ON pl.id=p.price_list_id
                                WHERE p.model_id=m.id AND pl.price_type=$1 AND pl.is_active ORDER BY pl.name LIMIT 1) pr
          WHERE m.is_active ORDER BY m.code`, [pt])).rows;
      const variants = (await c.query(
        `SELECT v.id,v.model_id,v.sku,s.label AS size,s.sort,col.name_ru AS color_ru,col.name_uz AS color_uz,col.hex,
                GREATEST(0, COALESCE((SELECT sum(sb.qty) FROM stock_balances sb WHERE sb.variant_id=v.id),0)
                          - COALESCE((SELECT sum(r.qty) FROM reservations r WHERE r.variant_id=v.id AND r.status='active'),0))::float8 AS available
           FROM variants v JOIN sizes s ON s.id=v.size_id JOIN colors col ON col.id=v.color_id WHERE v.is_active ORDER BY s.sort,col.name_ru`)).rows;
      return models.map((m) => ({ ...m, variants: variants.filter((v) => v.model_id === m.id) }));
    });
  }

  @Public() @Get("client/orders")
  orders(@Req() req: PR) {
    return this.run(req, async (c, a) => (await c.query(
      `SELECT id,number,status,source,currency,total::float8,paid::float8,discount::float8,due_date::text,created_at FROM orders WHERE client_id=$1 ORDER BY created_at DESC LIMIT 100`, [a.clientId])).rows);
  }

  @Public() @Get("client/orders/:id")
  order(@Req() req: PR, @Param("id", ParseUUIDPipe) id: string) {
    return this.run(req, async (c, a) => {
      const o = (await c.query(
        `SELECT id,number,status,source,currency,total::float8,paid::float8,discount::float8,due_date::text,note,created_at FROM orders WHERE id=$1 AND client_id=$2`, [id, a.clientId])).rows[0];
      if (!o) throw new NotFoundException();
      o.items = (await c.query(
        `SELECT oi.variant_id,oi.qty,oi.shipped,oi.unit_price::float8,mo.code AS model_code,mo.name AS model_name,v.sku,s.label AS size,col.name_ru AS color_ru,col.name_uz AS color_uz
           FROM order_items oi JOIN variants v ON v.id=oi.variant_id JOIN models mo ON mo.id=v.model_id JOIN sizes s ON s.id=v.size_id JOIN colors col ON col.id=v.color_id
          WHERE oi.order_id=$1 ORDER BY mo.code,s.sort`, [id])).rows;
      o.shipments = (await c.query("SELECT number,shipped_at FROM shipments WHERE order_id=$1 AND status='shipped' ORDER BY shipped_at", [id])).rows;
      o.rated = (await c.query("SELECT rating FROM feedback WHERE order_id=$1 AND status='answered' ORDER BY answered_at DESC LIMIT 1", [id])).rows[0]?.rating ?? null;
      o.canRate = !!(await c.query("SELECT 1 FROM feedback WHERE order_id=$1 AND status<>'answered' AND (status='requested' OR EXISTS (SELECT 1 FROM shipments s WHERE s.order_id=$1 AND s.status='shipped'))", [id])).rowCount;
      o.complaints = (await c.query("SELECT number,status,reason_code,created_at FROM complaints WHERE order_id=$1 AND client_id=$2 ORDER BY created_at DESC", [id, a.clientId])).rows;
      return o;
    });
  }

  /** Заявка клиента: цены берутся на сервере из прайса клиента. Повтор с тем же Idempotency-Key не создаёт второй заказ. */
  @Public() @Post("client/orders") @HttpCode(200)
  create(@Req() req: PR, @Body() body: unknown, @Headers("idempotency-key") key?: string) {
    const d = z.object({ items: Items, note: z.string().max(1000).optional(), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(body);
    return this.run(req, (c, a) => idem(c, a.tenantId, a.id, key, () => this.place(c, a, d.items, d.note, d.dueDate)));
  }

  @Public() @Post("client/orders/:id/repeat") @HttpCode(200)
  repeat(@Req() req: PR, @Param("id", ParseUUIDPipe) id: string, @Headers("idempotency-key") key?: string) {
    return this.run(req, (c, a) => idem(c, a.tenantId, a.id, key, async () => {
      const items = (await c.query("SELECT oi.variant_id AS \"variantId\", oi.qty FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.id=$1 AND o.client_id=$2", [id, a.clientId])).rows;
      if (!items.length) throw new NotFoundException();
      return this.place(c, a, items, undefined, undefined);
    }));
  }

  @Public() @Post("client/orders/:id/cancel") @HttpCode(200)
  cancel(@Req() req: PR, @Param("id", ParseUUIDPipe) id: string) {
    return this.run(req, async (c, a) => {
      const r = await c.query("UPDATE orders SET status='cancelled' WHERE id=$1 AND client_id=$2 AND source='client' AND status='draft'", [id, a.clientId]);
      if (!r.rowCount) throw new BadRequestException("Отменить можно только свою заявку, которую ещё не подтвердили");
      return { ok: true };
    });
  }

  @Public() @Post("client/orders/:id/rate") @HttpCode(200)
  rate(@Req() req: PR, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown, @Headers("idempotency-key") key?: string) {
    const d = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().max(2000).optional() }).parse(body);
    return this.run(req, (c, a) => idem(c, a.tenantId, a.id, key, async () => {
      const r = await c.query(
        `UPDATE feedback SET rating=$3, comment=$4, status='answered', answered_at=now()
          WHERE id = (SELECT id FROM feedback WHERE order_id=$1 AND client_id=$2 AND status<>'answered' ORDER BY request_at LIMIT 1)`, [id, a.clientId, d.rating, d.comment ?? null]);
      if (!r.rowCount) throw new BadRequestException("Оценка уже получена или заказ ещё не отгружен");
      return { ok: true };
    }));
  }

  @Public() @Get("client/complaint-reasons")
  reasons(@Req() req: PR) {
    return this.run(req, async (c) => (await c.query("SELECT code,name_ru,name_uz FROM reference_values WHERE dictionary='complaint_reason' AND is_active ORDER BY sort")).rows);
  }

  @Public() @Post("client/complaints") @HttpCode(200)
  complain(@Req() req: PR, @Body() body: unknown, @Headers("idempotency-key") key?: string) {
    const d = z.object({ orderId: uuid, variantId: uuid.optional(), qty: z.number().int().positive().optional(),
      reasonCode: z.string().min(1), description: z.string().min(3).max(4000) }).parse(body);
    return this.run(req, (c, a) => idem(c, a.tenantId, a.id, key, async () => {
      if (!(await c.query("SELECT 1 FROM orders WHERE id=$1 AND client_id=$2", [d.orderId, a.clientId])).rowCount) throw new NotFoundException("Заказ не найден");
      if (d.variantId && !(await c.query("SELECT 1 FROM order_items WHERE order_id=$1 AND variant_id=$2", [d.orderId, d.variantId])).rowCount) throw new BadRequestException("Этого товара нет в заказе");
      const n = Number((await c.query("SELECT count(*)::int n FROM complaints")).rows[0].n) + 1;
      const number = `C-${new Date().getFullYear()}-${String(n).padStart(4, "0")}`;
      const id = (await c.query(
        `INSERT INTO complaints (tenant_id,number,order_id,client_id,variant_id,qty,reason_code,description,due_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + interval '48 hours') RETURNING id`,
        [a.tenantId, number, d.orderId, a.clientId, d.variantId ?? null, d.qty ?? null, d.reasonCode, d.description])).rows[0].id;
      await this.tell(c, a, `Рекламация ${number} от клиента: ${d.description.slice(0, 120)}`, "feedback.manage");
      return { id, number };
    }));
  }

  // ---------- общее ----------
  private async place(c: pg.PoolClient, a: Acct, itemsIn: { variantId: string; qty: number }[], note?: string, dueDate?: string) {
    const client = (await c.query("SELECT name,price_type FROM clients WHERE id=$1", [a.clientId])).rows[0];
    const merged = new Map<string, number>();
    for (const i of itemsIn) merged.set(i.variantId, (merged.get(i.variantId) ?? 0) + i.qty);
    let currency: string | null = null, total = 0;
    const lines: { variantId: string; qty: number; price: number }[] = [];
    for (const [variantId, qty] of merged) {
      const p = (await c.query(
        `SELECT p.amount::float8 AS amount, pl.currency FROM variants v JOIN prices p ON p.model_id=v.model_id JOIN price_lists pl ON pl.id=p.price_list_id
          WHERE v.id=$1 AND v.is_active AND pl.price_type=$2 AND pl.is_active ORDER BY pl.name LIMIT 1`, [variantId, client.price_type])).rows[0];
      if (!p) throw new BadRequestException("Один из товаров недоступен для заказа");
      if (currency && currency !== p.currency) throw new BadRequestException("Цены в разных валютах — оформите заказы отдельно");
      currency = p.currency; total += p.amount * qty; lines.push({ variantId, qty, price: p.amount });
    }
    const number = await nextNumber(c, "orders", "O");
    const id = (await c.query(
      `INSERT INTO orders (tenant_id,number,client_id,currency,total,due_date,note,source,client_account_id) VALUES ($1,$2,$3,$4,$5,$6,$7,'client',$8) RETURNING id`,
      [a.tenantId, number, a.clientId, currency, total, dueDate ?? null, note ?? null, a.id])).rows[0].id;
    for (const l of lines) await c.query("INSERT INTO order_items (tenant_id,order_id,variant_id,qty,unit_price) VALUES ($1,$2,$3,$4,$5)", [a.tenantId, id, l.variantId, l.qty, l.price]);
    await this.tell(c, a, `Новая заявка ${number} от клиента «${client.name}»: ${lines.reduce((s, l) => s + l.qty, 0)} шт. Подтвердите заказ.`, "orders.create");
    return { id, number, status: "draft", total, currency };
  }

  /** Сообщение сотрудникам: ответственному менеджеру клиента, а если его нет — всем с нужным правом (до 5). */
  private async tell(c: pg.PoolClient, a: Acct, text: string, perm: string) {
    const owner = (await c.query("SELECT owner_id FROM clients WHERE id=$1", [a.clientId])).rows[0]?.owner_id as string | null;
    const ids = owner ? [owner] : (await c.query(
      `SELECT DISTINCT ur.user_id FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id JOIN users u ON u.id=ur.user_id
        WHERE rp.permission_code=$1 AND u.is_active AND u.deleted_at IS NULL LIMIT 5`, [perm])).rows.map((r) => r.user_id as string);
    for (const uid of ids) await notify(c, a.tenantId, uid, text);
  }
}
