import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrate } from "../src/db/migrate.ts";
import { withTenant } from "../src/db/tenant.ts";
import { applyMovement, reconcile, transfer } from "../src/warehouse/stock.ts";

const adminUrl = process.env.DATABASE_URL, appUrl = process.env.APP_DATABASE_URL;
if (!adminUrl || !appUrl) throw new Error("Нужны DATABASE_URL и APP_DATABASE_URL");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = new pg.Pool({ connectionString: appUrl });
const T = "(SELECT id FROM tenants WHERE slug IN ('wh-a','wh-b'))";
const CLEAN = ["stock_movements", "stock_balances", "fabric_rolls", "fabric_lots", "locations", "warehouses", "materials"]
  .map((t) => `DELETE FROM ${t} WHERE tenant_id IN ${T}`).join(";") + ";DELETE FROM tenants WHERE slug IN ('wh-a','wh-b')";
let a: string, b: string, mat: string, loc1: string, loc2: string, locB: string;

before(async () => {
  await migrate(adminUrl);
  await admin.query(CLEAN);
  a = (await admin.query("INSERT INTO tenants (slug,name) VALUES ('wh-a','A') RETURNING id")).rows[0].id;
  b = (await admin.query("INSERT INTO tenants (slug,name) VALUES ('wh-b','B') RETURNING id")).rows[0].id;
  await withTenant(app, a, async (c) => {
    const w = (await c.query("INSERT INTO warehouses (tenant_id,name,kind) VALUES ($1,'W','raw') RETURNING id", [a])).rows[0].id;
    loc1 = (await c.query("INSERT INTO locations (tenant_id,warehouse_id,code) VALUES ($1,$2,'A1') RETURNING id", [a, w])).rows[0].id;
    loc2 = (await c.query("INSERT INTO locations (tenant_id,warehouse_id,code) VALUES ($1,$2,'A2') RETURNING id", [a, w])).rows[0].id;
    mat = (await c.query("INSERT INTO materials (tenant_id,code,name,type,unit) VALUES ($1,'F1','Ткань','fabric','m') RETURNING id", [a])).rows[0].id;
  });
  await withTenant(app, b, async (c) => {
    const w = (await c.query("INSERT INTO warehouses (tenant_id,name,kind) VALUES ($1,'W','raw') RETURNING id", [b])).rows[0].id;
    locB = (await c.query("INSERT INTO locations (tenant_id,warehouse_id,code) VALUES ($1,$2,'B1') RETURNING id", [b, w])).rows[0].id;
  });
});
after(async () => { await admin.query(CLEAN); await admin.end(); await app.end(); });

const bal = (t: string) => withTenant(app, t, async (c) => Number((await c.query("SELECT COALESCE(sum(qty),0) q FROM stock_balances")).rows[0].q));

test("приход увеличивает остаток, расход больше остатка отклоняется", async () => {
  await withTenant(app, a, (c) => applyMovement(c, a, null, { type: "receipt", materialId: mat, locationId: loc1, qty: 100 }));
  assert.equal(await bal(a), 100);
  await assert.rejects(withTenant(app, a, (c) => applyMovement(c, a, null, { type: "issue", materialId: mat, locationId: loc1, qty: -101 })));
  assert.equal(await bal(a), 100);
});

test("гонка: два параллельных расхода по 70 из 100 — проходит только один", async () => {
  const run = () => withTenant(app, a, (c) => applyMovement(c, a, null, { type: "issue", materialId: mat, locationId: loc1, qty: -70 }));
  const res = await Promise.allSettled([run(), run()]);
  assert.equal(res.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(await bal(a), 30);
});

test("перемещение переносит остаток между ячейками, итог не меняется", async () => {
  await withTenant(app, a, (c) => transfer(c, a, null, loc1, loc2, { materialId: mat }, 10));
  assert.equal(await bal(a), 30);
  const rows = (await withTenant(app, a, (c) => c.query("SELECT location_id, qty::float8 q FROM stock_balances ORDER BY qty"))).rows;
  assert.deepEqual(rows.map((r) => r.q), [10, 20]);
});

test("сверка: баланс совпадает с движениями; испорченный баланс находится и чинится", async () => {
  assert.equal((await withTenant(app, a, (c) => reconcile(c, false))).length, 0);
  await admin.query("UPDATE stock_balances SET qty = qty + 5 WHERE location_id=$1", [loc2]);
  const diffs = await withTenant(app, a, (c) => reconcile(c, true));
  assert.equal(diffs.length, 1);
  assert.equal((await withTenant(app, a, (c) => reconcile(c, false))).length, 0);
});

test("журнал движений нельзя менять и удалять из приложения", async () => {
  await assert.rejects(withTenant(app, a, (c) => c.query("DELETE FROM stock_movements")));
  await assert.rejects(withTenant(app, a, (c) => c.query("UPDATE stock_movements SET qty = 1")));
});

test("другая фабрика не видит остатки и не может двигать чужую ячейку", async () => {
  assert.equal(await bal(b), 0);
  await assert.rejects(withTenant(app, b, (c) => applyMovement(c, b, null, { type: "receipt", materialId: mat, locationId: locB, qty: 1 })));
  await assert.rejects(withTenant(app, b, (c) => applyMovement(c, b, null, { type: "receipt", materialId: mat, locationId: loc1, qty: 1 })));
});
