import { Body, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { RequirePermission, isOwnOnly } from "../rbac/rbac.ts";
import { R } from "./common.ts";

const Task = z.object({ title: z.string().min(1), dueAt: z.string().datetime({ offset: true }).optional(),
  assigneeId: z.string().uuid().optional(), entity: z.enum(["client", "deal", "lead"]).optional(), entityId: z.string().uuid().optional() });

@Controller("tasks")
export class TasksController {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}

  @Get() @RequirePermission("tasks.view")
  list(@Req() req: R, @Query("done") done?: string, @Query("entity") entity?: string, @Query("entityId") entityId?: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const own = isOwnOnly(req.user, "tasks.view");
      return (await c.query(
        `SELECT t.id,t.title,t.due_at,t.assignee_id,t.entity,t.entity_id,t.done_at,u.full_name AS assignee_name
           FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id
          WHERE ($1::text IS NULL OR ($1='1') = (t.done_at IS NOT NULL))
            AND ($2::text IS NULL OR t.entity=$2) AND ($3::uuid IS NULL OR t.entity_id=$3)
            AND (NOT $4 OR t.assignee_id=$5 OR t.created_by=$5)
          ORDER BY t.done_at NULLS FIRST, t.due_at NULLS LAST LIMIT 500`,
        [done ?? null, entity ?? null, entityId ?? null, own, req.user.id])).rows;
    });
  }

  @Post() @RequirePermission("tasks.create")
  create(@Req() req: R, @Body() body: unknown) {
    const d = Task.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const id = (await c.query(
        `INSERT INTO tasks (tenant_id,title,due_at,assignee_id,created_by,entity,entity_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [req.user.tenantId, d.title, d.dueAt ?? null, d.assigneeId ?? req.user.id, req.user.id, d.entity ?? null, d.entityId ?? null])).rows[0].id;
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "task", entityId: id,
        action: "create", after: d, ip: req.ip });
      return { id };
    });
  }

  @Patch(":id") @RequirePermission("tasks.edit")
  update(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = z.object({ done: z.boolean().optional(), title: z.string().min(1).optional(), dueAt: z.string().datetime({ offset: true }).optional() }).parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const own = isOwnOnly(req.user, "tasks.edit");
      const r = await c.query(
        `UPDATE tasks SET title=COALESCE($2,title), due_at=COALESCE($3,due_at),
                done_at=CASE WHEN $4::boolean IS NULL THEN done_at WHEN $4 THEN COALESCE(done_at,now()) ELSE NULL END
          WHERE id=$1 AND (NOT $5 OR assignee_id=$6 OR created_by=$6)`,
        [id, d.title ?? null, d.dueAt ?? null, d.done ?? null, own, req.user.id]);
      if (!r.rowCount) throw new NotFoundException();
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "task", entityId: id,
        action: "update", after: d, ip: req.ip });
      return { updated: true };
    });
  }
}
