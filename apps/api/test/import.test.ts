import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrate } from "../src/db/migrate.ts";
import { DbService } from "../src/db/db.service.ts";
import { AuditService } from "../src/audit/audit.service.ts";
import { ImportController } from "../src/export/import.controller.ts";
import { mapRows, parseCsv, toNum } from "../src/export/csv.ts";

const adminUrl = process.env.DATABASE_URL;
if (!adminUrl || !process.env.APP_DATABASE_URL) throw new Error("Нужны DATABASE_URL и APP_DATABASE_URL");
const admin = new pg.Pool({ connectionString: adminUrl });
const db = new DbService();
const imp = new ImportController(db, new AuditService());
const T = "(SELECT id FROM tenants WHERE slug IN ('im-a','im-b'))";
const CLEAN = ["stock_movements", "stock_balances", "contacts", "clients", "materials", "locations", "warehouses", "audit_log", "users"]
  .map((t) => `DELETE FROM ${t} WHERE tenant_id IN ${T}`).join(";") + ";DELETE FROM tenants WHERE slug IN ('im-a','im-b')";
let a: string, b: string;
const req = (tid: string, uid: string) => ({ user: { id: uid, tenantId: tid, perms: new Map() }, ip: "127.0.0.1" }) as any;
let uA: string, uB: string;

before(async () => {
  await migrate(adminUrl);
  await admin.query(CLEAN);
  const q = async (sql: string, p: unknown[]) => (await admin.query(sql, p)).rows[0].id as string;
  a = await q("INSERT INTO tenants (slug,name) VALUES ('im-a','A') RETURNING id", []);
  b = await q("INSERT INTO tenants (slug,name) VALUES ('im-b','B') RETURNING id", []);
  uA = await q("INSERT INTO users (tenant_id,email,full_name) VALUES ($1,'u@a','U') RETURNING id", [a]);
  uB = await q("INSERT INTO users (tenant_id,email,full_name) VALUES ($1,'u@b','U') RETURNING id", [b]);
  const w = await q("INSERT INTO warehouses (tenant_id,name,kind) VALUES ($1,'Сырьё','raw') RETURNING id", [a]);
  await admin.query("INSERT INTO locations (tenant_id,warehouse_id,code) VALUES ($1,$2,'R-1')", [a, w]);
});
after(async () => { await admin.query(CLEAN); await admin.end(); await db.pool.end(); });

test("CSV из Excel: BOM, разделитель «;», кавычки, пустые строки, запятая в числе", () => {
  const rows = parseCsv('﻿название;адрес;лимит\r\n"ООО ""Альфа""; Ко";Ташкент, 1;1 500,50\r\n\r\nБета;;0\r\n');
  assert.deepEqual(rows, [["название", "адрес", "лимит"], ['ООО "Альфа"; Ко', "Ташкент, 1", "1 500,50"], ["Бета", "", "0"]]);
  assert.equal(toNum("1 500,50"), 1500.5);
  assert.ok(Number.isNaN(toNum("abc")));
  const m = mapRows(rows, { name: ["название"], credit_limit: ["лимит"] });
  assert.equal(m.rows[0].name, 'ООО "Альфа"; Ко'); assert.deepEqual(m.unknown, ["адрес"]);
});

test("пробная проверка ничего не записывает, загрузка создаёт, повтор обновляет", async () => {
  const csv = "название;тип;кредитный лимит;телефон;внешний id\nООО Альфа;опт;1000000;+998901112233;K-1\nБета;розница;;;\n";
  const dry = await imp.run(req(a, uA), "clients", { csv, dryRun: true });
  assert.equal(dry.created, 2); assert.equal(dry.applied, false);
  assert.equal((await admin.query("SELECT 1 FROM clients WHERE tenant_id=$1", [a])).rowCount, 0);
  const real = await imp.run(req(a, uA), "clients", { csv, dryRun: false });
  assert.equal(real.applied, true);
  const c = (await admin.query("SELECT name,type,credit_limit::text AS lim FROM clients WHERE tenant_id=$1 AND external_id='K-1'", [a])).rows[0];
  assert.deepEqual(c, { name: "ООО Альфа", type: "wholesale", lim: "100000000" }); // 1 000 000 сум = 100 000 000 минимальных единиц
  assert.equal((await admin.query("SELECT 1 FROM contacts WHERE tenant_id=$1 AND phone='+998901112233'", [a])).rowCount, 1);
  const again = await imp.run(req(a, uA), "clients", { csv: csv.replace("опт;1000000", "опт;2000000"), dryRun: false });
  assert.equal(again.created, 0); assert.equal(again.updated, 2);
  assert.equal((await admin.query("SELECT 1 FROM clients WHERE tenant_id=$1", [a])).rowCount, 2);
  assert.equal((await admin.query("SELECT 1 FROM contacts WHERE tenant_id=$1", [a])).rowCount, 1); // контакт не задвоился
});

test("ошибка в любой строке — не загружается ничего, ошибки с номерами строк", async () => {
  const csv = "код;название;тип;ед;мин. остаток\nM-1;Нитки;нитки;бобина;10\nM-2;Ткань;ткань;ярд;5\nM-3;Лента;фурнитура;м;abc\n";
  const r = await imp.run(req(a, uA), "materials", { csv, dryRun: false });
  assert.equal(r.applied, false); assert.equal(r.errorCount, 2);
  assert.deepEqual(r.errors.map((e: any) => e.row), [3, 4]);
  assert.equal((await admin.query("SELECT 1 FROM materials WHERE tenant_id=$1", [a])).rowCount, 0);
});

test("начальные остатки: один раз на позицию, ткань отклоняется, чужая фабрика не видна", async () => {
  await imp.run(req(a, uA), "materials", { csv: "код;название;тип;ед\nTHR;Нитки;нитки;шт\nFAB;Ткань;ткань;м\n", dryRun: false });
  const ok = await imp.run(req(a, uA), "stock", { csv: "код материала;количество\nTHR;40\n", dryRun: false });
  assert.equal(ok.applied, true);
  assert.equal(Number((await admin.query("SELECT sum(qty) q FROM stock_balances WHERE tenant_id=$1", [a])).rows[0].q), 40);
  const dup = await imp.run(req(a, uA), "stock", { csv: "код материала;количество\nTHR;5\nFAB;10\n", dryRun: false });
  assert.equal(dup.applied, false); assert.equal(dup.errorCount, 2);
  assert.match(dup.errors[0].message, /уже есть движения/); assert.match(dup.errors[1].message, /рулонами/);
  const other = await imp.run(req(b, uB), "stock", { csv: "код материала;количество\nTHR;1\n", dryRun: true });
  assert.match(other.errors[0].message, /не найден/);
  await assert.rejects(imp.run(req(a, uA), "orders", { csv: "x", dryRun: true }));
});
