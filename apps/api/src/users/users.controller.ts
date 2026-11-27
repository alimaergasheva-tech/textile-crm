import { Body, Controller, Delete, ForbiddenException, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req } from "@nestjs/common";
import argon2 from "argon2";
import { z } from "zod";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { AuthUser, RequirePermission } from "../rbac/rbac.ts";

type R = { user: AuthUser; ip?: string };
const Create = z.object({
  email: z.string().email(), fullName: z.string().min(1), password: z.string().min(8),
  locale: z.enum(["ru", "uz", "en", "tr"]).default("ru"), roleIds: z.array(z.string().uuid()).default([]),
});
const Update = z.object({
  fullName: z.string().min(1).optional(), locale: z.enum(["ru", "uz", "en", "tr"]).optional(),
  isActive: z.boolean().optional(), roleIds: z.array(z.string().uuid()).optional(),
  password: z.string().min(8).optional(),
});

@Controller("users")
export class UsersController {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}

  @Get() @RequirePermission("users.view")
  list(@Req() req: R, @Query("page") page = "1", @Query("limit") limit = "50") {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const off = (Math.max(Number(page) || 1, 1) - 1) * lim;
    return this.db.tx(req.user.tenantId, async (c) => {
      const rows = (await c.query(
        `SELECT u.id,u.email,u.full_name,u.locale,u.is_active,
                COALESCE(array_agg(ur.role_id) FILTER (WHERE ur.role_id IS NOT NULL),'{}') AS role_ids
           FROM users u LEFT JOIN user_roles ur ON ur.user_id=u.id
          WHERE u.deleted_at IS NULL GROUP BY u.id ORDER BY u.full_name LIMIT $1 OFFSET $2`, [lim, off])).rows;
      const total = (await c.query("SELECT count(*)::int n FROM users WHERE deleted_at IS NULL")).rows[0].n;
      return { items: rows, total };
    });
  }

  @Post() @RequirePermission("users.create")
  async create(@Req() req: R, @Body() body: unknown) {
    const d = Create.parse(body);
    const hash = await argon2.hash(d.password);
    return this.db.tx(req.user.tenantId, async (c) => {
      const lim = (await c.query(
        `SELECT t.max_users, (SELECT count(*) FROM users WHERE is_active AND deleted_at IS NULL)::int AS n FROM tenants t WHERE t.id=$1`,
        [req.user.tenantId])).rows[0];
      if (lim && lim.n >= lim.max_users) throw new ForbiddenException(`Лимит тарифа: не более ${lim.max_users} пользователей`);
      const id = (await c.query(
        `INSERT INTO users (tenant_id,email,full_name,password_hash,locale) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [req.user.tenantId, d.email, d.fullName, hash, d.locale])).rows[0].id;
      for (const rid of d.roleIds)
        await c.query("INSERT INTO user_roles (tenant_id,user_id,role_id) VALUES ($1,$2,$3)", [req.user.tenantId, id, rid]);
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "user", entityId: id,
        action: "create", after: { email: d.email, fullName: d.fullName, roleIds: d.roleIds }, ip: req.ip });
      return { id };
    });
  }

  @Patch(":id") @RequirePermission("users.edit")
  async update(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = Update.parse(body);
    const hash = d.password ? await argon2.hash(d.password) : null;
    return this.db.tx(req.user.tenantId, async (c) => {
      const before = (await c.query(
        "SELECT full_name,locale,is_active FROM users WHERE id=$1 AND deleted_at IS NULL", [id])).rows[0];
      if (!before) return { updated: false };
      await c.query(
        `UPDATE users SET full_name=COALESCE($2,full_name), locale=COALESCE($3,locale),
                is_active=COALESCE($4,is_active), password_hash=COALESCE($5,password_hash) WHERE id=$1`,
        [id, d.fullName ?? null, d.locale ?? null, d.isActive ?? null, hash]);
      if (d.roleIds) {
        await c.query("DELETE FROM user_roles WHERE user_id=$1", [id]);
        for (const rid of d.roleIds)
          await c.query("INSERT INTO user_roles (tenant_id,user_id,role_id) VALUES ($1,$2,$3)", [req.user.tenantId, id, rid]);
      }
      // Пароль в журнал не пишем.
      const { password: _p, ...after } = d;
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "user", entityId: id,
        action: "update", before, after: { ...after, passwordChanged: !!d.password }, ip: req.ip });
      return { updated: true };
    });
  }

  /** Мягкое удаление: пользователь деактивируется, история сохраняется. */
  @Delete(":id") @RequirePermission("users.delete")
  remove(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const r = await c.query("UPDATE users SET deleted_at=now(), is_active=false WHERE id=$1 AND deleted_at IS NULL", [id]);
      await c.query("UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [id]);
      if (r.rowCount) await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id,
        entity: "user", entityId: id, action: "delete", ip: req.ip });
      return { deleted: !!r.rowCount };
    });
  }
}
