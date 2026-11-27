import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import jwt from "jsonwebtoken";
import { migrate } from "../src/db/migrate.ts";
import { DbService } from "../src/db/db.service.ts";
import { AuditService } from "../src/audit/audit.service.ts";
import { ClientPortalController } from "../src/portal/portal.controller.ts";
import { config } from "../src/config.ts";

const adminUrl = process.env.DATABASE_URL;
if (!adminUrl || !process.env.APP_DATABASE_URL) throw new Error("Нужны DATABASE_URL и APP_DATABASE_URL");
const admin = new pg.Pool({ connectionString: adminUrl });
const db = new DbService();
const portal = new ClientPortalController(db, new AuditService());
const T = "(SELECT id FROM tenants WHERE slug IN ('cp-a','cp-b'))";
const CLEAN = ["complaints", "feedback", "notifications", "idempotency_keys", "order_items", "orders", "client_accounts", "reservations", "prices", "price_lists", "variants", "models", "sizes", "size_grids", "colors", "clients"]
  .map((t) => `DELETE FROM ${t} WHERE tenant_id IN ${T}`).join(";") + ";DELETE FROM tenants WHERE slug IN ('cp-a','cp-b')";
let a: string, b: string, variant: string, c1: string, c2: string, acc1: string, acc2: string, accB: string;
const req = (acc: string, tid: string) => ({ headers: { authorization: `Bearer ${jwt.sign({ cli: acc, tid }, config.clientSecret(), { expiresIn: 60 })}` } });

before(async () => {
  await migrate(adminUrl);
  await admin.query(CLEAN);
  a = (await admin.query("INSERT INTO tenants (slug,name) VALUES ('cp-a','A') RETURNING id")).rows[0].id;
  b = (await admin.query("INSERT INTO tenants (slug,name) VALUES ('cp-b','B') RETURNING id")).rows[0].id;
  const q = async (sql: string, p: unknown[]) => (await admin.query(sql, p)).rows[0].id as string;
  c1 = await q("INSERT INTO clients (tenant_id,name,price_type) VALUES ($1,'Клиент 1','wholesale') RETURNING id", [a]);
  c2 = await q("INSERT INTO clients (tenant_id,name,price_type) VALUES ($1,'Клиент 2','wholesale') RETURNING id", [a]);
  const cb = await q("INSERT INTO clients (tenant_id,name) VALUES ($1,'Клиент B') RETURNING id", [b]);
  acc1 = await q("INSERT INTO client_accounts (tenant_id,client_id,name) VALUES ($1,$2,'Аккаунт 1') RETURNING id", [a, c1]);
  acc2 = await q("INSERT INTO client_accounts (tenant_id,client_id,name) VALUES ($1,$2,'Аккаунт 2') RETURNING id", [a, c2]);
  accB = await q("INSERT INTO client_accounts (tenant_id,client_id,name) VALUES ($1,$2,'Аккаунт B') RETURNING id", [b, cb]);
  const grid = await q("INSERT INTO size_grids (tenant_id,name) VALUES ($1,'g') RETURNING id", [a]);
  const size = await q("INSERT INTO sizes (tenant_id,grid_id,label,sort) VALUES ($1,$2,'M',1) RETURNING id", [a, grid]);
  const color = await q("INSERT INTO colors (tenant_id,code,name_ru) VALUES ($1,'RED','Красный') RETURNING id", [a]);
  const model = await q("INSERT INTO models (tenant_id,code,name,size_grid_id) VALUES ($1,'M1','Модель',$2) RETURNING id", [a, grid]);
  variant = await q("INSERT INTO variants (tenant_id,model_id,size_id,color_id,sku,barcode) VALUES ($1,$2,$3,$4,'M1-M-RED','111') RETURNING id", [a, model, size, color]);
  const pl = await q("INSERT INTO price_lists (tenant_id,name,price_type,currency) VALUES ($1,'Опт','wholesale','UZS') RETURNING id", [a]);
  await admin.query("INSERT INTO prices (tenant_id,price_list_id,model_id,amount) VALUES ($1,$2,$3,5000000)", [a, pl, model]);
});
after(async () => { await admin.query(CLEAN); await admin.end(); await db.pool.end(); });

test("токен сотрудника или чужой секрет не открывает клиентские данные", async () => {
  await assert.rejects(portal.orders({ headers: {} }));
  const bad = { headers: { authorization: `Bearer ${jwt.sign({ cli: acc1, tid: a }, "другой-секрет")}` } };
  await assert.rejects(portal.orders(bad));
});

test("заявка клиента: цена берётся на сервере, повтор с тем же ключом не дублирует", async () => {
  const r1 = await portal.create(req(acc1, a), { items: [{ variantId: variant, qty: 10 }], note: "срочно" }, "key-1");
  assert.equal(r1.status, "draft"); assert.equal(r1.total, 50000000);
  const r2 = await portal.create(req(acc1, a), { items: [{ variantId: variant, qty: 10 }] }, "key-1");
  assert.equal(r2.id, r1.id);
  assert.equal((await admin.query("SELECT count(*)::int n FROM orders WHERE client_id=$1", [c1])).rows[0].n, 1);
  const o = (await admin.query("SELECT source,status,created_by FROM orders WHERE id=$1", [r1.id])).rows[0];
  assert.deepEqual(o, { source: "client", status: "draft", created_by: null });
});

test("клиент видит только свои заказы; чужой заказ — 404", async () => {
  const mine = await portal.orders(req(acc1, a));
  assert.equal(mine.length, 1);
  assert.equal((await portal.orders(req(acc2, a))).length, 0);
  await assert.rejects(portal.order(req(acc2, a), mine[0].id), /Not Found/);
  await assert.rejects(portal.cancel(req(acc2, a), mine[0].id));
  await assert.rejects(portal.repeat(req(acc2, a), mine[0].id));
});

test("повтор заказа и отмена заявки", async () => {
  const [o] = await portal.orders(req(acc1, a));
  const again = await portal.repeat(req(acc1, a), o.id, "key-2");
  assert.notEqual(again.id, o.id);
  await portal.cancel(req(acc1, a), again.id);
  assert.equal((await admin.query("SELECT status FROM orders WHERE id=$1", [again.id])).rows[0].status, "cancelled");
  await assert.rejects(portal.cancel(req(acc1, a), again.id), /Отменить можно/);
});

test("рекламация только по своему заказу; оценка без отгрузки не принимается", async () => {
  const [o] = await portal.orders(req(acc1, a));
  await assert.rejects(portal.complain(req(acc2, a), { orderId: o.id, reasonCode: "quality", description: "Брак" }), /Заказ не найден/);
  const k = await portal.complain(req(acc1, a), { orderId: o.id, reasonCode: "quality", description: "Брак шва" }, "key-3");
  assert.match(k.number, /^C-\d{4}-\d{4}$/);
  await assert.rejects(portal.rate(req(acc1, a), o.id, { rating: 5 }), /не отгружен/);
});

test("отключённый аккаунт и заблокированная фабрика теряют доступ", async () => {
  await admin.query("UPDATE client_accounts SET is_active=false WHERE id=$1", [acc2]);
  await assert.rejects(portal.orders(req(acc2, a)));
  await admin.query("UPDATE tenants SET status='blocked' WHERE id=$1", [a]);
  await assert.rejects(portal.orders(req(acc1, a)));
  await admin.query("UPDATE tenants SET status='active' WHERE id=$1", [a]);
  assert.ok(await portal.orders(req(acc1, a)));
});

test("токен фабрики A не работает для аккаунта фабрики B", async () => {
  // аккаунт B с подставленным tid фабрики A: RLS не находит его, доступ закрыт
  await assert.rejects(portal.orders(req(accB, a)));
});
