import { Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { RequirePermission, isOwnOnly } from "../rbac/rbac.ts";
import { publish } from "../realtime/realtime.ts";
import { R } from "./common.ts";

const STATUS = ["todo", "in_progress", "blocked", "done"] as const;
const Task = z.object({ title: z.string().min(1), dueAt: z.string().datetime({ offset: true }).optional(),
  assigneeId: z.string().uuid().optional(), departmentId: z.string().uuid().optional(),
  entity: z.enum(["client", "deal", "lead", "export_order"]).optional(), entityId: z.string().uuid().optional() });
const TaskPatch = z.object({
  /** Версия, которую видел пользователь; если запись уже изменили, вернём 409 вместо тихой перезаписи. */
  version: z.number().int().min(1).optional(),
  title: z.string().min(1).optional(), dueAt: z.string().datetime({ offset: true }).optional(),
  assigneeId: z.string().uuid().optional(), departmentId: z.string().uuid().nullable().optional(),
  status: z.enum(STATUS).optional(), blockedReason: z.string().max(500).nullable().optional(),
  done: z.boolean().optional(),
});

/** «Только свои» для задач: назначенные мне, созданные мной и задачи моих отделов. */
const VISIBLE = `(NOT $1 OR t.assignee_id=$2 OR t.created_by=$2
  OR t.department_id IN (SELECT department_id FROM user_departments WHERE user_id=$2))`;

@Controller("tasks")
export class TasksController {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}

  /**
   * Список задач. Фильтры: done=0|1, entity/entityId, mine=1 («Мои задачи»),
   * department=<id> («Задачи отдела»), status=todo|in_progress|blocked|done, overdue=1.
   */
  @Get() @RequirePermission("tasks.view")
  list(@Req() req: R, @Query("done") done?: string, @Query("entity") entity?: string, @Query("entityId") entityId?: string,
       @Query("mine") mine?: string, @Query("department") department?: string, @Query("status") status?: string,
       @Query("overdue") overdue?: string) {
    if (department && !z.string().uuid().safeParse(department).success) throw new NotFoundException();
    return this.db.tx(req.user.tenantId, async (c) => {
      const own = isOwnOnly(req.user, "tasks.view");
      return (await c.query(
        `SELECT t.id,t.title,t.due_at,t.assignee_id,t.entity,t.entity_id,t.done_at,t.version,t.status,t.blocked_reason,t.department_id,
                u.full_name AS assignee_name, d.name AS department_name,
                (t.done_at IS NULL AND t.due_at IS NOT NULL AND t.due_at < now()) AS is_overdue,
                GREATEST(0, floor(extract(epoch FROM (now() - t.due_at)) / 86400))::int AS delay_days
           FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id LEFT JOIN departments d ON d.id=t.department_id
          WHERE ${VISIBLE}
            AND ($3::text IS NULL OR ($3='1') = (t.done_at IS NOT NULL))
            AND ($4::text IS NULL OR t.entity=$4) AND ($5::uuid IS NULL OR t.entity_id=$5)
            AND (($6::text IS NULL) OR t.assignee_id=$2)
            AND ($7::uuid IS NULL OR t.department_id=$7)
            AND ($8::text IS NULL OR t.status=$8)
            AND ($9::text IS NULL OR (t.done_at IS NULL AND t.due_at < now()))
          ORDER BY t.done_at NULLS FIRST, t.due_at NULLS LAST LIMIT 500`,
        [own, req.user.id, done ?? null, entity ?? null, entityId ?? null, mine === "1" ? "1" : null, department ?? null, status ?? null, overdue === "1" ? "1" : null])).rows;
    });
  }

  /** Сводка для «Мои задачи» и ленты отдела: сколько просрочено, на сегодня, в работе. */
  @Get("summary") @RequirePermission("tasks.view")
  summary(@Req() req: R, @Query("department") department?: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const own = isOwnOnly(req.user, "tasks.view");
      const r = (await c.query(
        `SELECT count(*) FILTER (WHERE t.done_at IS NULL AND t.due_at < now())::int AS overdue,
                count(*) FILTER (WHERE t.done_at IS NULL AND t.due_at >= now() AND t.due_at < date_trunc('day', now()) + interval '1 day')::int AS today,
                count(*) FILTER (WHERE t.status='in_progress')::int AS in_progress,
                count(*) FILTER (WHERE t.status='blocked')::int AS blocked,
                count(*) FILTER (WHERE t.done_at IS NULL)::int AS open
           FROM tasks t WHERE ${VISIBLE} AND ($3::uuid IS NULL OR t.department_id=$3)`,
        [own, req.user.id, department ?? null])).rows[0];
      return r;
    });
  }

  @Post() @RequirePermission("tasks.create")
  create(@Req() req: R, @Body() body: unknown) {
    const d = Task.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const id = (await c.query(
        `INSERT INTO tasks (tenant_id,title,due_at,assignee_id,created_by,entity,entity_id,department_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [req.user.tenantId, d.title, d.dueAt ?? null, d.assigneeId ?? req.user.id, req.user.id, d.entity ?? null, d.entityId ?? null, d.departmentId ?? null])).rows[0].id;
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "task", entityId: id,
        action: "create", after: d, ip: req.ip });
      await publish(c, req.user.tenantId, { channel: "tasks", kind: "created", entity: "task", entityId: id, actorId: req.user.id,
        payload: { departmentId: d.departmentId ?? null, assigneeId: d.assigneeId ?? req.user.id } });
      return { id, version: 1 };
    });
  }

  @Patch(":id") @RequirePermission("tasks.edit")
  update(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = TaskPatch.parse(body);
    const has = (k: keyof typeof d) => Object.prototype.hasOwnProperty.call(d, k);
    return this.db.tx(req.user.tenantId, async (c) => {
      const own = isOwnOnly(req.user, "tasks.edit");
      // Итоговый статус: явный status, иначе из флага done; выполнено ⇔ done_at заполнен
      const status = d.status ?? (d.done === undefined ? null : d.done ? "done" : "todo");
      const before = (await c.query(
        `SELECT t.title,t.status,t.assignee_id,t.department_id,t.due_at,t.version FROM tasks t
          WHERE t.id=$3 AND ${VISIBLE} FOR UPDATE OF t`, [own, req.user.id, id])).rows[0];
      if (!before) throw new NotFoundException();
      if (d.version !== undefined && d.version !== before.version)
        throw new ConflictException({ message: "Задача уже изменена другим пользователем. Обновите данные и повторите.", currentVersion: before.version });
      await c.query(
        `UPDATE tasks SET title=COALESCE($2,title), due_at=COALESCE($3,due_at), assignee_id=COALESCE($4,assignee_id),
                department_id=CASE WHEN $5 THEN $6::uuid ELSE department_id END,
                status=COALESCE($7,status),
                blocked_reason=CASE WHEN $7 IS NOT NULL AND $7 <> 'blocked' THEN NULL WHEN $8 THEN $9 ELSE blocked_reason END,
                done_at=CASE WHEN $7 IS NULL THEN done_at WHEN $7='done' THEN COALESCE(done_at,now()) ELSE NULL END,
                version=version+1, updated_at=now()
          WHERE id=$1`,
        [id, d.title ?? null, d.dueAt ?? null, d.assigneeId ?? null, has("departmentId"), d.departmentId ?? null,
         status, has("blockedReason"), d.blockedReason ?? null]);
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "task", entityId: id,
        action: "update", before, after: d, ip: req.ip });
      await publish(c, req.user.tenantId, { channel: "tasks", kind: "updated", entity: "task", entityId: id, actorId: req.user.id,
        payload: { status: status ?? before.status, departmentId: has("departmentId") ? d.departmentId ?? null : before.department_id } });
      return { updated: true, version: before.version + 1 };
    });
  }
}
