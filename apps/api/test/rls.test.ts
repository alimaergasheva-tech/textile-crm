import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrate } from "../src/db/migrate.ts";
import { withTenant } from "../src/db/tenant.ts";

const adminUrl = process.env.DATABASE_URL;
const appUrl = process.env.APP_DATABASE_URL;
if (!adminUrl || !appUrl) throw new Error("Нужны DATABASE_URL и APP_DATABASE_URL (см. .env.example)");

const CLEANUP = `
  DELETE FROM audit_log WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN ('test-a','test-b'));
  DELETE FROM users WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN ('test-a','test-b'));
  DELETE FROM tenants WHERE slug IN ('test-a','test-b')`;

const admin = new pg.Pool({ connectionString: adminUrl });
const app = new pg.Pool({ connectionString: appUrl });
let a: string, b: string;

before(async () => {
  await migrate(adminUrl);
  await admin.query(CLEANUP);
  a = (await admin.query("INSERT INTO tenants (slug,name) VALUES ('test-a','Фабрика A') RETURNING id")).rows[0].id;
  b = (await admin.query("INSERT INTO tenants (slug,name) VALUES ('test-b','Фабрика B') RETURNING id")).rows[0].id;
  await withTenant(app, a, (c) => c.query("INSERT INTO users (tenant_id,email,full_name) VALUES ($1,'a@x.uz','Аня')", [a]));
  await withTenant(app, b, (c) => c.query("INSERT INTO users (tenant_id,email,full_name) VALUES ($1,'b@x.uz','Бек')", [b]));
});

after(async () => {
  await admin.query(CLEANUP);
  await admin.end();
  await app.end();
});

test("фабрика A видит только своих пользователей", async () => {
  const rows = (await withTenant(app, a, (c) => c.query("SELECT email FROM users"))).rows;
  assert.deepEqual(rows.map((r) => r.email), ["a@x.uz"]);
});

test("без фабрики в сессии не видно ничего", async () => {
  const rows = (await app.query("SELECT * FROM users")).rows;
  assert.equal(rows.length, 0);
});

test("нельзя вставить строку чужой фабрики", async () => {
  await assert.rejects(
    withTenant(app, a, (c) => c.query("INSERT INTO users (tenant_id,email,full_name) VALUES ($1,'x@x.uz','Чужой')", [b])),
  );
});

test("нельзя изменить или удалить данные чужой фабрики", async () => {
  const upd = await withTenant(app, a, (c) => c.query("UPDATE users SET full_name='взлом' WHERE email='b@x.uz'"));
  assert.equal(upd.rowCount, 0);
  const del = await withTenant(app, a, (c) => c.query("DELETE FROM users WHERE email='b@x.uz'"));
  assert.equal(del.rowCount, 0);
});

test("журнал действий только дополняется", async () => {
  await withTenant(app, a, (c) =>
    c.query("INSERT INTO audit_log (tenant_id,entity,action) VALUES ($1,'user','create')", [a]),
  );
  await assert.rejects(withTenant(app, a, (c) => c.query("UPDATE audit_log SET action='x'")));
  await assert.rejects(withTenant(app, a, (c) => c.query("DELETE FROM audit_log")));
});
