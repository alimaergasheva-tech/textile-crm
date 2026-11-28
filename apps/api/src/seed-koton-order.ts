import pg from "pg";

/**
 * Вносит экспортный заказ KOTON (SS26): 4 модели по 3000 шт., полотна «кулирная гладь 150» и «футер без начёса 280».
 * Источник: карточки моделей 6SAM10155MK, 6SAM10143MK (футболки) и заказы 750779 (свитшот), 750774 (брюки).
 * Фабрика — переменная TENANT_SLUG (по умолчанию demo-a). Повторный запуск ничего не меняет.
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error("Задайте DATABASE_URL (set -a; source .env; set +a)");
const slug = process.env.TENANT_SLUG ?? "demo-a";
const QTY = 3000;
const db = new pg.Client({ connectionString: url });
await db.connect();
const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows;

/** Делит итог по пропорциям (метод наибольших остатков), сумма всегда равна итогу. */
function split(total: number, ratio: Record<string, number>): Record<string, number> {
  const sum = Object.values(ratio).reduce((a, b) => a + b, 0);
  const raw = Object.entries(ratio).map(([k, r]) => ({ k, v: (total * r) / sum }));
  const out = raw.map((x) => ({ k: x.k, n: Math.floor(x.v), f: x.v - Math.floor(x.v) }));
  let left = total - out.reduce((a, b) => a + b.n, 0);
  for (const x of [...out].sort((a, b) => b.f - a.f)) { if (left-- > 0) x.n++; }
  return Object.fromEntries(out.map((x) => [x.k, x.n]));
}

try {
  await db.query("BEGIN");
  const t = (await q("SELECT id FROM tenants WHERE slug=$1", [slug]))[0];
  if (!t) throw new Error(`Нет фабрики ${slug}`);
  const tid: string = t.id;
  await db.query("UPDATE export_accessories SET price_usd=0.05, version=version+1 WHERE tenant_id=$1", [tid]); // вся фурнитура по $0.05
  const exist = (await q("SELECT id,number FROM export_orders WHERE tenant_id=$1 AND brand='KOTON' AND collection='SS26'", [tid]))[0];
  if (exist) { // заказ уже внесён: обновляем раскладку футболок по размерам
    await db.query("UPDATE export_fabrics SET price_usd_kg=6, version=version+1 WHERE tenant_id=$1 AND code IN ('JERSEY150','FOOTER280')", [tid]); // цена полотна $6/кг
    const sz = split(QTY, { XS: 1, S: 1, M: 1, L: 1, XL: 1, XXL: 1 });
    await db.query("UPDATE export_models SET size_qty=$2, spec=spec || $3::jsonb, version=version+1 WHERE order_id=$1 AND code IN ('6SAM10155MK','6SAM10143MK')", [exist.id, JSON.stringify(sz), JSON.stringify({ size_range: "XS–2XL" })]);
    await db.query("UPDATE export_orders SET target_exfactory='2027-03-05', calc_params=COALESCE(calc_params,'{}'::jsonb) || $2::jsonb, version=version+1 WHERE id=$1", [exist.id, JSON.stringify({ fabricOrderReserve: 0.1 })]);
    await db.query("UPDATE export_models SET ex_factory='2027-03-05' WHERE order_id=$1", [exist.id]);
    for (const [code, kg] of [["6SAM10155MK", 0.25], ["6SAM10143MK", 0.25], ["6SAM70009MK", 0.95], ["6SAM40020MK", 0.95]] as const)
      await db.query("UPDATE export_models SET spec=spec || $3::jsonb WHERE order_id=$1 AND code=$2", [exist.id, code, JSON.stringify({ kg_per_piece_top: kg })]);
    await db.query("COMMIT"); console.log(`Заказ ${exist.number} уже был: размеры футболок обновлены`, sz); process.exit(0);
  }
  const owner = (await q("SELECT id FROM users WHERE tenant_id=$1 ORDER BY created_at LIMIT 1", [tid]))[0]?.id ?? null;

  let client = (await q("SELECT id FROM clients WHERE tenant_id=$1 AND upper(name)='KOTON'", [tid]))[0]?.id;
  if (!client) client = (await q("INSERT INTO clients (tenant_id,name,type,owner_id) VALUES ($1,'KOTON','wholesale',$2) RETURNING id", [tid, owner]))[0].id;

  const fab = async (code: string, name: string, gsm: number) => {
    const ex = (await q("SELECT id FROM export_fabrics WHERE tenant_id=$1 AND code=$2", [tid, code]))[0]?.id;
    if (ex) return ex as string;
    return (await q("INSERT INTO export_fabrics (tenant_id,code,name,composition,gsm,kind,price_usd_kg) VALUES ($1,$2,$3,'100% хлопок',$4,'main',6) RETURNING id", [tid, code, name, gsm]))[0].id as string;
  };
  const jersey = await fab("JERSEY150", "Кулирная гладь 150 г/м²", 150);
  const footer = await fab("FOOTER280", "Футер без начёса 280 г/м²", 280);

  await db.query("UPDATE export_fabrics SET price_usd_kg=6, version=version+1 WHERE tenant_id=$1 AND code IN ('JERSEY150','FOOTER280')", [tid]); // цена полотна $6/кг
  const y = new Date().getFullYear();
  const n = Number((await q("SELECT count(*)::int AS n FROM export_orders WHERE tenant_id=$1", [tid]))[0].n) + 1;
  const number = `X-${y}-${String(n).padStart(4, "0")}`;
  const order = (await q(
    `INSERT INTO export_orders (tenant_id,number,client_id,brand,collection,incoterms,currency,target_exfactory,notes,created_by,calc_params)
     VALUES ($1,$2,$3,'KOTON','SS26','FOB','USD','2027-03-05',$4,$5,'{"fabricOrderReserve":0.1}') RETURNING id`,
    [tid, number, client,
     "KOTON SS26 (2026 Spring/Summer), MENSWEAR CASUAL. 4 модели по 3000 шт. Цена клиента: футболки $3.5, свитшот $7, штаны $8.5. В исходных заказах Koton (750774, 750779) указан срок на склад 07–13.01.2026, запрошенный термин 10.01.2026 — для этого заказа срок отгрузки — 05.03.2027.",
     owner]))[0].id;

  const tee = { top: jersey, size: split(QTY, { XS: 1, S: 1, M: 1, L: 1, XL: 1, XXL: 1 }) }; // раскладки по размерам в карточках нет — поровну
  const models = [
    { code: "6SAM10155MK", name: "TSHIRT SS (футболка, регуляр-фит, круглый вырез)", fabric: jersey, sizes: tee.size,
      spec: { kind: "T-shirt", client_price_usd: 3.5, kg_per_piece_top: 0.25, garment_class: "2046 TSHIRT SS", size_range: "XS–2XL", main_fabric: "Кулирная гладь 150 г/м², 100% хлопок", print: "принт: левое плечо, перед по центру, спина", source: "6SAM10155MK_TSHIRT_SS карточка модели" } },
    { code: "6SAM10143MK", name: "TSHIRT SS (футболка, регуляр-фит, круглый вырез)", fabric: jersey, sizes: tee.size,
      spec: { kind: "T-shirt", client_price_usd: 3.5, kg_per_piece_top: 0.25, garment_class: "2046 TSHIRT SS", size_range: "XS–2XL", main_fabric: "Кулирная гладь 150 г/м², 100% хлопок", source: "6SAM10143MK_TSHIRT_SS карточка модели" } },
    { code: "6SAM70009MK", name: "SWEATSHIRT (свитшот)", fabric: footer, sizes: split(QTY, { S: 2, M: 3, L: 3, XL: 2, XXL: 1 }),
      spec: { kind: "Sweatshirt", client_price_usd: 7, kg_per_piece_top: 0.95, garment_class: "SWEATSHIRTS", main_fabric: "Футер без начёса 280 г/м², 100% хлопок", colors: ["461 BORDO", "704 LACIVERT"], original_po: "750779, 2356 шт.", ratio: "S2 M3 L3 XL2 XXL1 по асорти Koton" } },
    { code: "6SAM40020MK", name: "SWEAT BOTTOMS (спортивные брюки)", fabric: footer, sizes: split(QTY, { S: 2, M: 3, L: 3, XL: 2 }),
      spec: { kind: "Sweat bottoms", client_price_usd: 8.5, kg_per_piece_top: 0.95, garment_class: "SWEAT BOTTOMS", main_fabric: "Футер без начёса 280 г/м², 100% хлопок", colors: ["704 LACIVERT", "876 HAKI", "924 ANTRASIT"], original_po: "750774, 3408 шт.", ratio: "S2 M3 L3 XL2 по асорти Koton" } },
  ];
  for (const [i, m] of models.entries()) {
    await db.query(
      `INSERT INTO export_models (tenant_id,order_id,code,fabric_top_id,size_qty,qty,trim_note,spec,sort,ex_factory) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'2027-03-05')`,
      [tid, order, m.code, m.fabric, JSON.stringify(m.sizes), QTY, m.name, JSON.stringify({ ...m.spec, name: m.name }), i + 1]);
  }
  await db.query("COMMIT");
  console.log(`Заказ ${number} внесён: KOTON SS26, 4 модели × ${QTY} = ${QTY * 4} шт.`);
} catch (e) {
  await db.query("ROLLBACK");
  throw e;
} finally {
  await db.end();
}
