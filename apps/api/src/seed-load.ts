import pg from "pg";

/** Нагрузочные данные: по 10 000 клиентов и заказов в фабрике demo-a (для замера списков). Повторный запуск ничего не дублирует. */
const url = process.env.DATABASE_URL;
if (!url) throw new Error("Задайте DATABASE_URL");
const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  const tid = (await c.query("SELECT id FROM tenants WHERE slug='demo-a'")).rows[0].id;
  await c.query("BEGIN");
  await c.query(`INSERT INTO clients (tenant_id,name,type) SELECT $1, 'Нагрузка ' || g, 'wholesale' FROM generate_series(1,10000) g
                 WHERE NOT EXISTS (SELECT 1 FROM clients WHERE tenant_id=$1 AND name='Нагрузка 1')`, [tid]);
  await c.query(`INSERT INTO orders (tenant_id,number,client_id,status,currency,total)
                 SELECT $1, 'L-' || g, (SELECT id FROM clients WHERE tenant_id=$1 AND name = 'Нагрузка ' || (1 + g % 10000)), 'confirmed', 'UZS', 100000 * g
                   FROM generate_series(1,10000) g
                 WHERE NOT EXISTS (SELECT 1 FROM orders WHERE tenant_id=$1 AND number='L-1')`, [tid]);
  await c.query("COMMIT");
  const n = (await c.query("SELECT (SELECT count(*) FROM clients WHERE tenant_id=$1) AS clients, (SELECT count(*) FROM orders WHERE tenant_id=$1) AS orders", [tid])).rows[0];
  console.log(`demo-a: клиентов ${n.clients}, заказов ${n.orders}`);
} catch (e) { await c.query("ROLLBACK"); throw e; } finally { await c.end(); }
