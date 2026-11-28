import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import pg from "pg";
import { migrate } from "../src/db/migrate.ts";
import { DbService } from "../src/db/db.service.ts";
import { AuditService } from "../src/audit/audit.service.ts";
import { ExportOrdersController } from "../src/export-orders/export-orders.controller.ts";
import { ExportCatalogController } from "../src/export-orders/catalog.controller.ts";
import { scaleQty } from "../src/export-orders/scale.ts";

// Этап 10: заказ, модели, оптимистичная блокировка, масштабирование количества, изоляция фабрик.
// Импорт реальных файлов проверяется, если заданы SET44_STATUS_XLSX и SET44_TABEL_XLSX (пути к файлам).
const adminUrl = process.env.DATABASE_URL;
if (!adminUrl || !process.env.APP_DATABASE_URL) throw new Error("Нужны DATABASE_URL и APP_DATABASE_URL");
const admin = new pg.Pool({ connectionString: adminUrl });
const db = new DbService();
const audit = new AuditService();
const orders = new ExportOrdersController(db, audit);
const cat = new ExportCatalogController(db, audit);
const SLUGS = "('xo-a','xo-b')";
const CLEAN = ["audit_log", "realtime_events", "export_models", "export_orders", "pattern_measures", "patterns", "export_fabrics", "export_accessories", "clients", "users"]
  .map((t) => `DELETE FROM ${t} WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN ${SLUGS})`).join(";") + `;DELETE FROM tenants WHERE slug IN ${SLUGS}`;
let tA: string, tB: string, uA: string, clientA: string, clientB: string;
const as = (tenantId: string, id: string) => ({ user: { id, tenantId, perms: new Map<string, boolean>() }, ip: "127.0.0.1" }) as any;

before(async () => {
  await migrate(adminUrl);
  await admin.query(CLEAN);
  const q = async (sql: string, p: unknown[]) => (await admin.query(sql, p)).rows[0].id as string;
  tA = await q("INSERT INTO tenants (slug,name) VALUES ('xo-a','A') RETURNING id", []);
  tB = await q("INSERT INTO tenants (slug,name) VALUES ('xo-b','B') RETURNING id", []);
  uA = await q("INSERT INTO users (tenant_id,email,full_name) VALUES ($1,'a@xo.test','A') RETURNING id", [tA]);
  clientA = await q("INSERT INTO clients (tenant_id,name) VALUES ($1,'STREET LIGHT') RETURNING id", [tA]);
  clientB = await q("INSERT INTO clients (tenant_id,name) VALUES ($1,'Other') RETURNING id", [tB]);
});
after(async () => { await admin.query(CLEAN); await admin.end(); await db.pool.end(); });

test("scaleQty: сумма точно равна цели, пропорции сохраняются", () => {
  const src = { "122": 250, "128": 450, "134": 500, "140": 500, "146": 450, "152": 350, "158": 250 }; // 2750
  const out = scaleQty(src, 3500);
  assert.equal(Object.values(out).reduce((a, b) => a + b, 0), 3500);
  assert.ok(Math.abs(out["134"] - 500 * 3500 / 2750) <= 1);
  assert.deepEqual(scaleQty({ a: 1, b: 1, c: 1 }, 10), { a: 4, b: 3, c: 3 });
  assert.deepEqual(scaleQty({ a: 0, b: 0 }, 5), { a: 0, b: 0 });
});

test("заказ: создание, номер, версия и конфликт при одновременной правке", async () => {
  const a = await orders.create(as(tA, uA), { clientId: clientA, brand: "VTEME", collection: "SET44", targetExfactory: "2027-01-05" });
  assert.match(a.number, /^X-\d{4}-0001$/);
  const v1 = (await orders.get(as(tA, uA), a.id)).version;
  await orders.update(as(tA, uA), a.id, { notes: "x", version: v1 });
  await assert.rejects(orders.update(as(tA, uA), a.id, { notes: "y", version: v1 }), /другим пользователем/);
  await assert.rejects(orders.remove(as(tA, uA), "00000000-0000-0000-0000-000000000000"), /NotFound|Not Found/i);
  await orders.remove(as(tA, uA), a.id);
});

test("изоляция фабрик: чужой клиент и чужой заказ недоступны", async () => {
  await assert.rejects(orders.create(as(tA, uA), { clientId: clientB }), /Клиент не найден/);
  const o = await orders.create(as(tA, uA), { clientId: clientA });
  await assert.rejects(orders.get(as(tB, uA), o.id));
  assert.equal((await orders.list(as(tB, uA))).length, 0);
});

test("10 пользователей создают заказы одновременно — номера уникальны или повтор отклоняется без дублей", async () => {
  const res = await Promise.allSettled(Array.from({ length: 10 }, () => orders.create(as(tA, uA), { clientId: clientA })));
  const nums = res.filter((r) => r.status === "fulfilled").map((r: any) => r.value.number);
  assert.equal(new Set(nums).size, nums.length);
  assert.ok(nums.length >= 1);
});

const STATUS = process.env.SET44_STATUS_XLSX, TABEL = process.env.SET44_TABEL_XLSX;
test("импорт SET44: превью, qtyPerModel=3500, загрузка моделей и повторный импорт без дублей", { skip: !STATUS || !TABEL }, async () => {
  const p = await cat.importPatterns(as(tA, uA), { xlsxBase64: fs.readFileSync(TABEL!).toString("base64"), dryRun: false });
  assert.ok(p.patterns.length >= 5);
  const o = await orders.create(as(tA, uA), { clientId: clientA, brand: "VTEME" });
  const b64 = fs.readFileSync(STATUS!).toString("base64");
  const prev: any = await orders.importStatus(as(tA, uA), o.id, { xlsxBase64: b64, dryRun: true, qtyPerModel: 3500 });
  assert.equal(prev.models.length, 10);
  assert.ok(prev.models.every((m: any) => m.qty === 3500));
  assert.equal((await orders.get(as(tA, uA), o.id)).models.length, 0);        // превью ничего не пишет
  await orders.importStatus(as(tA, uA), o.id, { xlsxBase64: b64, dryRun: false, qtyPerModel: 3500 });
  await orders.importStatus(as(tA, uA), o.id, { xlsxBase64: b64, dryRun: false, qtyPerModel: 3500 });
  const full = await orders.get(as(tA, uA), o.id);
  assert.equal(full.models.length, 10);
  assert.ok(full.models.every((m: any) => m.fabric_top_id && m.qty === 3500));
});
