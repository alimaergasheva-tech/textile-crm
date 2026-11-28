import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrate } from "../src/db/migrate.ts";
import { DbService } from "../src/db/db.service.ts";
import { AuditService } from "../src/audit/audit.service.ts";
import { TasksController } from "../src/crm/tasks.controller.ts";
import { DepartmentsController } from "../src/departments/departments.controller.ts";
import { LocksController } from "../src/locks/locks.controller.ts";
import { RealtimeController } from "../src/realtime/realtime.controller.ts";

// Этап 9.5: отделы, видимость задач отдела, оптимистичная блокировка при 10 одновременных пользователях,
// мягкие замки, лента изменений, изоляция фабрик.
const adminUrl = process.env.DATABASE_URL;
if (!adminUrl || !process.env.APP_DATABASE_URL) throw new Error("Нужны DATABASE_URL и APP_DATABASE_URL");
const admin = new pg.Pool({ connectionString: adminUrl });
const db = new DbService();
const audit = new AuditService();
const tasks = new TasksController(db, audit);
const depts = new DepartmentsController(db, audit);
const locks = new LocksController(db);
const events = new RealtimeController(db);
const SLUGS = "('dp-a','dp-b')";
const CLEAN = ["audit_log", "realtime_events", "edit_locks", "tasks", "user_departments", "departments", "users"]
  .map((t) => `DELETE FROM ${t} WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN ${SLUGS})`).join(";") + `;DELETE FROM tenants WHERE slug IN ${SLUGS}`;

let tA: string, tB: string, users: string[] = [], deptSales: string, deptVed: string, outsider: string, otherTenantUser: string;
const as = (id: string, tenantId = tA, own = false) =>
  ({ user: { id, tenantId, perms: new Map<string, boolean>([["tasks.view", own], ["tasks.edit", own], ["tasks.create", own]]) }, ip: "127.0.0.1" }) as any;

before(async () => {
  await migrate(adminUrl);
  await admin.query(CLEAN);
  const q = async (sql: string, p: unknown[]) => (await admin.query(sql, p)).rows[0].id as string;
  tA = await q("INSERT INTO tenants (slug,name) VALUES ('dp-a','A') RETURNING id", []);
  tB = await q("INSERT INTO tenants (slug,name) VALUES ('dp-b','B') RETURNING id", []);
  for (let i = 0; i < 10; i++) users.push(await q("INSERT INTO users (tenant_id,email,full_name) VALUES ($1,$2,$3) RETURNING id", [tA, `u${i}@dp.test`, `Сотрудник ${i}`]));
  outsider = await q("INSERT INTO users (tenant_id,email,full_name) VALUES ($1,'out@dp.test','Чужой отдел') RETURNING id", [tA]);
  otherTenantUser = await q("INSERT INTO users (tenant_id,email,full_name) VALUES ($1,'b@dp.test','Б') RETURNING id", [tB]);
  deptSales = await q("INSERT INTO departments (tenant_id,code,name) VALUES ($1,'sales','Продажи') RETURNING id", [tA]);
  deptVed = await q("INSERT INTO departments (tenant_id,code,name) VALUES ($1,'ved','ВЭД') RETURNING id", [tA]);
});
after(async () => { await admin.query(CLEAN); await admin.end(); await db.pool.end(); });

test("отделы: состав задаётся целиком, «мои отделы», пользователь другой фабрики не добавляется", async () => {
  await depts.setMembers(as(users[0]), deptVed, { userIds: [users[0], users[1]] });
  assert.deepEqual((await depts.mine(as(users[0]))).map((d: any) => d.code), ["ved"]);
  assert.equal((await depts.mine(as(outsider))).length, 0);
  await depts.setMembers(as(users[0]), deptVed, { userIds: [users[0]] });            // замена состава
  assert.equal((await depts.mine(as(users[1]))).length, 0);
  await assert.rejects(depts.setMembers(as(users[0]), deptVed, { userIds: [otherTenantUser] }));
  const list = await depts.list(as(users[0]));
  assert.equal(list.length, 2);
});

test("задачи отдела видны участникам отдела даже при праве «только свои», чужим — нет", async () => {
  const { id } = await tasks.create(as(users[0]), { title: "Подготовить упаковочный лист", departmentId: deptVed, assigneeId: users[0] });
  await depts.setMembers(as(users[0]), deptVed, { userIds: [users[0], users[1]] });
  const mineOnly = (uid: string) => tasks.list(as(uid, tA, true), "0", undefined, undefined, undefined, deptVed);
  assert.equal((await mineOnly(users[1])).length, 1, "участник отдела видит задачу отдела");
  assert.equal((await mineOnly(outsider)).length, 0, "посторонний не видит");
  await assert.rejects(tasks.update(as(outsider, tA, true), id, { title: "взлом" }), /Not Found|404|not found/i);
  const s = await tasks.summary(as(users[1], tA, true), deptVed);
  assert.equal(s.open, 1);
});

test("10 пользователей одновременно меняют РАЗНЫЕ задачи — потерь нет, версии растут", async () => {
  const ids = await Promise.all(users.map((u, i) => tasks.create(as(u), { title: `Задача ${i}`, assigneeId: u }).then((r: any) => r.id)));
  const res = await Promise.all(ids.map((id, i) => tasks.update(as(users[i]), id, { version: 1, status: "in_progress" })));
  assert.ok(res.every((r: any) => r.version === 2));
  const n = (await admin.query("SELECT count(*)::int n FROM tasks WHERE tenant_id=$1 AND status='in_progress' AND version=2", [tA])).rows[0].n;
  assert.equal(n, 10);
});

test("10 пользователей одновременно меняют ОДНУ задачу с одной версией — проходит ровно одна правка, остальные получают 409", async () => {
  const { id } = await tasks.create(as(users[0]), { title: "Общая задача" });
  const out = await Promise.allSettled(users.map((u, i) => tasks.update(as(u), id, { version: 1, title: `Правка ${i}` })));
  assert.equal(out.filter((o) => o.status === "fulfilled").length, 1);
  const rej = out.filter((o) => o.status === "rejected") as PromiseRejectedResult[];
  assert.equal(rej.length, 9);
  assert.ok(rej.every((r) => /уже изменена/.test(JSON.stringify((r.reason as any).getResponse?.() ?? r.reason.message))));
  assert.equal((await admin.query("SELECT version FROM tasks WHERE id=$1", [id])).rows[0].version, 2);
});

test("статус «заблокирована» хранит причину, «выполнена» ставит done_at, возврат снимает его", async () => {
  const { id } = await tasks.create(as(users[0]), { title: "Ждём ГТД" });
  await tasks.update(as(users[0]), id, { status: "blocked", blockedReason: "Нет инвойса" });
  let t = (await admin.query("SELECT status,blocked_reason,done_at FROM tasks WHERE id=$1", [id])).rows[0];
  assert.deepEqual([t.status, t.blocked_reason, t.done_at], ["blocked", "Нет инвойса", null]);
  await tasks.update(as(users[0]), id, { done: true });
  t = (await admin.query("SELECT status,blocked_reason,done_at FROM tasks WHERE id=$1", [id])).rows[0];
  assert.equal(t.status, "done"); assert.ok(t.done_at); assert.equal(t.blocked_reason, null);
  await tasks.update(as(users[0]), id, { done: false });
  assert.equal((await admin.query("SELECT done_at FROM tasks WHERE id=$1", [id])).rows[0].done_at, null);
});

test("просроченные задачи: флаг, дни просрочки, фильтр overdue", async () => {
  const { id } = await tasks.create(as(users[0]), { title: "Просрочена", dueAt: new Date(Date.now() - 3 * 86400_000).toISOString() });
  const rows = await tasks.list(as(users[0]), undefined, undefined, undefined, undefined, undefined, undefined, "1");
  const t = rows.find((r: any) => r.id === id);
  assert.ok(t && t.is_overdue && t.delay_days >= 2);
  assert.ok(rows.every((r: any) => r.is_overdue));
});

test("мягкие замки: второй не может занять, владелец продлевает, истёкший замок можно забрать", async () => {
  const { id } = await tasks.create(as(users[0]), { title: "Под замок" });
  const r1 = await locks.acquire(as(users[0]), { entity: "task", entityId: id });
  assert.equal(r1.locked, true);
  await assert.rejects(locks.acquire(as(users[1]), { entity: "task", entityId: id }), /Сейчас редактирует Сотрудник 0/);
  await locks.acquire(as(users[0]), { entity: "task", entityId: id });                 // продление
  assert.equal((await locks.list(as(users[2]), "task")).filter((l: any) => l.entity_id === id).length, 1);
  await locks.release(as(users[1]), "task", id);                                       // чужой замок не снимается
  assert.equal((await admin.query("SELECT count(*)::int n FROM edit_locks WHERE entity_id=$1", [id])).rows[0].n, 1);
  await admin.query("UPDATE edit_locks SET expires_at = now() - interval '1 second' WHERE entity_id=$1", [id]);
  assert.equal((await locks.acquire(as(users[1]), { entity: "task", entityId: id })).locked, true);   // забрал после истечения
  assert.equal((await locks.release(as(users[1]), "task", id)).released, true);
});

test("10 пользователей одновременно пытаются занять один объект — замок получает ровно один", async () => {
  const { id } = await tasks.create(as(users[0]), { title: "Гонка за замок" });
  const out = await Promise.allSettled(users.map((u) => locks.acquire(as(u), { entity: "task", entityId: id })));
  assert.equal(out.filter((o) => o.status === "fulfilled").length, 1);
});

test("лента изменений: курсор, события после правки, фабрика B ничего не видит", async () => {
  const start = await events.feed(as(users[0]));
  assert.equal(start.events.length, 0);
  const { id } = await tasks.create(as(users[0]), { title: "Событие", departmentId: deptSales });
  await tasks.update(as(users[0]), id, { status: "in_progress" });
  const f = await events.feed(as(users[1]), start.cursor);
  const kinds = f.events.filter((e: any) => e.entity_id === id).map((e: any) => e.kind);
  assert.deepEqual(kinds, ["created", "updated"]);
  assert.ok(Number(f.cursor) > Number(start.cursor));
  const again = await events.feed(as(users[1]), f.cursor);
  assert.equal(again.events.length, 0);
  const b = await events.feed(as(otherTenantUser, tB), "0");
  assert.equal(b.events.length, 0, "события одной фабрики не видны другой");
});
