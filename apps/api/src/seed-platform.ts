import pg from "pg";
import argon2 from "argon2";

/** Создаёт администратора платформы. Пароль — PLATFORM_ADMIN_PASSWORD (для разработки по умолчанию platform12345). */
const url = process.env.DATABASE_URL;
if (!url) throw new Error("Задайте DATABASE_URL");
const email = process.env.PLATFORM_ADMIN_EMAIL ?? "platform@local.dev";
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  if (!(await client.query("SELECT 1 FROM platform_admins WHERE email=$1", [email])).rowCount) {
    await client.query("INSERT INTO platform_admins (email,full_name,password_hash) VALUES ($1,'Владелец платформы',$2)",
      [email, await argon2.hash(process.env.PLATFORM_ADMIN_PASSWORD ?? "platform12345")]);
    console.log(`Администратор платформы: ${email}`);
  }
} finally { await client.end(); }
