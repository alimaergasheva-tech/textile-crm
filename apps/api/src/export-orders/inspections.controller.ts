import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Req } from "@nestjs/common";
import { z } from "zod";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { RequirePermission } from "../rbac/rbac.ts";
import { R } from "../crm/common.ts";
import { publish } from "../realtime/realtime.ts";
import { AQLS, plan, verdict, type Aql } from "./aql.ts";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const aql = z.number().refine((v) => AQLS.includes(v as Aql), "AQL: 2.5 или 4.0");
const Create = z.object({ modelId: z.string().uuid(), inspectedOn: date.optional(), inspector: z.string().max(100).optional(), lotQty: z.number().int().positive().optional(), aqlMajor: aql.optional(), aqlMinor: aql.optional() });
const Patch_ = z.object({ version: z.number().int(), inspectedOn: date.nullish(), inspector: z.string().max(100).nullish(), lotQty: z.number().int().positive().optional(), aqlMajor: aql.optional(), aqlMinor: aql.optional(), notes: z.string().max(3000).nullish() });
const Defects = z.object({ defects: z.array(z.object({ defect: z.string().min(1).max(200), severity: z.enum(["critical", "major", "minor"]), qty: z.number().int().positive().max(100000), note: z.string().max(500).nullish() })).max(100) });
const Photo = z.object({ caption: z.string().max(200).nullish(), mime: z.enum(["image/jpeg", "image/png", "image/webp"]), data: z.string().min(100) });
const MAX_PHOTOS = 24, MAX_BYTES = 3 * 1024 * 1024;

@Controller()
export class ExportInspectionsController {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}

  private async load(c: import("pg").PoolClient, id: string) {
    const i = (await c.query(
      `SELECT i.id,i.order_id,i.model_id,m.code AS model,i.round,i.status,i.inspected_on::text,i.inspector,i.lot_qty,i.sample_size,i.aql_major::float8 AS aql_major,i.aql_minor::float8 AS aql_minor,
              i.ac_major,i.re_major,i.ac_minor,i.re_minor,i.notes,i.finalized_at,i.version, o.number AS order_number, o.brand, o.collection
         FROM export_inspections i JOIN export_models m ON m.id=i.model_id JOIN export_orders o ON o.id=i.order_id WHERE i.id=$1`, [id])).rows[0];
    if (!i) throw new NotFoundException();
    const defects = (await c.query("SELECT id,defect,severity,qty,note FROM export_inspection_defects WHERE inspection_id=$1 ORDER BY sort", [id])).rows;
    const photos = (await c.query("SELECT id,caption FROM export_inspection_photos WHERE inspection_id=$1 ORDER BY sort,created_at", [id])).rows;
    return { ...i, defects, photos, verdict: verdict(defects, i.ac_major, i.ac_minor) };
  }

  @Get("export-orders/:id/inspections") @RequirePermission("exportinspections.view")
  list(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const ids = (await c.query("SELECT i.id FROM export_inspections i JOIN export_models m ON m.id=i.model_id WHERE i.order_id=$1 ORDER BY m.sort, m.code, i.round", [id])).rows;
      return Promise.all(ids.map((r: { id: string }) => this.load(c, r.id)));
    });
  }

  @Get("export-inspections/:id") @RequirePermission("exportinspections.view")
  one(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) { return this.db.tx(req.user.tenantId, (c) => this.load(c, id)); }

  /** Данные отчёта вместе с фото (data URL) — для печати и сохранения в PDF. */
  @Get("export-inspections/:id/report") @RequirePermission("exportinspections.view")
  report(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const i = await this.load(c, id);
      const ph = (await c.query("SELECT id,caption,mime,encode(data,'base64') AS b64 FROM export_inspection_photos WHERE inspection_id=$1 ORDER BY sort,created_at", [id])).rows;
      return { ...i, photos: ph.map((p: any) => ({ id: p.id, caption: p.caption, src: `data:${p.mime};base64,${p.b64}` })) };
    });
  }

  @Post("export-orders/:id/inspections") @RequirePermission("exportinspections.manage")
  create(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = Create.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const m = (await c.query("SELECT qty FROM export_models WHERE id=$1 AND order_id=$2", [d.modelId, id])).rows[0];
      if (!m) throw new NotFoundException("Модель не найдена в заказе");
      const prev = (await c.query("SELECT round,status FROM export_inspections WHERE model_id=$1 ORDER BY round DESC LIMIT 1", [d.modelId])).rows[0];
      if (prev && prev.status === "draft") throw new ConflictException("По модели уже есть незавершённая инспекция");
      const lot = d.lotQty ?? Number(m.qty), am = d.aqlMajor ?? 2.5, an = d.aqlMinor ?? 4;
      const pm = plan(lot, am as Aql), pn = plan(lot, an as Aql);
      const nid = (await c.query(
        `INSERT INTO export_inspections (tenant_id,order_id,model_id,round,inspected_on,inspector,lot_qty,sample_size,aql_major,aql_minor,ac_major,re_major,ac_minor,re_minor,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [req.user.tenantId, id, d.modelId, (prev?.round ?? 0) + 1, d.inspectedOn ?? null, d.inspector ?? null, lot, pm.sampleSize, am, an, pm.ac, pm.re, pn.ac, pn.re, req.user.id])).rows[0].id;
      await publish(c, req.user.tenantId, { channel: "export_orders", kind: "updated", entity: "export_order", entityId: id, actorId: req.user.id });
      return this.load(c, nid);
    });
  }

  @Patch("export-inspections/:id") @RequirePermission("exportinspections.manage")
  update(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = Patch_.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const i = (await c.query("SELECT * FROM export_inspections WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!i) throw new NotFoundException();
      if (i.status !== "draft") throw new BadRequestException("Отчёт уже завершён — менять нельзя");
      if (i.version !== d.version) throw new ConflictException("Отчёт изменён другим пользователем — обновите страницу");
      const lot = d.lotQty ?? i.lot_qty, am = d.aqlMajor ?? Number(i.aql_major), an = d.aqlMinor ?? Number(i.aql_minor);
      const pm = plan(lot, am as Aql), pn = plan(lot, an as Aql);
      await c.query(
        `UPDATE export_inspections SET inspected_on=CASE WHEN $2 THEN $3::date ELSE inspected_on END, inspector=CASE WHEN $4 THEN $5 ELSE inspector END,
           lot_qty=$6, sample_size=$7, aql_major=$8, aql_minor=$9, ac_major=$10, re_major=$11, ac_minor=$12, re_minor=$13,
           notes=CASE WHEN $14 THEN $15 ELSE notes END, version=version+1 WHERE id=$1`,
        [id, d.inspectedOn !== undefined, d.inspectedOn ?? null, d.inspector !== undefined, d.inspector ?? null, lot, pm.sampleSize, am, an, pm.ac, pm.re, pn.ac, pn.re, d.notes !== undefined, d.notes ?? null]);
      return this.load(c, id);
    });
  }

  /** Полная замена списка дефектов. */
  @Put("export-inspections/:id/defects") @RequirePermission("exportinspections.manage")
  defects(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = Defects.parse(body);
    return this.db.tx(req.user.tenantId, async (c) => {
      const i = (await c.query("SELECT status FROM export_inspections WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!i) throw new NotFoundException();
      if (i.status !== "draft") throw new BadRequestException("Отчёт уже завершён — менять нельзя");
      await c.query("DELETE FROM export_inspection_defects WHERE inspection_id=$1", [id]);
      for (const [k, x] of d.defects.entries())
        await c.query("INSERT INTO export_inspection_defects (tenant_id,inspection_id,defect,severity,qty,note,sort) VALUES ($1,$2,$3,$4,$5,$6,$7)", [req.user.tenantId, id, x.defect, x.severity, x.qty, x.note ?? null, k]);
      await c.query("UPDATE export_inspections SET version=version+1 WHERE id=$1", [id]);
      return this.load(c, id);
    });
  }

  @Post("export-inspections/:id/photos") @RequirePermission("exportinspections.manage")
  addPhoto(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const d = Photo.parse(body);
    const b64 = d.data.replace(/^data:[^,]*,/, "");
    const buf = Buffer.from(b64, "base64");
    if (!buf.length || buf.length > MAX_BYTES) throw new BadRequestException("Фото больше 3 МБ или пустое — уменьшите снимок");
    return this.db.tx(req.user.tenantId, async (c) => {
      const i = (await c.query("SELECT status FROM export_inspections WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!i) throw new NotFoundException();
      if (i.status !== "draft") throw new BadRequestException("Отчёт уже завершён — менять нельзя");
      const n = (await c.query("SELECT count(*)::int AS n FROM export_inspection_photos WHERE inspection_id=$1", [id])).rows[0].n;
      if (n >= MAX_PHOTOS) throw new BadRequestException(`Не больше ${MAX_PHOTOS} фото в отчёте`);
      await c.query("INSERT INTO export_inspection_photos (tenant_id,inspection_id,caption,mime,data,sort) VALUES ($1,$2,$3,$4,$5,$6)", [req.user.tenantId, id, d.caption ?? null, d.mime, buf, n]);
      return this.load(c, id);
    });
  }

  @Delete("export-inspection-photos/:id") @RequirePermission("exportinspections.manage")
  delPhoto(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const p = (await c.query("SELECT p.inspection_id, i.status FROM export_inspection_photos p JOIN export_inspections i ON i.id=p.inspection_id WHERE p.id=$1", [id])).rows[0];
      if (!p) throw new NotFoundException();
      if (p.status !== "draft") throw new BadRequestException("Отчёт уже завершён — менять нельзя");
      await c.query("DELETE FROM export_inspection_photos WHERE id=$1", [id]);
      return this.load(c, p.inspection_id);
    });
  }

  /** Завершить отчёт: нужны дата, инспектор и хотя бы одно фото. После этого отчёт не меняется; при отказе создаётся новый круг. */
  @Post("export-inspections/:id/finalize") @RequirePermission("exportinspections.manage")
  finalize(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.tx(req.user.tenantId, async (c) => {
      const i = (await c.query("SELECT * FROM export_inspections WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!i) throw new NotFoundException();
      if (i.status !== "draft") throw new BadRequestException("Отчёт уже завершён");
      if (!i.inspected_on || !i.inspector) throw new BadRequestException("Укажите дату инспекции и инспектора");
      if (!(await c.query("SELECT 1 FROM export_inspection_photos WHERE inspection_id=$1 LIMIT 1", [id])).rowCount) throw new BadRequestException("Добавьте хотя бы одно фото");
      await c.query("UPDATE export_inspections SET status='final', finalized_at=now(), finalized_by=$2, version=version+1 WHERE id=$1", [id, req.user.id]);
      const out = await this.load(c, id);
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "export_inspection", entityId: id, action: "finalize", after: { result: out.verdict.result, model: out.model }, ip: req.ip });
      await publish(c, req.user.tenantId, { channel: "export_orders", kind: "updated", entity: "export_order", entityId: i.order_id, actorId: req.user.id });
      return out;
    });
  }
}
