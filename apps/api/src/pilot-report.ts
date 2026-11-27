import pg from "pg";
import { reconcile } from "./warehouse/stock.ts";

/**
 * Отчёт пилота (9.7): метрики из PRD по данным системы и проверка готовности фабрики к старту.
 * Запуск: tsx src/pilot-report.ts <slug фабрики> [дней, по умолчанию 7]. Работает под админ-ролью, читает только выбранную фабрику.
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error("Задайте DATABASE_URL");
const slug = process.argv[2] ?? "demo-a";
const days = Number(process.argv[3] ?? 7);
const db = new pg.Client({ connectionString: url });
await db.connect();
const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0];
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "—");
const num = (x: unknown, d = 1) => (x === null || x === undefined ? "—" : String(Math.round(Number(x) * 10 ** d) / 10 ** d));

try {
  const t = await one("SELECT id,name,status,plan,max_users FROM tenants WHERE slug=$1", [slug]);
  if (!t) throw new Error(`Нет фабрики ${slug}`);
  const id = t.id, since = new Date(Date.now() - days * 86400_000);
  const out: string[] = [];
  const line = (s = "") => out.push(s);

  line(`ОТЧЁТ ПИЛОТА: ${t.name} (${slug}), за ${days} дн. с ${since.toISOString().slice(0, 10)}`);
  line(`Сформирован: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC\n`);

  line("== Готовность к старту ==");
  const u = await one("SELECT count(*) FILTER (WHERE is_active AND deleted_at IS NULL)::int AS users, count(*) FILTER (WHERE is_active AND deleted_at IS NULL AND telegram_id IS NOT NULL)::int AS tg FROM users WHERE tenant_id=$1", [id]);
  const cnt = async (tbl: string) => Number((await one(`SELECT count(*)::int n FROM ${tbl} WHERE tenant_id=$1`, [id])).n);
  const [clients, models, variants, materials, brigades] = await Promise.all(["clients", "models", "variants", "materials", "brigades"].map(cnt));
  const check = (ok: boolean, text: string) => line(`${ok ? "[ok]" : "[!!]"} ${text}`);
  check(t.status === "active", `фабрика активна (статус: ${t.status}, тариф: ${t.plan})`);
  check(u.users > 0 && u.users <= t.max_users, `сотрудников: ${u.users} из ${t.max_users} по тарифу`);
  check(u.tg >= Math.ceil(u.users * 0.8), `Telegram привязан у ${u.tg} из ${u.users} (нужно хотя бы 80%)`);
  check(!!process.env.TELEGRAM_BOT_TOKEN, "токен бота задан в окружении сервера");
  check(clients > 0, `клиентов: ${clients}`);
  check(models > 0 && variants > 0, `моделей: ${models}, вариантов: ${variants}`);
  check(materials > 0, `материалов: ${materials}`);
  check(brigades > 0, `бригад: ${brigades}`);
  const route = await one("SELECT count(DISTINCT model_id)::int n FROM route_operations WHERE tenant_id=$1", [id]);
  check(route.n >= models, `маршрут задан у ${route.n} из ${models} моделей`);
  const mn = await one("SELECT count(*)::int n FROM materials WHERE tenant_id=$1 AND min_stock>0", [id]);
  check(mn.n > 0, `минимальный остаток задан у ${mn.n} материалов (иначе сводка склада молчит)`);

  line("\n== 1. Время от выигранной сделки до заказа ==");
  const a = await one(
    `SELECT count(*)::int n, avg(extract(epoch FROM (o.created_at - d.closed_at))/3600) AS avg_h,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (o.created_at - d.closed_at))/3600) AS med_h
       FROM orders o JOIN deals d ON d.id=o.deal_id WHERE o.tenant_id=$1 AND o.created_at >= $2 AND d.closed_at IS NOT NULL`, [id, since]);
  line(`заказов из сделок: ${a.n}; среднее: ${num(a.avg_h)} ч; медиана: ${num(a.med_h)} ч`);

  line("\n== 2. Заказы и задания на производство ==");
  const o = await one(
    `SELECT count(*)::int total, count(*) FILTER (WHERE deal_id IS NOT NULL)::int from_deal,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM production_orders p WHERE p.order_id=o.id))::int with_po
       FROM orders o WHERE tenant_id=$1 AND status<>'cancelled' AND created_at >= $2`, [id, since]);
  line(`заказов: ${o.total}; создано из сделки: ${o.from_deal} (${pct(o.from_deal, o.total)}); с заданием на производство: ${o.with_po} (${pct(o.with_po, o.total)})`);
  line("(задания создаются автоматически при недостатке остатка, поэтому 100% здесь не цель — смотрите, что заказ без задания действительно закрыт остатком)");

  line("\n== 3. Расхождения склада ==");
  const diffs = (await reconcile(db as unknown as pg.PoolClient, false)).filter((d: any) => d.tenant_id === id);
  const pos = await one("SELECT count(*)::int n FROM stock_balances WHERE tenant_id=$1", [id]);
  line(`позиций в балансе: ${pos.n}; расхождений баланса с движениями: ${diffs.length} (${pct(diffs.length, pos.n)}). Расхождения факта с учётом — только по инвентаризации на месте.`);

  line("\n== 4. Отметки бригад ==");
  const r = await one(
    `SELECT count(*)::int n, count(DISTINCT created_at::date)::int days,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM users u WHERE u.id=r.created_by AND u.telegram_id IS NOT NULL))::int via_tg
       FROM step_reports r WHERE tenant_id=$1 AND created_at >= $2`, [id, since]);
  line(`отметок: ${r.n} за ${r.days} дн.; внесено пользователями с привязанным Telegram (Mini App): ${r.via_tg} (${pct(r.via_tg, r.n)})`);
  line("(система хранит время внесения, а не время выполнения: «в день выполнения» оценивайте по опросу бригадиров)");

  line("\n== 5. Клиенты: оценки и рекламации ==");
  const f = await one("SELECT COALESCE(avg(rating),0)::float8 AS avg, count(rating)::int rated, count(*)::int asked FROM feedback WHERE tenant_id=$1 AND request_at >= $2", [id, since]);
  const sh = await one("SELECT count(*)::int n FROM shipments WHERE tenant_id=$1 AND status='shipped' AND shipped_at >= $2", [id, since]);
  const k = await one(
    `SELECT count(*)::int total, count(*) FILTER (WHERE status IN ('new','in_progress') AND due_at < now())::int overdue,
            avg(extract(epoch FROM (resolved_at - created_at))/3600) FILTER (WHERE resolved_at IS NOT NULL) AS avg_h
       FROM complaints WHERE tenant_id=$1 AND created_at >= $2`, [id, since]);
  line(`отгрузок: ${sh.n}; запросов оценки: ${f.asked}; получено: ${f.rated}; средняя оценка: ${num(f.avg, 2)}`);
  line(`рекламаций: ${k.total} (${pct(k.total, sh.n)} от отгрузок); просрочено: ${k.overdue}; среднее время решения: ${num(k.avg_h)} ч`);

  line("\n== 6. Операции вне системы ==");
  line("Измеряется только опросом сотрудников (шаблон — в docs/PILOT.md). Цель: ноль.");

  const text = out.join("\n");
  console.log(text);
} finally { await db.end(); }
