import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req } from "@nestjs/common";
import type pg from "pg";
import { z } from "zod";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { RequirePermission } from "../rbac/rbac.ts";
import { R } from "../crm/common.ts";
import { publish } from "../realtime/realtime.ts";
import { TEMPLATE, schedule, lateDays, workdaysBetween, toDate } from "./plan.ts";

export const TZ_OFFSET_H = 5; // Ташкент
export const todayLocal = (now = new Date()) => new Date(now.getTime() + TZ_OFFSET_H * 3600_000).toISOString().slice(0, 10);

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Generate = z.object({ startDate: date.optional(), sewingSetsPerDay: z.number().int().min(100).max(20000).default(1500), force: z.boolean().default(false) });
const Reschedule = z.object({ startDate: date.optional() });
const Patch_ = z.object({
  version: z.number().int(),
  status: z.enum(["todo", "in_progress", "blocked", "done"]).optional(),
  durationDays: z.number().int().min(1).max(365).optional(),
  actualStart: date.nullish(), actualEnd: date.nullish(), note: z.string().max(2000).nullish(),
});

type Row = { id: string; seq: number; duration_days: number; predecessors: number[]; status: "todo" | "in_progress" | "blocked" | "done"; actual_start: string | null; actual_end: string | null };
const dstr = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : (v as string | null));

/** Пересчитывает плановые даты всех этапов заказа от даты старта плана. */
export async function reschedule(c: pg.PoolClient, orderId: string, today = todayLocal()) {
  const o = (await c.query("SELECT plan_start::text AS plan_start FROM export_orders WHERE id=$1", [orderId])).rows[0];
  if (!o?.plan_start) return;
  const rows: Row[] = (await c.query(
    "SELECT id,seq,duration_days,predecessors,status,actual_start::text,actual_end::text FROM export_plan_tasks WHERE order_id=$1 ORDER BY seq", [orderId])).rows;
  const res = schedule(rows.map((r) => ({ seq: r.seq, days: r.duration_days, pred: r.predecessors, status: r.status, actualStart: r.actual_start, actualEnd: r.actual_end })), o.plan_start, today);
  for (const [i, r] of rows.entries())
    await c.query("UPDATE export_plan_tasks SET planned_start=$2, planned_end=$3 WHERE id=$1", [r.id, res[i].start, res[i].end]);
}

@Controller()
export class ExportPlanController {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}

  @Get("export-orders/:id/plan") @RequirePermission("exportorders.view")
  plan(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const o = (await c.query("SELECT target_exfactory::text AS target, plan_start::text AS plan_start FROM export_orders WHERE id=$1", [id])).rows[0];
      if (!o) throw new NotFoundException();
      const today = todayLocal();
      const tasks = (await c.query(
        `SELECT id,seq,stage,name,department_code,party,duration_days,predecessors,planned_start::text,planned_end::text,baseline_start::text,baseline_end::text,
                actual_start::text,actual_end::text,status,note,version FROM export_plan_tasks WHERE order_id=$1 ORDER BY seq`, [id])).rows;
      const withLate = tasks.map((t) => ({ ...t, lateDays: lateDays(t.planned_end, t.status, today),
        shiftDays: t.baseline_end ? workdaysBetween(toDate(t.baseline_end), toDate(t.planned_end)) : 0 }));
      const exFactory = tasks.length ? tasks.map((t) => t.planned_end).sort().pop() : null;
      const baseEx = tasks.length ? tasks.map((t) => t.baseline_end).sort().pop() : null;
      return {
        planStart: o.plan_start, target: o.target, exFactory, baselineExFactory: baseEx, today,
        // положительное — позже цели (опоздание), в календарных днях
        deltaDays: exFactory && o.target ? Math.round((+toDate(exFactory) - +toDate(o.target)) / 86400_000) : null,
        lateCount: withLate.filter((t) => t.lateDays > 0).length, tasks: withLate,
      };
    });
  }

  /** Создать план по типовому шаблону. Пошив считается по числу комплектов и мощности цеха. */
  @Post("export-orders/:id/plan/generate") @RequirePermission("exportplan.manage")
  generate(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = Generate.parse(body ?? {});
    return this.db.tx(req.user.tenantId, async (c) => {
      const o = (await c.query("SELECT plan_start FROM export_orders WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!o) throw new NotFoundException();
      const existing = (await c.query("SELECT count(*)::int AS n, count(*) FILTER (WHERE status<>'todo')::int AS started FROM export_plan_tasks WHERE order_id=$1", [id])).rows[0];
      if (existing.n && existing.started && !d.force) throw new ConflictException("В плане уже есть отметки о выполнении. Чтобы пересоздать, подтвердите (force).");
      const sets = Number((await c.query("SELECT COALESCE(sum(qty),0)::int AS n FROM export_models WHERE order_id=$1", [id])).rows[0].n);
      if (!sets) throw new BadRequestException("В заказе нет моделей — загрузите «Status» перед созданием плана");
      const sewing = Math.max(1, Math.ceil(sets / d.sewingSetsPerDay));
      const start = d.startDate ?? todayLocal();
      await c.query("DELETE FROM export_plan_tasks WHERE order_id=$1", [id]);
      await c.query("UPDATE export_orders SET plan_start=$2, version=version+1 WHERE id=$1", [id, start]);
      for (const t of TEMPLATE)
        await c.query(
          `INSERT INTO export_plan_tasks (tenant_id,order_id,seq,stage,name,department_code,party,duration_days,predecessors) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [req.user.tenantId, id, t.seq, t.stage, t.name, t.dept, t.party, t.days === "sewing" ? sewing : t.days, t.pred]);
      await reschedule(c, id);
      await c.query("UPDATE export_plan_tasks SET baseline_start=planned_start, baseline_end=planned_end WHERE order_id=$1", [id]);
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "export_order", entityId: id, action: "plan_generate", after: { start, sets, sewingDays: sewing }, ip: req.ip });
      await publish(c, req.user.tenantId, { channel: "export_orders", kind: "updated", entity: "export_order", entityId: id, actorId: req.user.id });
      return { tasks: TEMPLATE.length, sets, sewingDays: sewing, start };
    });
  }

  @Post("export-orders/:id/plan/reschedule") @RequirePermission("exportplan.manage")
  resched(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = Reschedule.parse(body ?? {});
    return this.db.tx(req.user.tenantId, async (c) => {
      if (!(await c.query("SELECT 1 FROM export_orders WHERE id=$1 FOR UPDATE", [id])).rowCount) throw new NotFoundException();
      if (d.startDate) await c.query("UPDATE export_orders SET plan_start=$2 WHERE id=$1", [id, d.startDate]);
      await reschedule(c, id);
      await publish(c, req.user.tenantId, { channel: "export_orders", kind: "updated", entity: "export_order", entityId: id, actorId: req.user.id });
      return { ok: true };
    });
  }

  /** Отметить этап: статус, фактические даты, длительность (длительность — только руководитель плана). */
  @Patch("export-plan-tasks/:id") @RequirePermission("exportplan.update")
  update(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = Patch_.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const t = (await c.query("SELECT * FROM export_plan_tasks WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!t) throw new NotFoundException();
      if (t.version !== d.version) throw new ConflictException("План изменён другим пользователем — обновите страницу");
      const manage = req.user.perms.has("exportplan.manage");
      if (!manage) {
        if (d.durationDays !== undefined) throw new ForbiddenException("Менять длительность может только руководитель плана");
        const mine = t.department_code && (await c.query(
          `SELECT 1 FROM user_departments ud JOIN departments dp ON dp.id=ud.department_id WHERE ud.user_id=$1 AND dp.code=$2`, [req.user.id, t.department_code])).rowCount;
        if (!mine) throw new ForbiddenException("Этап другого отдела — отметить его может только его отдел или руководитель плана");
      }
      const today = todayLocal();
      let status = d.status ?? t.status;
      let aStart = d.actualStart === undefined ? dstr(t.actual_start) : d.actualStart;
      let aEnd = d.actualEnd === undefined ? dstr(t.actual_end) : d.actualEnd;
      if (status === "in_progress" && !aStart) aStart = today;
      if (status === "done") { aStart ??= today; aEnd ??= today; }
      if (status !== "done") aEnd = null;
      if (aStart && aEnd && aEnd < aStart) throw new BadRequestException("Окончание раньше начала");
      await c.query(
        `UPDATE export_plan_tasks SET status=$2, actual_start=$3, actual_end=$4, duration_days=COALESCE($5,duration_days), note=CASE WHEN $6 THEN $7 ELSE note END,
                notified_on=NULL, version=version+1 WHERE id=$1`,
        [id, status, aStart, aEnd, d.durationDays ?? null, d.note !== undefined, d.note ?? null]);
      await reschedule(c, t.order_id);
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "export_plan_task", entityId: id, action: "update", before: { status: t.status }, after: { status, aStart, aEnd }, ip: req.ip });
      await publish(c, req.user.tenantId, { channel: "export_orders", kind: "updated", entity: "export_order", entityId: t.order_id, actorId: req.user.id });
      return { ok: true };
    });
  }

  /** Просроченные этапы по всем заказам (для главной и отделов). */
  @Get("export-plan/late") @RequirePermission("exportorders.view")
  late(@Req() req: R) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      `SELECT t.id,t.seq,t.name,t.department_code,t.party,t.planned_end::text,o.id AS order_id,o.number,
              ($1::date - t.planned_end) AS late_days
         FROM export_plan_tasks t JOIN export_orders o ON o.id=t.order_id
        WHERE t.status<>'done' AND t.planned_end < $1::date AND o.status NOT IN ('closed','cancelled')
        ORDER BY late_days DESC, o.number, t.seq LIMIT 200`, [todayLocal()])).rows);
  }
}
