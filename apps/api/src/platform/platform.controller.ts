import { Body, ConflictException, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req, UnauthorizedException, OnModuleDestroy } from "@nestjs/common";
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { config } from "../config.ts";
import { Public } from "../rbac/rbac.ts";
import { provisionTenant } from "../tenants/provision.ts";

type R = { headers: Record<string, string | undefined>; ip?: string };
const Create = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,30}$/, "slug: латиница, цифры, дефис"),
  name: z.string().min(1), ownerEmail: z.string().email(), ownerName: z.string().min(1).default("Директор"),
  plan: z.string().default("start"), maxUsers: z.number().int().positive().default(10), maxStorageMb: z.number().int().positive().default(1024),
});
const Patch_ = z.object({
  plan: z.string().optional(), maxUsers: z.number().int().positive().optional(),
  maxStorageMb: z.number().int().positive().optional(), paidUntil: z.string().date().nullable().optional(),
});

/**
 * Панель владельца платформы (SAAS-2, SAAS-3, SAAS-4). Работает под ролью администратора БД (минует RLS),
 * с отдельными токенами. Каждое действие, включая вход от имени фабрики, пишется в platform_audit.
 */
@Controller("platform")
export class PlatformController implements OnModuleDestroy {
  private _pool?: pg.Pool;
  private get pool() { return (this._pool ??= new pg.Pool({ connectionString: config.platformDatabaseUrl() })); }
  onModuleDestroy() { return this._pool?.end(); }

  private admin(req: R): string {
    const h = String(req.headers.authorization ?? "");
    if (!h.startsWith("Bearer ")) throw new UnauthorizedException();
    try {
      const p = jwt.verify(h.slice(7), config.platformSecret()) as { adm: string };
      return p.adm;
    } catch { throw new UnauthorizedException(); }
  }
  private async log(adm: string, tenantId: string | null, action: string, details?: unknown) {
    await this.pool.query("INSERT INTO platform_audit (admin_id,tenant_id,action,details) VALUES ($1,$2,$3,$4)",
      [adm, tenantId, action, details ? JSON.stringify(details) : null]);
  }

  @Public() @Post("login")
  async login(@Body() body: unknown) {
    const d = z.object({ email: z.string().email(), password: z.string() }).parse(body);
    const a = (await this.pool.query("SELECT id,password_hash FROM platform_admins WHERE lower(email)=lower($1)", [d.email])).rows[0];
    if (!a || !(await argon2.verify(a.password_hash, d.password))) throw new UnauthorizedException("Неверные данные для входа");
    await this.log(a.id, null, "login");
    return { token: jwt.sign({ adm: a.id }, config.platformSecret(), { expiresIn: "8h" }) };
  }

  @Public() @Get("tenants")
  async list(@Req() req: R) {
    this.admin(req);
    return (await this.pool.query(`
      SELECT t.id, t.slug, t.name, t.status, t.plan, t.max_users, t.max_storage_mb, t.paid_until, t.blocked_reason, t.created_at,
        (SELECT count(*)::int FROM users u WHERE u.tenant_id=t.id AND u.is_active AND u.deleted_at IS NULL) AS users,
        (SELECT coalesce(sum(size_bytes),0)::float8/1048576 FROM files f WHERE f.tenant_id=t.id) AS storage_mb,
        (SELECT count(*)::int FROM orders o WHERE o.tenant_id=t.id AND o.created_at > now() - interval '30 days') AS orders_30d,
        (SELECT max(created_at) FROM audit_log a WHERE a.tenant_id=t.id) AS last_activity
      FROM tenants t ORDER BY t.created_at`)).rows;
  }

  /** Новая фабрика без разработчика: роли, воронка, склады, справочники по шаблону + директор с временным паролем. */
  @Public() @Post("tenants")
  async create(@Req() req: R, @Body() body: unknown) {
    const adm = this.admin(req);
    const d = Create.parse(body);
    const password = randomBytes(9).toString("base64url");
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const tid = await provisionTenant(c, d.slug, d.name);
      await c.query("UPDATE tenants SET plan=$2,max_users=$3,max_storage_mb=$4 WHERE id=$1", [tid, d.plan, d.maxUsers, d.maxStorageMb]);
      const uid = (await c.query("INSERT INTO users (tenant_id,email,full_name,password_hash) VALUES ($1,$2,$3,$4) RETURNING id",
        [tid, d.ownerEmail, d.ownerName, await argon2.hash(password)])).rows[0].id;
      await c.query("INSERT INTO user_roles (tenant_id,user_id,role_id) SELECT $1,$2,id FROM roles WHERE tenant_id=$1 AND code='owner'", [tid, uid]);
      await c.query("INSERT INTO platform_audit (admin_id,tenant_id,action,details) VALUES ($1,$2,'tenant_create',$3)",
        [adm, tid, JSON.stringify({ slug: d.slug, plan: d.plan })]);
      await c.query("COMMIT");
      return { id: tid, slug: d.slug, ownerEmail: d.ownerEmail, tempPassword: password };
    } catch (e) {
      await c.query("ROLLBACK");
      if ((e as { code?: string }).code === "23505") throw new ConflictException("Фабрика с таким кодом уже есть");
      throw e;
    } finally { c.release(); }
  }

  @Public() @Patch("tenants/:id")
  async update(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const adm = this.admin(req);
    const d = Patch_.parse(body);
    await this.pool.query(
      `UPDATE tenants SET plan=coalesce($2,plan), max_users=coalesce($3,max_users), max_storage_mb=coalesce($4,max_storage_mb),
         paid_until = CASE WHEN $5::boolean THEN $6::date ELSE paid_until END WHERE id=$1`,
      [id, d.plan ?? null, d.maxUsers ?? null, d.maxStorageMb ?? null, d.paidUntil !== undefined, d.paidUntil ?? null]);
    await this.log(adm, id, "tenant_update", d);
    return { ok: true };
  }

  @Public() @Post("tenants/:id/block")
  async block(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const adm = this.admin(req);
    const { reason } = z.object({ reason: z.string().default("не оплачен тариф") }).parse(body ?? {});
    await this.pool.query("UPDATE tenants SET status='blocked', blocked_reason=$2 WHERE id=$1", [id, reason]);
    await this.log(adm, id, "tenant_block", { reason });
    return { ok: true };
  }

  @Public() @Post("tenants/:id/unblock")
  async unblock(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    const adm = this.admin(req);
    await this.pool.query("UPDATE tenants SET status='active', blocked_reason=NULL WHERE id=$1", [id]);
    await this.log(adm, id, "tenant_unblock");
    return { ok: true };
  }

  /** Вход для поддержки: короткий токен (30 мин) от имени директора фабрики. Пишется в оба журнала. */
  @Public() @Post("tenants/:id/support-token")
  async support(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    const adm = this.admin(req);
    const u = (await this.pool.query(
      `SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id
        WHERE u.tenant_id=$1 AND r.code='owner' AND u.is_active AND u.deleted_at IS NULL ORDER BY u.created_at LIMIT 1`, [id])).rows[0];
    if (!u) throw new UnauthorizedException("У фабрики нет активного директора");
    await this.log(adm, id, "support_login", { userId: u.id });
    await this.pool.query("INSERT INTO audit_log (tenant_id,user_id,entity,action,after,ip) VALUES ($1,$2,'auth','support_login',$3,$4)",
      [id, u.id, JSON.stringify({ platformAdmin: adm }), req.ip ?? null]);
    return { token: jwt.sign({ sub: u.id, tid: id, sup: adm }, config.jwtSecret(), { expiresIn: 30 * 60 }) };
  }

  @Public() @Get("audit")
  async audit(@Req() req: R, @Query("tenant") tenant?: string) {
    this.admin(req);
    return (await this.pool.query(
      `SELECT a.id, a.action, a.details, a.created_at, p.email AS admin, t.slug AS tenant
         FROM platform_audit a LEFT JOIN platform_admins p ON p.id=a.admin_id LEFT JOIN tenants t ON t.id=a.tenant_id
        WHERE ($1::text IS NULL OR t.slug=$1) ORDER BY a.id DESC LIMIT 200`, [tenant ?? null])).rows;
  }
}
