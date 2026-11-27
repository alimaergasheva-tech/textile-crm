import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrate } from "../src/db/migrate.ts";
import { withTenant } from "../src/db/tenant.ts";

const adminUrl = process.env.DATABASE_URL, appUrl = process.env.APP_DATABASE_URL;
if (!adminUrl || !appUrl) throw new Error("Нужны DATABASE_URL и APP_DATABASE_URL");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = new pg.Pool({ connectionString: appUrl });
const SLUGS = "('crm-a','crm-b')";
const CLEAN = `
  DELETE FROM interactions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN ${SLUGS});
  DELETE FROM deals WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN ${SLUGS});
  DELETE FROM clients WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN ${SLUGS});
  DELETE FROM pipeline_stages WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN ${SLUGS});
  DELETE FROM tenants WHERE slug IN ${SLUGS}`;
let a: string, b: string, clientB: string;

before(async () => {
  await migrate(adminUrl);
  await admin.query(CLEAN);
  a = (await admin.query("INSERT INTO tenants (slug,name) VALUES ('crm-a','A') RETURNING id")).rows[0].id;
  b = (await admin.query("INSERT INTO tenants (slug,name) VALUES ('crm-b','B') RETURNING id")).rows[0].id;
  clientB = await withTenant(app, b, async (c) =>
    (await c.query("INSERT INTO clients (tenant_id,name) VALUES ($1,'Клиент B') RETURNING id", [b])).rows[0].id);
  await withTenant(app, a, (c) => c.query("INSERT INTO clients (tenant_id,name) VALUES ($1,'Клиент A')", [a]));
});
after(async () => { await admin.query(CLEAN); await admin.end(); await app.end(); });

test("фабрика A видит только своих клиентов", async () => {
  const rows = (await withTenant(app, a, (c) => c.query("SELECT name FROM clients"))).rows;
  assert.deepEqual(rows.map((r) => r.name), ["Клиент A"]);
});

test("сделку нельзя создать на клиента другой фабрики", async () => {
  const stage = await withTenant(app, a, async (c) =>
    (await c.query("INSERT INTO pipeline_stages (tenant_id,name,kind) VALUES ($1,'Тест','open') RETURNING id", [a])).rows[0].id);
  await assert.rejects(withTenant(app, a, (c) =>
    c.query("INSERT INTO deals (tenant_id,title,client_id,stage_id) VALUES ($1,'x',$2,$3)", [a, clientB, stage])));
});

test("чужого клиента не изменить и не удалить", async () => {
  const u = await withTenant(app, a, (c) => c.query("UPDATE clients SET name='взлом' WHERE id=$1", [clientB]));
  const d = await withTenant(app, a, (c) => c.query("DELETE FROM clients WHERE id=$1", [clientB]));
  assert.equal(u.rowCount, 0); assert.equal(d.rowCount, 0);
});
