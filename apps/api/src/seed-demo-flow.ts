import pg from "pg";
import { plan } from "./export-orders/aql.ts";

/**
 * ТЕСТОВЫЙ заказ для проверки всей цепочки (производство → AQL → логистика → отгрузка → документы ВЭД).
 * Бренд «ТЕСТ», клиент «ТЕСТ-КЛИЕНТ»: к реальным заказам не относится. Данные выдуманные, фото в отчёте AQL — условная картинка.
 * Создать: pnpm --filter @textile/api db:demo-flow    Удалить: TEST_REMOVE=1 pnpm --filter @textile/api db:demo-flow
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error("Задайте DATABASE_URL (set -a; source .env; set +a)");
const slug = process.env.TENANT_SLUG ?? "demo-a";
const db = new pg.Client({ connectionString: url });
await db.connect();
const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

try {
  await db.query("BEGIN");
  const tid: string = (await q("SELECT id FROM tenants WHERE slug=$1", [slug]))[0]?.id;
  if (!tid) throw new Error(`Нет фабрики ${slug}`);
  const exist = (await q("SELECT id,number FROM export_orders WHERE tenant_id=$1 AND brand='ТЕСТ' AND collection='DEMO-FLOW'", [tid]))[0];
  if (process.env.TEST_REMOVE) {
    if (exist) {
      await db.query("DELETE FROM export_orders WHERE id=$1", [exist.id]);
      await db.query("DELETE FROM clients WHERE tenant_id=$1 AND name='ТЕСТ-КЛИЕНТ'", [tid]);
    }
    await db.query("COMMIT"); console.log(exist ? `Тестовый заказ ${exist.number} удалён` : "Тестового заказа нет"); process.exit(0);
  }
  if (exist) { await db.query("COMMIT"); console.log(`Тестовый заказ уже есть: ${exist.number}`); process.exit(0); }
  const owner = (await q("SELECT id FROM users WHERE tenant_id=$1 ORDER BY created_at LIMIT 1", [tid]))[0]?.id ?? null;
  const client = (await q("INSERT INTO clients (tenant_id,name,type,owner_id,address,tax_id) VALUES ($1,'ТЕСТ-КЛИЕНТ','wholesale',$2,'Test Street 1, New York, USA','TEST-000') RETURNING id", [tid, owner]))[0].id;
  const n = Number((await q("SELECT count(*)::int AS n FROM export_orders WHERE tenant_id=$1", [tid]))[0].n) + 1;
  const number = `X-${new Date().getFullYear()}-${String(n).padStart(4, "0")}`;
  const order = (await q(
    `INSERT INTO export_orders (tenant_id,number,client_id,brand,collection,incoterms,currency,target_exfactory,status,notes,created_by)
     VALUES ($1,$2,$3,'ТЕСТ','DEMO-FLOW','FCA','USD',current_date + 30,'in_production',$4,$5) RETURNING id`,
    [tid, number, client, "ТЕСТОВЫЙ заказ для проверки цепочки. Данные выдуманные. Удаление: TEST_REMOVE=1 pnpm --filter @textile/api db:demo-flow", owner]))[0].id;
  const models = [
    { code: "TEST-T1", qty: 1000, price: 3.5, kind: "T-shirt", hs: "6109100000", pcs: 50, dims: [60, 40, 40], kg: 14 },
    { code: "TEST-S1", qty: 500, price: 7, kind: "Sweatshirt", hs: "6110209900", pcs: 20, dims: [60, 40, 40], kg: 20 },
  ];
  for (const [i, m] of models.entries()) {
    const mid = (await q(
      "INSERT INTO export_models (tenant_id,order_id,code,qty,spec,sort,ex_factory) VALUES ($1,$2,$3,$4,$5,$6,current_date + 30) RETURNING id",
      [tid, order, m.code, m.qty, JSON.stringify({ kind: m.kind, client_price_usd: m.price, test: true }), i]))[0].id;
    for (const stage of ["cut", "sew", "pack"]) // всё произведено и упаковано
      await db.query("INSERT INTO export_production_log (tenant_id,order_id,model_id,stage,day,qty,note,created_by) VALUES ($1,$2,$3,$4,current_date,$5,'тест',$6)", [tid, order, mid, stage, m.qty, owner]);
    await db.query("INSERT INTO export_pack_specs (tenant_id,model_id,pcs_per_carton,carton_l_cm,carton_w_cm,carton_h_cm,carton_kg) VALUES ($1,$2,$3,$4,$5,$6,$7)", [tid, mid, m.pcs, m.dims[0], m.dims[1], m.dims[2], m.kg]);
    const pm = plan(m.qty, 2.5), pn = plan(m.qty, 4);
    const ins = (await q(
      `INSERT INTO export_inspections (tenant_id,order_id,model_id,round,status,inspected_on,inspector,lot_qty,sample_size,aql_major,aql_minor,ac_major,re_major,ac_minor,re_minor,finalized_at,finalized_by,created_by)
       VALUES ($1,$2,$3,1,'final',current_date,'Тест Инспектор',$4,$5,2.5,4,$6,$7,$8,$9,now(),$10,$10) RETURNING id`,
      [tid, order, mid, m.qty, pm.sampleSize, pm.ac, pm.re, pn.ac, pn.re, owner]))[0].id;
    await db.query("INSERT INTO export_inspection_defects (tenant_id,inspection_id,defect,severity,qty,sort) VALUES ($1,$2,'Незначительная нитка','minor',1,0)", [tid, ins]);
    await db.query("INSERT INTO export_inspection_photos (tenant_id,inspection_id,caption,mime,data) VALUES ($1,$2,'ТЕСТ (условное фото)','image/png',decode($3,'base64'))", [tid, ins, PNG]);
  }
  await db.query("COMMIT");
  console.log(`Создан тестовый заказ ${number} (ТЕСТ / DEMO-FLOW): всё упаковано, AQL «принято». Откройте его → «Логистика» → «Создать отгрузки из плана».`);
} catch (e) { await db.query("ROLLBACK"); throw e; } finally { await db.end(); }
