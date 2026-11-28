import { Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Req } from "@nestjs/common";
import { z } from "zod";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { RequirePermission } from "../rbac/rbac.ts";
import { R } from "../crm/common.ts";
import { publish } from "../realtime/realtime.ts";

const Create = z.object({ code: z.string().regex(/^[a-z0-9_]{2,30}$/), name: z.string().min(1), headUserId: z.string().uuid().nullable().optional(),
  telegramChatId: z.number().int().nullable().optional() });
const Patch_ = z.object({ name: z.string().min(1).optional(), headUserId: z.string().uuid().nullable().optional(),
  telegramChatId: z.number().int().nullable().optional(), isActive: z.boolean().optional() });
const Members = z.object({ userIds: z.array(z.string().uuid()).max(500) });

@Controller("departments")
export class DepartmentsController {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}

  /** Отделы с составом. */
  @Get() @RequirePermission("departments.view")
  list(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT d.id,d.code,d.name,d.head_user_id,d.telegram_chat_id,d.is_active,d.sort,
              COALESCE(array_agg(ud.user_id) FILTER (WHERE ud.user_id IS NOT NULL),'{}') AS member_ids
         FROM departments d LEFT JOIN user_departments ud ON ud.department_id=d.id
        GROUP BY d.id ORDER BY d.sort,d.name`)).rows);
  }

  /** Мои отделы (для фильтров «Задачи отдела» и маршрутизации уведомлений). */
  @Get("mine")
  mine(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT d.id,d.code,d.name FROM departments d JOIN user_departments ud ON ud.department_id=d.id
        WHERE ud.user_id=$1 AND d.is_active ORDER BY d.sort`, [req.user.id])).rows);
  }

  @Post() @RequirePermission("departments.manage")
  create(@Req() req: R, @Body() body: unknown) {
    const d = Create.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const id = (await c.query(
        `INSERT INTO departments (tenant_id,code,name,head_user_id,telegram_chat_id,sort)
         VALUES ($1,$2,$3,$4,$5,(SELECT COALESCE(max(sort),0)+1 FROM departments)) RETURNING id`,
        [req.user.tenantId, d.code, d.name, d.headUserId ?? null, d.telegramChatId ?? null])).rows[0].id;
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "department", entityId: id, action: "create", after: d, ip: req.ip });
      await publish(c, req.user.tenantId, { channel: "departments", kind: "created", entity: "department", entityId: id, actorId: req.user.id });
      return { id };
    });
  }

  @Patch(":id") @RequirePermission("departments.manage")
  update(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = Patch_.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      // null в headUserId/telegramChatId означает «снять», поэтому различаем «не передано» и null
      const has = (k: keyof typeof d) => Object.prototype.hasOwnProperty.call(d, k);
      const r = await c.query(
        `UPDATE departments SET name=COALESCE($2,name),
                head_user_id=CASE WHEN $3 THEN $4::uuid ELSE head_user_id END,
                telegram_chat_id=CASE WHEN $5 THEN $6::bigint ELSE telegram_chat_id END,
                is_active=COALESCE($7,is_active) WHERE id=$1`,
        [id, d.name ?? null, has("headUserId"), d.headUserId ?? null, has("telegramChatId"), d.telegramChatId ?? null, d.isActive ?? null]);
      if (!r.rowCount) throw new NotFoundException();
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "department", entityId: id, action: "update", after: d, ip: req.ip });
      await publish(c, req.user.tenantId, { channel: "departments", kind: "updated", entity: "department", entityId: id, actorId: req.user.id });
      return { updated: true };
    });
  }

  /** Полностью задаёт состав отдела. Сотрудник может быть в нескольких отделах. */
  @Put(":id/members") @RequirePermission("departments.manage")
  setMembers(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = Members.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      if (!(await c.query("SELECT 1 FROM departments WHERE id=$1 FOR UPDATE", [id])).rowCount) throw new NotFoundException();
      const before = (await c.query("SELECT user_id FROM user_departments WHERE department_id=$1", [id])).rows.map((x) => x.user_id);
      await c.query("DELETE FROM user_departments WHERE department_id=$1", [id]);
      // Составной внешний ключ (tenant_id,user_id) не даст добавить пользователя другой фабрики
      if (d.userIds.length)
        await c.query(
          `INSERT INTO user_departments (tenant_id,department_id,user_id)
           SELECT $1,$2,u FROM unnest($3::uuid[]) u ON CONFLICT DO NOTHING`, [req.user.tenantId, id, d.userIds]);
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "department", entityId: id,
        action: "set_members", before: { userIds: before }, after: d, ip: req.ip });
      await publish(c, req.user.tenantId, { channel: "departments", kind: "members", entity: "department", entityId: id, actorId: req.user.id });
      return { members: d.userIds.length };
    });
  }
}
