import pg from "pg";

/**
 * Создаёт роль приложения crm_app (без суперправ, на неё действует Row Level Security), если её ещё нет.
 * Нужна для хостингов вроде Railway, где нет init-скрипта Postgres. Идемпотентно: при повторном запуске
 * только обновляет пароль роли. Требует DATABASE_URL (админ) и APP_DB_PASSWORD.
 */
const url = process.env.DATABASE_URL;
const password = process.env.APP_DB_PASSWORD;
if (!url) throw new Error("Задайте DATABASE_URL");
if (!password) throw new Error("Задайте APP_DB_PASSWORD");
const lit = (v: string) => "'" + v.replace(/'/g, "''") + "'";
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const exists = (await client.query("SELECT 1 FROM pg_roles WHERE rolname='crm_app'")).rowCount;
  await client.query(`${exists ? "ALTER" : "CREATE"} ROLE crm_app LOGIN PASSWORD ${lit(password)} NOSUPERUSER NOBYPASSRLS`);
  const db = (await client.query("SELECT current_database() AS d")).rows[0].d as string;
  await client.query(`GRANT CONNECT ON DATABASE "${db.replace(/"/g, '""')}" TO crm_app`);
  console.log(exists ? "Роль crm_app обновлена" : "Роль crm_app создана");
} finally { await client.end(); }
