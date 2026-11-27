import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req, Res, StreamableFile } from "@nestjs/common";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "../config.ts";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { AuthUser, RequirePermission } from "../rbac/rbac.ts";

type R = { user: AuthUser; ip?: string };
const FILES_DIR = process.env.FILES_DIR ?? path.resolve(process.cwd(), "data/files");
const Presign = z.object({ name: z.string().min(1).max(255), mime: z.string().optional(),
  sizeBytes: z.number().int().positive().max(20 * 1024 * 1024),
  entity: z.string().optional(), entityId: z.string().optional() });

@Controller("files")
export class FilesController {
  private s3 = new S3Client({ region: "us-east-1", endpoint: config.s3().endpoint, forcePathStyle: true,
    credentials: { accessKeyId: config.s3().accessKey, secretAccessKey: config.s3().secretKey } });
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}

  /** Клиент получает ссылку и грузит файл прямо в хранилище, минуя API. Ключ всегда начинается с id фабрики. */
  @Post("presign-upload") @RequirePermission("files.create")
  async presign(@Req() req: R, @Body() body: unknown) {
    const d = Presign.parse(body);
    const key = `${req.user.tenantId}/${randomUUID()}`;
    const id = await this.db.tx(req.user.tenantId, async (c) => {
      const lim = (await c.query(
        `SELECT t.max_storage_mb, (SELECT coalesce(sum(size_bytes),0) FROM files)::float8 AS used FROM tenants t WHERE t.id=$1`,
        [req.user.tenantId])).rows[0];
      if (lim && lim.used + d.sizeBytes > lim.max_storage_mb * 1048576)
        throw new ForbiddenException(`Лимит тарифа: хранилище ${lim.max_storage_mb} МБ заполнено`);
      const fid = (await c.query(
        `INSERT INTO files (tenant_id,storage_key,original_name,mime,size_bytes,entity,entity_id,uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [req.user.tenantId, key, d.name, d.mime ?? null, d.sizeBytes, d.entity ?? null, d.entityId ?? null, req.user.id])).rows[0].id;
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "file", entityId: fid,
        action: "create", after: { name: d.name, entity: d.entity, entityId: d.entityId }, ip: req.ip });
      return fid;
    });
    const url = await getSignedUrl(this.s3,
      new PutObjectCommand({ Bucket: config.s3().bucket, Key: key, ContentType: d.mime }), { expiresIn: 300 });
    return { id, uploadUrl: url };
  }

  // ---------- фото к брaку и рекламациям: загрузка через API, файл лежит на диске сервера ----------
  /** JSON с base64 (клиент заранее уменьшает снимок до ~1280 px). Только изображения до 8 МБ; сущность — production_order или complaint. */
  @Post("upload") @RequirePermission("files.create")
  async upload(@Req() req: R, @Body() body: unknown) {
    const d = z.object({ name: z.string().min(1).max(255), mime: z.string().regex(/^image\/(jpeg|png|webp)$/, "Только фото JPEG, PNG или WebP"),
      data: z.string().min(1), entity: z.enum(["production_order", "complaint"]), entityId: z.string().uuid() }).parse(body);
    const buf = Buffer.from(d.data, "base64");
    if (!buf.length || buf.length > 8 * 1024 * 1024) throw new BadRequestException("Фото пустое или больше 8 МБ");
    const id = randomUUID();
    const rel = `${req.user.tenantId}/${id}`;
    const fid = await this.db.tx(req.user.tenantId, async (c) => {
      const lim = (await c.query(`SELECT t.max_storage_mb, (SELECT coalesce(sum(size_bytes),0) FROM files)::float8 AS used FROM tenants t WHERE t.id=$1`, [req.user.tenantId])).rows[0];
      if (lim && lim.used + buf.length > lim.max_storage_mb * 1048576) throw new ForbiddenException(`Лимит тарифа: хранилище ${lim.max_storage_mb} МБ заполнено`);
      const table = d.entity === "complaint" ? "complaints" : "production_orders";
      if (!(await c.query(`SELECT 1 FROM ${table} WHERE id=$1`, [d.entityId])).rowCount) throw new NotFoundException("Объект не найден");
      const r = (await c.query(
        `INSERT INTO files (tenant_id,storage_key,original_name,mime,size_bytes,entity,entity_id,uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [req.user.tenantId, "local:" + rel, d.name, d.mime, buf.length, d.entity, d.entityId, req.user.id])).rows[0].id;
      await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "file", entityId: r, action: "create", after: { entity: d.entity, entityId: d.entityId, size: buf.length }, ip: req.ip });
      return r;
    });
    const full = path.join(FILES_DIR, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, buf);
    return { id: fid };
  }

  @Get() @RequirePermission("files.view")
  list(@Req() req: R, @Query("entity") entity: string, @Query("entityId") entityId: string) {
    return this.db.tx(req.user.tenantId, async (c) => (await c.query(
      "SELECT id,original_name,mime,size_bytes,created_at FROM files WHERE entity=$1 AND entity_id=$2 AND storage_key LIKE 'local:%' ORDER BY created_at", [entity, entityId])).rows);
  }

  /** Байты фото (с заголовком авторизации; фабрика берётся из токена, чужой файл не находится). */
  @Get(":id/raw") @RequirePermission("files.view")
  async raw(@Req() req: R, @Param("id", ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: any) {
    const f = await this.db.tx(req.user.tenantId, async (c) => (await c.query("SELECT storage_key,mime FROM files WHERE id=$1 AND storage_key LIKE 'local:%'", [id])).rows[0]);
    if (!f) throw new NotFoundException();
    const buf = await readFile(path.join(FILES_DIR, f.storage_key.slice(6))).catch(() => { throw new NotFoundException(); });
    res.set({ "Content-Type": f.mime ?? "image/jpeg", "Cache-Control": "private, max-age=3600" });
    return new StreamableFile(buf);
  }

  @Get(":id/url") @RequirePermission("files.view")
  async url(@Req() req: R, @Param("id", ParseUUIDPipe) id: string) {
    // RLS не отдаст файл чужой фабрики: строка просто не найдётся.
    const f = await this.db.tx(req.user.tenantId, async (c) =>
      (await c.query("SELECT storage_key FROM files WHERE id=$1", [id])).rows[0]);
    if (!f) return { url: null };
    return { url: await getSignedUrl(this.s3, new GetObjectCommand({ Bucket: config.s3().bucket, Key: f.storage_key }), { expiresIn: 300 }) };
  }
}
