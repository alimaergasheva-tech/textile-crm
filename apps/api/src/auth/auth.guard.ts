import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import jwt from "jsonwebtoken";
import { config } from "../config.ts";
import { DbService } from "../db/db.service.ts";
import { AuthUser, PERMISSION_KEY } from "../rbac/rbac.ts";

/** Один глобальный охранник: проверяет токен, загружает права, проверяет @RequirePermission. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(Reflector) private reflector: Reflector, @Inject(DbService) private db: DbService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const h = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>("public", h)) return true;

    const req = ctx.switchToHttp().getRequest();
    const bearer = String(req.headers.authorization ?? "");
    if (!bearer.startsWith("Bearer ")) throw new UnauthorizedException();
    let payload: { sub: string; tid: string };
    try {
      payload = jwt.verify(bearer.slice(7), config.jwtSecret()) as typeof payload;
    } catch {
      throw new UnauthorizedException();
    }

    const perms = await this.db.tx(payload.tid, async (c) => {
      const t = await c.query("SELECT status FROM tenants WHERE id=$1", [payload.tid]);
      if (t.rows[0]?.status !== "active") return null;
      const u = await c.query("SELECT is_active, deleted_at FROM users WHERE id=$1", [payload.sub]);
      if (!u.rows[0] || !u.rows[0].is_active || u.rows[0].deleted_at) return null;
      const r = await c.query(
        `SELECT rp.permission_code, bool_and(rp.own_only) AS own_only
           FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
          WHERE ur.user_id = $1 GROUP BY rp.permission_code`,
        [payload.sub],
      );
      return new Map<string, boolean>(r.rows.map((x) => [x.permission_code, x.own_only]));
    });
    if (!perms) throw new UnauthorizedException();

    const user: AuthUser = { id: payload.sub, tenantId: payload.tid, perms };
    req.user = user;

    const need = this.reflector.getAllAndOverride<string | undefined>(PERMISSION_KEY, h);
    if (need && !perms.has(need)) throw new ForbiddenException(`Нет права ${need}`);
    return true;
  }
}
