import pg from "pg";
import { applyMovement } from "./warehouse/stock.ts";

/** Демо-остатки для demo-a: сырьё, партия ткани с рулонами, готовая продукция. Повторный запуск ничего не делает. */
const url = process.env.DATABASE_URL;
if (!url) throw new Error("Задайте DATABASE_URL");
const db = new pg.Client({ connectionString: url });
await db.connect();
const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows;

try {
  await db.query("BEGIN");
  const t = (await q("SELECT id FROM tenants WHERE slug='demo-a'"))[0];
  if (!t) throw new Error("Нет фабрики demo-a");
  const tid: string = t.id;
  if ((await q("SELECT 1 FROM stock_movements WHERE tenant_id=$1 LIMIT 1", [tid])).length) { console.log("Остатки уже есть"); await db.query("ROLLBACK"); process.exit(0); }
  const mats = (await q("SELECT id,code FROM materials WHERE tenant_id=$1", [tid]));
  if (!mats.length) throw new Error("Сначала выполните db:seed-demo");
  const loc = async (kind: string) => (await q("SELECT l.id FROM locations l JOIN warehouses w ON w.id=l.warehouse_id WHERE l.tenant_id=$1 AND w.kind=$2 ORDER BY l.code LIMIT 1", [tid, kind]))[0].id;
  const raw = await loc("raw"), fin = await loc("finished");
  const c = db as unknown as pg.PoolClient;
  const owner = (await q("SELECT id FROM users WHERE tenant_id=$1 AND email='owner@demo-a.uz'", [tid]))[0]?.id ?? null;
  const m = (code: string) => mats.find((x) => x.code === code)?.id as string | undefined;

  // Ткань партией: рулоны
  const fab = m("FAB-COT");
  if (fab) {
    const lot = (await q("INSERT INTO fabric_lots (tenant_id,material_id,lot_number,color_name,shade,width_cm,density_gsm,supplier) VALUES ($1,$2,'L-2026-001','Белый','A',180,180,'Демо-поставщик') RETURNING id", [tid, fab]))[0].id;
    for (const [i, kg] of [48.5, 50.2, 47.8, 51].entries()) {
      const roll = (await q("INSERT INTO fabric_rolls (tenant_id,lot_id,roll_no,qty_initial,qty_remaining,barcode,location_id) VALUES ($1,$2,$3,$4,0,$5,$6) RETURNING id", [tid, lot, String(i + 1), kg, `RLDEMO${i + 1}`, raw]))[0].id;
      await applyMovement(c, tid, owner, { type: "receipt", materialId: fab, lotId: lot, rollId: roll, locationId: raw, qty: kg, docType: "fabric_lot", docId: lot });
    }
  }
  for (const [code, qty] of [["FAB-FLC", 120], ["FAB-TWL", 80], ["THR-40", 400], ["ZIP-60", 150], ["BTN-18", 2500], ["PKG-BAG", 3000], ["LBL-MAIN", 600]] as [string, number][])
    if (m(code)) await applyMovement(c, tid, owner, { type: "receipt", materialId: m(code), locationId: raw, qty, comment: "Начальный остаток" });

  // Готовая продукция: белые варианты T-001
  const vs = await q(`SELECT v.id FROM variants v JOIN models mo ON mo.id=v.model_id WHERE mo.tenant_id=$1 AND mo.code='T-001' AND v.sku LIKE '%-WHT-%' ORDER BY v.sku`, [tid]);
  for (const [i, v] of vs.entries())
    await applyMovement(c, tid, owner, { type: "receipt", variantId: v.id, locationId: fin, qty: 40 + i * 10, comment: "Начальный остаток" });
  if (vs[0]) await db.query("INSERT INTO reservations (tenant_id,variant_id,qty,note,created_by) VALUES ($1,$2,15,'Под КП',$3)", [tid, vs[0].id, owner]);

  await db.query("COMMIT");
  console.log("Демо-остатки созданы");
} catch (e) {
  await db.query("ROLLBACK");
  throw e;
} finally {
  await db.end();
}
