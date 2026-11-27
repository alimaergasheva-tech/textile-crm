import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrate } from "../src/db/migrate.ts";
import { DbService } from "../src/db/db.service.ts";
import { AuditService } from "../src/audit/audit.service.ts";
import { ContractorsController } from "../src/production/contractors.controller.ts";

const adminUrl = process.env.DATABASE_URL;
if (!adminUrl || !process.env.APP_DATABASE_URL) throw new Error("Нужны DATABASE_URL и APP_DATABASE_URL");
const admin = new pg.Pool({ connectionString: adminUrl });
const db = new DbService();
const ctl = new ContractorsController(db, new AuditService());
const T = "(SELECT id FROM tenants WHERE slug='ct-a')";
const CLEAN = ["audit_log", "idempotency_keys", "contractor_receipts", "contractor_transfers", "step_reports", "production_steps", "production_items", "production_orders", "order_items", "orders", "contractors", "variants", "models", "sizes", "size_grids", "colors", "clients", "users"]
  .map((t) => `DELETE FROM ${t} WHERE tenant_id IN ${T}`).join(";") + ";DELETE FROM tenants WHERE slug='ct-a'";
let tid: string, user: string, step: string, po: string, other: string;
const req = () => ({ user: { id: user, tenantId: tid, perms: new Map() }, ip: "127.0.0.1" }) as any;

before(async () => {
  await migrate(adminUrl);
  await admin.query(CLEAN);
  const q = async (sql: string, p: unknown[]) => (await admin.query(sql, p)).rows[0].id as string;
  tid = await q("INSERT INTO tenants (slug,name) VALUES ('ct-a','A') RETURNING id", []);
  user = await q("INSERT INTO users (tenant_id,email,full_name) VALUES ($1,'u@ct.test','U') RETURNING id", [tid]);
  const client = await q("INSERT INTO clients (tenant_id,name) VALUES ($1,'К') RETURNING id", [tid]);
  const order = await q("INSERT INTO orders (tenant_id,number,client_id,currency,total) VALUES ($1,'O-1',$2,'UZS',0) RETURNING id", [tid, client]);
  const grid = await q("INSERT INTO size_grids (tenant_id,name) VALUES ($1,'g') RETURNING id", [tid]);
  const size = await q("INSERT INTO sizes (tenant_id,grid_id,label,sort) VALUES ($1,$2,'M',1) RETURNING id", [tid, grid]);
  const color = await q("INSERT INTO colors (tenant_id,code,name_ru) VALUES ($1,'R','Красный') RETURNING id", [tid]);
  const model = await q("INSERT INTO models (tenant_id,code,name,size_grid_id) VALUES ($1,'M1','М',$2) RETURNING id", [tid, grid]);
  const variant = await q("INSERT INTO variants (tenant_id,model_id,size_id,color_id,sku,barcode) VALUES ($1,$2,$3,$4,'S1','1') RETURNING id", [tid, model, size, color]);
  po = await q("INSERT INTO production_orders (tenant_id,number,order_id,model_id,status) VALUES ($1,'P-1',$2,$3,'in_progress') RETURNING id", [tid, order, model]);
  await admin.query("INSERT INTO production_items (tenant_id,production_order_id,variant_id,planned_qty) VALUES ($1,$2,$3,100)", [tid, po, variant]);
  const ct = await q("INSERT INTO contractors (tenant_id,name) VALUES ($1,'Подрядчик') RETURNING id", [tid]);
  step = await q("INSERT INTO production_steps (tenant_id,production_order_id,step,name,assignee_type,contractor_id) VALUES ($1,$2,1,'Пошив','contractor',$3) RETURNING id", [tid, po, ct]);
  other = await q("INSERT INTO production_steps (tenant_id,production_order_id,step,name) VALUES ($1,$2,2,'Без подрядчика') RETURNING id", [tid, po]);
});
after(async () => { await admin.query(CLEAN); await admin.end(); await db.pool.end(); });

test("передача кроя: не больше плана, повтор с тем же ключом не дублирует", async () => {
  await ctl.transfer(req(), step, { qty: 60 }, "t1");
  await ctl.transfer(req(), step, { qty: 60 }, "t1");            // повтор
  assert.equal(Number((await admin.query("SELECT sum(qty) n FROM contractor_transfers WHERE step_id=$1", [step])).rows[0].n), 60);
  await assert.rejects(ctl.transfer(req(), step, { qty: 50 }), /Больше плана/);
  await assert.rejects(ctl.transfer(req(), other, { qty: 1 }), /не назначен подрядчику/);
});

test("привезти можно только то, что на руках у подрядчика", async () => {
  await assert.rejects(ctl.receive(req(), step, { qty: 61 }), /на руках 60/);
  await ctl.receive(req(), step, { qty: 40 });
  await assert.rejects(ctl.receive(req(), step, { qty: 21 }), /на руках 20/);
});

test("приёмка ОТК: годные + брак = привезённому, годные идут в выполнение этапа", async () => {
  const [r] = await ctl.receipts(req());
  await assert.rejects(ctl.accept(req(), r.id, { good: 30, defect: 5 }), /должны дать 40/);
  await ctl.accept(req(), r.id, { good: 36, defect: 4, reasonCode: "seam" }, "a1");
  await ctl.accept(req(), r.id, { good: 36, defect: 4 }, "a1");   // повтор из очереди
  assert.equal(Number((await admin.query("SELECT sum(qty) n FROM step_reports WHERE step_id=$1", [step])).rows[0].n), 36);
  await assert.rejects(ctl.accept(req(), r.id, { good: 36, defect: 4 }), /Уже принято/);
  const h = (await ctl.holdings(req())).find((x: any) => x.step_id === step);
  assert.equal(h.transferred, 60); assert.equal(h.accepted, 36); assert.equal(h.defect, 4); assert.equal(h.at_contractor, 20);
});

test("этап закрывается, когда принятые годные достигли плана", async () => {
  await ctl.transfer(req(), step, { qty: 40 });                   // всего передано 100
  await ctl.receive(req(), step, { qty: 60 });
  const [r] = await ctl.receipts(req());
  const res = await ctl.accept(req(), r.id, { good: 60, defect: 0 });
  assert.equal(res.stepDone, false);                              // 36 + 60 = 96 < 100 (4 брака)
  assert.equal((await admin.query("SELECT status FROM production_steps WHERE id=$1", [step])).rows[0].status, "in_progress");
});
