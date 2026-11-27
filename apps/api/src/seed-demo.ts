import pg from "pg";
import { ean13 } from "./catalog/ean.ts";

/** Демо-данные для фабрики demo-a: каталог, прайсы, клиенты, лиды, сделки, задачи, КП. Безопасно запускать повторно. */
const url = process.env.DATABASE_URL;
if (!url) throw new Error("Задайте DATABASE_URL");
const db = new pg.Client({ connectionString: url });
await db.connect();
const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows;

try {
  await db.query("BEGIN");
  const t = (await q("SELECT id FROM tenants WHERE slug='demo-a'"))[0];
  if (!t) throw new Error("Нет фабрики demo-a: сначала выполните db:seed");
  const tid: string = t.id;
  if ((await q("SELECT 1 FROM models WHERE tenant_id=$1 AND code='T-001'", [tid])).length) {
    console.log("Демо-данные уже есть, пропускаю");
    await db.query("ROLLBACK");
    process.exit(0);
  }
  const owner = (await q("SELECT id FROM users WHERE tenant_id=$1 AND email='owner@demo-a.uz'", [tid]))[0].id;
  const manager = (await q("SELECT id FROM users WHERE tenant_id=$1 AND email='manager@demo-a.uz'", [tid]))[0].id;

  // Курс валют
  await db.query("INSERT INTO exchange_rates (tenant_id,valid_from,uzs_per_usd,created_by) VALUES ($1,current_date,12700,$2) ON CONFLICT DO NOTHING", [tid, owner]);

  // Цвета
  const colors: Record<string, string> = {};
  for (const [code, ru, uz, en, tr, hex] of [["WHT", "Белый", "Oq", "White", "Beyaz", "#ffffff"], ["BLK", "Чёрный", "Qora", "Black", "Siyah", "#111111"],
    ["NVY", "Тёмно-синий", "To‘q ko‘k", "Navy", "Lacivert", "#1f2f5c"], ["RED", "Красный", "Qizil", "Red", "Kırmızı", "#c0392b"]])
    colors[code] = (await q("INSERT INTO colors (tenant_id,code,name_ru,name_uz,name_en,name_tr,hex) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id", [tid, code, ru, uz, en, tr, hex]))[0].id;

  // Материалы
  const mats: Record<string, string> = {};
  for (const [code, name, type, unit, min] of [
    ["FAB-COT", "Кулирка хлопок 180 г", "fabric", "kg", 200], ["FAB-FLC", "Футер с начёсом 280 г", "fabric", "kg", 300],
    ["FAB-TWL", "Ткань смесовая (рабочая)", "fabric", "m", 500], ["THR-40", "Нитки 40/2", "thread", "spool", 100],
    ["ZIP-60", "Молния 60 см", "trim", "pcs", 300], ["BTN-18", "Пуговица 18 мм", "trim", "pcs", 1000],
    ["PKG-BAG", "Пакет упаковочный", "packaging", "pcs", 1000], ["LBL-MAIN", "Этикетка основная", "trim", "pcs", 1000]])
    mats[code] = (await q("INSERT INTO materials (tenant_id,code,name,type,unit,min_stock) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id", [tid, code, name, type, unit, min]))[0].id;

  const grid = (await q("SELECT id FROM size_grids WHERE tenant_id=$1 AND name='S–XXL'", [tid]))[0].id;
  const sizes = await q("SELECT id,label FROM sizes WHERE grid_id=$1 ORDER BY sort", [grid]);

  const models = [
    { code: "T-001", name: "Футболка базовая", category: "Трикотаж", comp: "100% хлопок", cols: ["WHT", "BLK", "NVY"],
      bom: [["FAB-COT", null, 0.22, 6], ["FAB-COT", "XL", 0.25, 6], ["FAB-COT", "XXL", 0.28, 6], ["THR-40", null, 0.05, 0], ["LBL-MAIN", null, 1, 0], ["PKG-BAG", null, 1, 0]],
      ops: [["Раскрой", 1.5, 600], ["Пошив", 6, 2200], ["Утюжка", 1, 400], ["Упаковка", 0.8, 300]], prices: [45000, 40000, 3.6] },
    { code: "H-002", name: "Худи с капюшоном", category: "Трикотаж", comp: "80% хлопок, 20% полиэстер", cols: ["BLK", "NVY", "RED"],
      bom: [["FAB-FLC", null, 0.6, 8], ["FAB-FLC", "XL", 0.68, 8], ["FAB-FLC", "XXL", 0.75, 8], ["THR-40", null, 0.08, 0], ["LBL-MAIN", null, 1, 0], ["PKG-BAG", null, 1, 0]],
      ops: [["Раскрой", 3, 1200], ["Пошив", 18, 6500], ["Отделка", 3, 900], ["Утюжка", 2, 700], ["Упаковка", 1, 300]], prices: [140000, 125000, 11] },
    { code: "J-003", name: "Рабочая куртка", category: "Спецодежда", comp: "65% полиэстер, 35% хлопок", cols: ["NVY", "BLK"],
      bom: [["FAB-TWL", null, 2.1, 7], ["FAB-TWL", "XXL", 2.5, 7], ["ZIP-60", null, 1, 0], ["BTN-18", null, 6, 0], ["THR-40", null, 0.2, 0], ["LBL-MAIN", null, 1, 0], ["PKG-BAG", null, 1, 0]],
      ops: [["Раскрой", 6, 2500], ["Пошив", 45, 16000], ["Отделка", 6, 1800], ["ОТК", 3, 800], ["Упаковка", 1.5, 500]], prices: [320000, 290000, 25] },
  ];

  const pl: Record<string, string> = {};
  for (const [key, name, type, cur] of [["w", "Опт, UZS", "wholesale", "UZS"], ["r", "Розница, UZS", "retail", "UZS"], ["u", "Опт, USD", "wholesale", "USD"]])
    pl[key] = (await q("INSERT INTO price_lists (tenant_id,name,price_type,currency) VALUES ($1,$2,$3,$4) RETURNING id", [tid, name, type, cur]))[0].id;

  for (const m of models) {
    const mid = (await q(
      `INSERT INTO models (tenant_id,code,name,category,fabric_composition,season,size_grid_id) VALUES ($1,$2,$3,$4,$5,'Круглогодичная',$6) RETURNING id`,
      [tid, m.code, m.name, m.category, m.comp, grid]))[0].id;
    for (const c of m.cols) for (const s of sizes) {
      const seq = Number((await q("SELECT nextval('barcode_seq') AS n"))[0].n);
      await db.query("INSERT INTO variants (tenant_id,model_id,size_id,color_id,sku,barcode) VALUES ($1,$2,$3,$4,$5,$6)",
        [tid, mid, s.id, colors[c], `${m.code}-${c}-${s.label}`, ean13(seq)]);
    }
    for (const [mat, size, qty, waste] of m.bom) {
      const sid = size ? sizes.find((s) => s.label === size)!.id : null;
      await db.query("INSERT INTO bom_lines (tenant_id,model_id,material_id,size_id,qty_per_unit,waste_percent) VALUES ($1,$2,$3,$4,$5,$6)", [tid, mid, mats[mat as string], sid, qty, waste]);
    }
    for (const [i, [name, mins, rate]] of m.ops.entries())
      await db.query("INSERT INTO route_operations (tenant_id,model_id,step,name,norm_minutes,piece_rate) VALUES ($1,$2,$3,$4,$5,$6)", [tid, mid, i + 1, name, mins, Number(rate) * 100]);
    const [pw, pr, pu] = m.prices;
    await db.query("INSERT INTO prices (tenant_id,price_list_id,model_id,amount) VALUES ($1,$2,$3,$4),($1,$5,$3,$6),($1,$7,$3,$8)",
      [tid, pl.w, mid, pw * 100, pl.r, Math.round(pw * 1.25) * 100, pl.u, Math.round(pu * 100)]);
    void pr;
  }

  // Клиенты, контакты, лиды, сделки, задачи
  const clientsData = [
    ["ООО «Мода Плюс»", "wholesale", "wholesale", 50_000_000, manager, "Азиза Каримова", "+998901112233"],
    ["Сеть магазинов «Стиль»", "distributor", "large_wholesale", 200_000_000, owner, "Рустам Юсупов", "+998935556677"],
    ["ИП Нодира Хасанова", "retail", "retail", 5_000_000, manager, "Нодира Хасанова", "+998977778899"],
    ["СП «Строй-Инвест»", "corporate", "wholesale", 80_000_000, manager, "Бахтиёр Алиев", "+998901234567"],
  ];
  const clientIds: string[] = [];
  for (const [name, type, pt, limit, own, cname, phone] of clientsData) {
    const cid = (await q("INSERT INTO clients (tenant_id,name,type,price_type,credit_limit,owner_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id", [tid, name, type, pt, Number(limit) * 100, own]))[0].id;
    await db.query("INSERT INTO contacts (tenant_id,client_id,name,phone,is_primary) VALUES ($1,$2,$3,$4,true)", [tid, cid, cname, phone]);
    clientIds.push(cid);
  }
  const stages = await q("SELECT id,kind FROM pipeline_stages WHERE tenant_id=$1 ORDER BY sort", [tid]);
  const deals = [["Партия футболок на весну", 0, 0, 120_000_000, manager], ["Худи для сети «Стиль»", 1, 2, 350_000_000, owner], ["Форма для строителей", 3, 1, 180_000_000, manager], ["Футболки для магазина", 2, 3, 12_000_000, manager]];
  for (const [title, ci, si, amount, own] of deals)
    await db.query("INSERT INTO deals (tenant_id,title,client_id,stage_id,amount,owner_id) VALUES ($1,$2,$3,$4,$5,$6)", [tid, title, clientIds[ci as number], stages[si as number].id, Number(amount) * 100, own]);
  for (const [name, company, phone, src] of [["Малика", "Бутик «Нур»", "+998909990011", "instagram"], ["Фарход", "Маркет «Улугбек»", "+998909990022", "expo"], ["Сардор", null, "+998909990033", "call"]])
    await db.query("INSERT INTO leads (tenant_id,name,company,phone,source_code,owner_id) VALUES ($1,$2,$3,$4,$5,$6)", [tid, name, company, phone, src, manager]);
  for (const [title, ci] of [["Позвонить и уточнить размерный ряд", 0], ["Отправить образцы ткани", 1], ["Согласовать сроки пошива", 3]])
    await db.query("INSERT INTO tasks (tenant_id,title,due_at,assignee_id,created_by,entity,entity_id) VALUES ($1,$2,now() + interval '2 days',$3,$3,'client',$4)", [tid, title, manager, clientIds[ci as number]]);

  // КП для первого клиента: футболки, оптовая цена, 3 цвета × S–XL
  const vs = await q(`SELECT v.id FROM variants v JOIN models m ON m.id=v.model_id WHERE m.tenant_id=$1 AND m.code='T-001' AND v.sku LIKE '%-WHT-%' AND v.sku NOT LIKE '%XXL'`, [tid]);
  const price = Number((await q("SELECT amount FROM prices WHERE price_list_id=$1 AND model_id=(SELECT id FROM models WHERE tenant_id=$2 AND code='T-001')", [pl.w, tid]))[0].amount);
  const lines = vs.map((v, i) => ({ id: v.id, qty: 50 + i * 10 }));
  const total = Math.round(lines.reduce((s, l) => s + l.qty * price, 0) * 0.95);
  const qid = (await q(
    `INSERT INTO quotes (tenant_id,number,client_id,currency,discount_percent,total,owner_id,valid_until) VALUES ($1,$2,$3,'UZS',5,$4,$5,current_date + 14) RETURNING id`,
    [tid, `Q-${new Date().getFullYear()}-0001`, clientIds[0], total, manager]))[0].id;
  for (const l of lines) await db.query("INSERT INTO quote_lines (tenant_id,quote_id,variant_id,qty,unit_price) VALUES ($1,$2,$3,$4,$5)", [tid, qid, l.id, l.qty, price]);

  await db.query("COMMIT");
  console.log("Демо-данные созданы: 3 модели, 4 клиента, лиды, сделки, задачи, прайсы, КП");
} catch (e) {
  await db.query("ROLLBACK");
  throw e;
} finally {
  await db.end();
}
