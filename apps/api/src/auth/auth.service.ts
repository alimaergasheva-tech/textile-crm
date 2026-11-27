import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import argon2 from "argon2";
import { createHash, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "../config.ts";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { verifyInitData } from "../miniapp/telegram.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

@Injectable()
export class AuthService {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}

  private access(userId: string, tenantId: string) {
    return jwt.sign({ sub: userId, tid: tenantId }, config.jwtSecret(), { expiresIn: config.accessTtlSec });
  }

  private async newRefresh(c: import("pg").PoolClient, userId: string, tenantId: string) {
    const token = `${tenantId}.${randomBytes(32).toString("base64url")}`;
    await c.query(
      `INSERT INTO refresh_tokens (tenant_id,user_id,token_hash,expires_at)
       VALUES ($1,$2,$3, now() + ($4 || ' days')::interval)`,
      [tenantId, userId, sha(token), String(config.refreshTtlDays)],
    );
    return token;
  }

  async login(tenantSlug: string, email: string, password: string, ip?: string) {
    const t = await this.db.pool.query("SELECT id, status FROM tenants WHERE slug=$1", [tenantSlug]);
    const tenant = t.rows[0];
    // Одинаковая ошибка для всех случаев, чтобы не подсказывать, что именно неверно.
    const fail = new UnauthorizedException("Неверные данные для входа");
    if (!tenant || tenant.status !== "active") throw fail;

    return this.db.tx(tenant.id, async (c) => {
      const u = (await c.query(
        "SELECT id, password_hash, is_active, deleted_at FROM users WHERE lower(email)=lower($1)", [email])).rows[0];
      const ok = u?.password_hash && u.is_active && !u.deleted_at && (await argon2.verify(u.password_hash, password));
      if (!ok) {
        await this.audit.log(c, { tenantId: tenant.id, entity: "auth", action: "login_failed", after: { email }, ip });
        throw fail;
      }
      await this.audit.log(c, { tenantId: tenant.id, userId: u.id, entity: "auth", action: "login", ip });
      return { accessToken: this.access(u.id, tenant.id), refreshToken: await this.newRefresh(c, u.id, tenant.id) };
    });
  }

  /** Ротация: старый refresh отзывается, выдаётся новая пара. */
  async refresh(token: string) {
    const tenantId = token.split(".")[0];
    if (!/^[0-9a-f-]{36}$/.test(tenantId)) throw new UnauthorizedException();
    return this.db.tx(tenantId, async (c) => {
      const r = (await c.query(
        `UPDATE refresh_tokens SET revoked_at = now()
          WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > now() RETURNING user_id`, [sha(token)])).rows[0];
      if (!r) throw new UnauthorizedException();
      return { accessToken: this.access(r.user_id, tenantId), refreshToken: await this.newRefresh(c, r.user_id, tenantId) };
    });
  }

  async logout(token: string | undefined) {
    if (!token) return;
    const tenantId = token.split(".")[0];
    if (!/^[0-9a-f-]{36}$/.test(tenantId)) return;
    await this.db.tx(tenantId, (c) =>
      c.query("UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash=$1", [sha(token)]));
  }

  private async tenantBySlug(slug: string) {
    const t = (await this.db.pool.query("SELECT id, status FROM tenants WHERE slug=$1", [slug])).rows[0];
    if (!t || t.status !== "active") throw new UnauthorizedException();
    return t as { id: string };
  }

  /** Вход из Mini App: подпись Telegram + привязанный пользователь. Выдаётся только access-токен (обновление — повторным входом). */
  async telegramLogin(tenantSlug: string, initData: string, ip?: string) {
    const tg = verifyInitData(initData, config.botToken());
    const tenant = await this.tenantBySlug(tenantSlug);
    return this.db.tx(tenant.id, async (c) => {
      const u = (await c.query("SELECT id,is_active,deleted_at FROM users WHERE telegram_id=$1", [tg.user.id])).rows[0];
      if (!u || !u.is_active || u.deleted_at) throw new UnauthorizedException("Аккаунт не привязан");
      await this.audit.log(c, { tenantId: tenant.id, userId: u.id, entity: "auth", action: "telegram_login", ip });
      return { accessToken: this.access(u.id, tenant.id) };
    });
  }

  /** Привязка Telegram к сотруднику по одноразовой ссылке-приглашению. */
  async telegramLink(tenantSlug: string, initData: string, token: string, ip?: string) {
    const tg = verifyInitData(initData, config.botToken());
    const tenant = await this.tenantBySlug(tenantSlug);
    return this.db.tx(tenant.id, async (c) => {
      const inv = (await c.query(
        "UPDATE telegram_invites SET used_at=now() WHERE token=$1 AND used_at IS NULL AND expires_at > now() RETURNING user_id", [token])).rows[0];
      if (!inv) throw new UnauthorizedException("Приглашение недействительно или уже использовано");
      if ((await c.query("SELECT 1 FROM users WHERE telegram_id=$1 AND id<>$2", [tg.user.id, inv.user_id])).rowCount)
        throw new UnauthorizedException("Этот Telegram уже привязан к другому сотруднику");
      await c.query("UPDATE users SET telegram_id=$2 WHERE id=$1", [inv.user_id, tg.user.id]);
      await this.audit.log(c, { tenantId: tenant.id, userId: inv.user_id, entity: "user", entityId: inv.user_id, action: "telegram_link", ip });
      return { accessToken: this.access(inv.user_id, tenant.id) };
    });
  }
}
