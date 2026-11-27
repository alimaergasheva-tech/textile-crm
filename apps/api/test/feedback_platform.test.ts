import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import jwt from "jsonwebtoken";
import { Reflector } from "@nestjs/core";
import { migrate } from "../src/db/migrate.ts";
import { DbService } from "../src/db/db.service.ts";
import { AuditService } from "../src/audit/audit.service.ts";
import { AuthGuard } from "../src/auth/auth.guard.ts";
import { FeedbackController } from "../src/feedback/feedback.controller.ts";
import { UsersController } from "../src/users/users.controller.ts";
import { config } from "../src/config.ts";

const adminUrl = process.env.DATABASE_URL;
if (!adminUrl || !process.env.APP_DATABASE_URL) throw new Error("Нужны DATABASE_URL и APP_DATABASE_URL");
const admin = new pg.Pool({ connectionString: adminUrl });
const db = new DbService();
const audit = new AuditService();
const fb = new FeedbackController(db, audit);
const users = new UsersController(db, audit);

const T = "(SELECT id FROM tenants WHERE slug IN ('fb-a','fb-b'))";
const CLEAN = ["complaints", "feedback", "suggestions", "audit_log", "user_roles", "orders", "clients", "users"]
  .map((t) => `DELETE FROM ${t} WHERE tenant_id IN ${T}`).join(";") + ";DELETE FROM tenants WHERE slug IN ('fb-a','fb-b')";
let a: string, b: string, userA: string, order: string, tokenA: string;
const req = (tenantId: string, id: string) => ({ user: { id, tenantId, perms: new Map() }, ip: "127.0.0.1" }) as any;

before(async () => {
  await migrate(adminUrl);
  await admin.query(CLEAN);
  a = (await admin.query("INSERT INTO tenants (slug,name,max_users) VALUES ('fb-a','A',2) RETURNING id")).rows[0].id;
  b = (await admin.query("INSERT INTO tenants (slug,name) VALUES ('fb-b','B') RETURNING id")).rows[0].id;
  userA = (await admin.query("INSERT INTO users (tenant_id,email,full_name) VALUES ($1,'u1@a.test','U1') RETURNING id", [a])).rows[0].id;
  const client = (await admin.query("INSERT INTO clients (tenant_id,name) VALUES ($1,'К') RETURNING id", [a])).rows[0].id;
  order = (await admin.query("INSERT INTO orders (tenant_id,number,client_id,status,currency,total) VALUES ($1,'T-1',$2,'shipped','UZS',1000000) RETURNING id", [a, client])).rows[0].id;
  tokenA = `${a}.secret123`;
  await admin.query("INSERT INTO feedback (tenant_id,order_id,client_id,token,status,request_at) VALUES ($1,$2,$3,$4,'requested',now())", [a, order, client, tokenA]);
});
after(async () => { await admin.query(CLEAN); await admin.end(); await db.pool.end(); });

test("публичная оценка: принимается один раз, повтор отклоняется", async () => {
  assert.deepEqual(await fb.publicGet(tokenA), { orderNumber: "T-1", factory: "A", answered: false });
  await fb.publicPost(tokenA, { rating: 5, comment: "Отлично" });
  const r = (await admin.query("SELECT rating,status FROM feedback WHERE token=$1", [tokenA])).rows[0];
  assert.equal(r.rating, 5); assert.equal(r.status, "answered");
  await assert.rejects(fb.publicPost(tokenA, { rating: 1 }));
  await assert.rejects(fb.publicPost(tokenA, { rating: 6 }));
});

test("ссылка оценки не работает через чужую фабрику", async () => {
  // токен фабрики A с префиксом фабрики B: запрос идёт под RLS фабрики B и ничего не находит
  await assert.rejects(fb.publicGet(`${b}.secret123`));
  await assert.rejects(fb.publicGet("не-токен"));
});

test("рекламация: порядок статусов и решение «скидка» уменьшает долг заказа", async () => {
  const r = req(a, userA);
  const { id, number } = await fb.createComplaint(r, { orderId: order, reasonCode: "quality", description: "Брак шва" });
  assert.match(number, /^C-\d{4}-\d{4}$/);
  await assert.rejects(fb.setStatus(r, id, { status: "closed" }), /недопустим/);
  await fb.setStatus(r, id, { status: "in_progress" });
  await assert.rejects(fb.resolve(r, id, { type: "discount" }), /сумму/);
  await fb.resolve(r, id, { type: "discount", amount: 5000 });
  assert.equal(Number((await admin.query("SELECT discount FROM orders WHERE id=$1", [order])).rows[0].discount), 5000);
  await assert.rejects(fb.resolve(r, id, { type: "discount", amount: 1000 }), /уже решена/);
  await fb.setStatus(r, id, { status: "closed" });
  assert.equal((await admin.query("SELECT status FROM complaints WHERE id=$1", [id])).rows[0].status, "closed");
});

test("замена и возврат требуют модель и количество в рекламации", async () => {
  const r = req(a, userA);
  const { id } = await fb.createComplaint(r, { orderId: order, reasonCode: "quality" });
  await assert.rejects(fb.resolve(r, id, { type: "refund" }), /модель и количество/);
});

test("анонимное предложение не хранит автора ни в записи, ни в журнале", async () => {
  const r = req(a, userA);
  const { id } = await fb.suggest(r, { text: "Нужен второй вентилятор в цехе", anonymous: true });
  const row = (await admin.query("SELECT user_id FROM suggestions WHERE id=$1", [id])).rows[0];
  assert.equal(row.user_id, null);
  assert.equal((await admin.query("SELECT count(*)::int n FROM audit_log WHERE entity='suggestion' AND entity_id=$1", [id])).rows[0].n, 0);
});

test("лимит тарифа: сверх max_users пользователя создать нельзя", async () => {
  const r = req(a, userA);
  await users.create(r, { email: "u2@a.test", fullName: "U2", password: "password123" }); // 2 из 2
  await assert.rejects(users.create(r, { email: "u3@a.test", fullName: "U3", password: "password123" }), /Лимит тарифа/);
});

test("заблокированная фабрика: токен перестаёт работать сразу", async () => {
  const guard = new AuthGuard(new Reflector(), db);
  const token = jwt.sign({ sub: userA, tid: a }, config.jwtSecret(), { expiresIn: 60 });
  const ctx = (): any => ({ getHandler: () => () => 0, getClass: () => class {}, switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: `Bearer ${token}` } }) }) });
  assert.equal(await guard.canActivate(ctx()), true);
  await admin.query("UPDATE tenants SET status='blocked' WHERE id=$1", [a]);
  await assert.rejects(guard.canActivate(ctx()));
  await admin.query("UPDATE tenants SET status='active' WHERE id=$1", [a]);
  assert.equal(await guard.canActivate(ctx()), true);
});
