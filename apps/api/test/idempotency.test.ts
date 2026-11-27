import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrate } from "../src/db/migrate.ts";
import { withTenant } from "../src/db/tenant.ts";
import { idem } from "../src/production/flow.ts";

const adminUrl = process.env.DATABASE_URL, appUrl = process.env.APP_DATABASE_URL;
if (!adminUrl || !appUrl) throw new Error("Нужны DATABASE_URL и APP_DATABASE_URL");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = new pg.Pool({ connectionString: appUrl });
let a: string;
const CLEAN = "DELETE FROM idempotency_keys WHERE tenant_id IN (SELECT id FROM tenants WHERE slug='idem-a'); DELETE FROM tenants WHERE slug='idem-a'";

before(async () => { await migrate(adminUrl); await admin.query(CLEAN); a = (await admin.query("INSERT INTO tenants (slug,name) VALUES ('idem-a','A') RETURNING id")).rows[0].id; });
after(async () => { await admin.query(CLEAN); await admin.end(); await app.end(); });

test("повтор с тем же ключом не выполняет действие второй раз", async () => {
  let runs = 0;
  const call = () => withTenant(app, a, (c) => idem(c, a, "00000000-0000-0000-0000-000000000001", "key-1", async () => ({ n: ++runs })));
  const first = await call(), second = await call();
  assert.equal(runs, 1);
  assert.deepEqual(first, second);
});
test("параллельные повторы выполняются один раз", async () => {
  let runs = 0;
  const call = () => withTenant(app, a, (c) => idem(c, a, "00000000-0000-0000-0000-000000000001", "key-2", async () => { runs++; await new Promise((r) => setTimeout(r, 100)); return { ok: true }; }));
  await Promise.all([call(), call(), call()]);
  assert.equal(runs, 1);
});
test("разные ключи — разные действия", async () => {
  let runs = 0;
  for (const k of ["k-a", "k-b"]) await withTenant(app, a, (c) => idem(c, a, "00000000-0000-0000-0000-000000000001", k, async () => ++runs));
  assert.equal(runs, 2);
});
