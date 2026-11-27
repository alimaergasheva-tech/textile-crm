import pg from "pg";
import argon2 from "argon2";
import { provisionTenant } from "./tenants/provision.ts";

/** Демо-данные для разработки: две фабрики, у каждой директор и менеджер. Только для dev! */
const url = process.env.DATABASE_URL;
if (!url) throw new Error("Задайте DATABASE_URL");
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query("BEGIN");
  for (const [slug, name] of [["demo-a", "Демо-фабрика A"], ["demo-b", "Демо-фабрика B"]]) {
    if ((await client.query("SELECT 1 FROM tenants WHERE slug=$1", [slug])).rowCount) continue;
    const tid = await provisionTenant(client, slug, name);
    const hash = await argon2.hash("demo12345");
    for (const [email, fullName, role] of [[`owner@${slug}.uz`, "Директор", "owner"], [`manager@${slug}.uz`, "Менеджер", "sales_manager"]]) {
      const uid = (await client.query(
        "INSERT INTO users (tenant_id,email,full_name,password_hash) VALUES ($1,$2,$3,$4) RETURNING id", [tid, email, fullName, hash])).rows[0].id;
      await client.query("INSERT INTO user_roles (tenant_id,user_id,role_id) SELECT $1,$2,id FROM roles WHERE tenant_id=$1 AND code=$3", [tid, uid, role]);
    }
    console.log(`Фабрика ${slug}: owner@${slug}.uz / manager@${slug}.uz, пароль demo12345`);
  }
  await client.query("COMMIT");
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  await client.end();
}
