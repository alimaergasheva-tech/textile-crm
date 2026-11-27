import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrate } from "../src/db/migrate.ts";
import { DbService } from "../src/db/db.service.ts";
import { WarehouseJobsService } from "../src/warehouse/warehouse-jobs.service.ts";

const adminUrl = process.env.DATABASE_URL;
if (!adminUrl || !process.env.APP_DATABASE_URL) throw new Error("Нужны DATABASE_URL и APP_DATABASE_URL");
const admin = new pg.Pool({ connectionString: adminUrl });
const db = new DbService();
const jobs = new WarehouseJobsService(db);
const T = "(SELECT id FROM tenants WHERE slug IN ('wj-a','wj-b'))";
const CLEAN = ["notifications", "stock_movements", "stock_balances", "materials", "user_roles", "role_permissions", "roles", "users", "audit_log"]
  .map((t) => `DELETE FROM ${t} WHERE tenant_id IN ${T}`).join(";") + ";DELETE FROM tenants WHERE slug IN ('wj-a','wj-b')";
let a: string, b: string, boss: string, other: string;

before(async () => {
  await migrate(adminUrl);
  await admin.query(CLEAN);
  const q = async (sql: string, p: unknown[]) => (await admin.query(sql, p)).rows[0].id as string;
  a = await q("INSERT INTO tenants (slug,name) VALUES ('wj-a','A') RETURNING id", []);
  b = await q("INSERT INTO tenants (slug,name) VALUES ('wj-b','B') RETURNING id", []);
  boss = await q("INSERT INTO users (tenant_id,email,full_name) VALUES ($1,'boss@a','Склад') RETURNING id", [a]);
  other = await q("INSERT INTO users (tenant_id,email,full_name) VALUES ($1,'other@a','Менеджер') RETURNING id", [a]);
  const r1 = await q("INSERT INTO roles (tenant_id,code,name) VALUES ($1,'wh','Склад') RETURNING id", [a]);
  const r2 = await q("INSERT INTO roles (tenant_id,code,name) VALUES ($1,'mg','Менеджер') RETURNING id", [a]);
  await admin.query("INSERT INTO role_permissions (tenant_id,role_id,permission_code) VALUES ($1,$2,'warehouse.manage')", [a, r1]);
  await admin.query("INSERT INTO role_permissions (tenant_id,role_id,permission_code) VALUES ($1,$2,'warehouse.view')", [a, r2]);
  await admin.query("INSERT INTO user_roles (tenant_id,user_id,role_id) VALUES ($1,$2,$3),($1,$4,$5)", [a, boss, r1, other, r2]);
  await admin.query("INSERT INTO materials (tenant_id,code,name,type,unit,min_stock) VALUES ($1,'FAB','Ткань','fabric','m',100)", [a]);
});
after(async () => { await admin.query(CLEAN); await admin.end(); await db.pool.end(); });

test("минимальный остаток: сводка уходит только сотрудникам с правом warehouse.manage", async () => {
  assert.equal(await jobs.lowStockTenant(a), 1);
  const rows = (await admin.query("SELECT user_id,text FROM notifications WHERE tenant_id=$1", [a])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, boss);
  assert.match(rows[0].text, /FAB/);
});

test("чужая фабрика не получает уведомлений и сверка без расхождений молчит", async () => {
  assert.equal(await jobs.lowStockTenant(b), 0);
  assert.equal(await jobs.reconcileTenant(a), 0);
  assert.equal((await admin.query("SELECT 1 FROM notifications WHERE tenant_id=$1", [b])).rowCount, 0);
});

test("расхождение баланса с движениями замечается и сообщается", async () => {
  const w = (await admin.query("INSERT INTO warehouses (tenant_id,name,kind) VALUES ($1,'Сырьё','raw') RETURNING id", [a])).rows[0].id;
  const l = (await admin.query("INSERT INTO locations (tenant_id,warehouse_id,code) VALUES ($1,$2,'L1') RETURNING id", [a, w])).rows[0].id;
  const m = (await admin.query("SELECT id FROM materials WHERE tenant_id=$1", [a])).rows[0].id;
  await admin.query("INSERT INTO stock_balances (tenant_id,location_id,material_id,qty) VALUES ($1,$2,$3,5)", [a, l, m]); // баланс без движений
  await admin.query("DELETE FROM notifications WHERE tenant_id=$1", [a]);
  assert.equal(await jobs.reconcileTenant(a), 1);
  assert.equal((await admin.query("SELECT 1 FROM notifications WHERE tenant_id=$1 AND user_id=$2", [a, boss])).rowCount, 1);
  await admin.query("DELETE FROM stock_balances WHERE tenant_id=$1", [a]);
  await admin.query("DELETE FROM locations WHERE tenant_id=$1", [a]);
  await admin.query("DELETE FROM warehouses WHERE tenant_id=$1", [a]);
});
