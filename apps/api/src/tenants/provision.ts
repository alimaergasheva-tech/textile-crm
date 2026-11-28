import type pg from "pg";

/** Стартовые роли новой фабрики и права, которые есть на этапе 1. Следующие модули добавят свои. */
const CRM_MODULES = ["clients", "leads", "deals", "tasks"];
const CRM_ACTIONS = ["view", "create", "edit"];
const CRM_ALL = [...CRM_MODULES.flatMap((m) => CRM_ACTIONS.map((a) => `${m}.${a}`)), "clients.delete", "deals.delete"];
/** «:own» — право только на свои записи */
const CRM_OWN = CRM_MODULES.flatMap((m) => CRM_ACTIONS.map((a) => `${m}.${a}:own`));

const CAT_VIEW = ["models.view", "materials.view", "pricing.view"];
const CAT_TECH = ["models.view", "models.create", "models.edit", "materials.view", "materials.create", "materials.edit"];
const WH_VIEW = ["warehouse.view"];
const ORD_VIEW = ["orders.view", "production.view", "shipments.view"];
const QUOTES = ["quotes.view", "quotes.create", "quotes.edit"];

export const DEFAULT_STAGES: [string, string][] = [
  ["Квалификация", "open"], ["Каталог / образцы", "open"], ["Коммерческое предложение", "open"],
  ["Согласование цены и сроков", "open"], ["Выиграна", "won"], ["Проиграна", "lost"],
];

/** Отделы новой фабрики (код, название). Совпадает с миграцией 016. */
export const DEFAULT_DEPARTMENTS: [string, string][] = [
  ["sales", "Продажи"], ["tech", "Технологи"], ["purchasing", "Закупки"], ["qc", "ОТК"],
  ["production", "Производство"], ["ved", "ВЭД"], ["logistics", "Логистика"], ["management", "Дирекция"],
];
/** Видят свои задачи и задачи своих отделов. */
const TASKS_OWN = ["tasks.view:own", "tasks.create:own", "tasks.edit:own"];
const DEPT_VIEW = ["departments.view"];
const XQ_MANAGE = ["exportquotes.view", "exportquotes.manage"];
const XPUR_VIEW = ["exportpurchases.view"];
const XPUR_MGR = ["exportpurchases.view", "exportpurchases.manage"];
const XSMP_VIEW = ["exportsamples.view"];
const XSMP_MGR = ["exportsamples.view", "exportsamples.manage"];
const XINS_VIEW = ["exportinspections.view"];
const XINS_MGR = ["exportinspections.view", "exportinspections.manage"];
const XPRD_VIEW = ["exportproduction.view", "exportshipments.view"];
const XPRD_PROD = ["exportproduction.view", "exportproduction.manage", "exportshipments.view"];
const XPRD_LOG = ["exportproduction.view", "exportshipments.view", "exportshipments.manage"];
const XVED_VIEW = ["exportved.view"];
const XVED_MGR = ["exportved.view", "exportved.manage"];
const XLOG_VIEW = ["exportlogistics.view"];
const XLOG_MGR = ["exportlogistics.view", "exportlogistics.manage"];
const XORD_VIEW = ["exportorders.view", "patterns.view"];
const XORD_SALES = ["exportorders.view", "exportorders.create", "exportorders.edit", "patterns.view"];
export const DEFAULT_ACCESSORIES: [string, string, string][] = [
  ["CORD", "Шнур хлопок D=0,5 см", "м"], ["TIPS", "Пластиковые наконечники шнура", "шт"], ["ELASTIC25", "Резинка 25 мм", "м"],
  ["TT-S", "Термотрансфер малый (рост 98–146)", "шт"], ["TT-L", "Термотрансфер большой (рост 152–182)", "шт"],
  ["HANGTAG", "Картонник / хэнгтег", "шт"], ["POLY30", "Полибэг 30×30 см", "шт"], ["CARTON", "Гофрокороб", "шт"], ["OTHER", "Нитки и прочее", "комплект"],
  ["ELASTIC35", "Резинка 35 мм", "м"], ["BOW", "Шнурок-бантик из кулирки D=0,5 см", "м"],
];

export const SYSTEM_ROLES: { code: string; name: string; perms: "all" | string[] }[] = [
  { code: "owner", name: "Владелец / директор", perms: "all" },
  { code: "admin", name: "Администратор системы", perms: "all" },
  { code: "sales_head", name: "Руководитель отдела продаж", perms: ["users.view", "files.view", "files.create", ...CRM_ALL, ...CAT_VIEW, ...QUOTES, ...WH_VIEW, ...ORD_VIEW, "orders.create", "orders.approve", "feedback.view", "feedback.create", "feedback.manage", ...DEPT_VIEW, ...XORD_SALES, ...XQ_MANAGE, ...XPUR_MGR, ...XSMP_MGR, ...XINS_MGR, ...XPRD_LOG, ...XVED_MGR, ...XLOG_MGR] },
  { code: "sales_manager", name: "Менеджер по продажам", perms: ["files.view", "files.create", ...CRM_OWN, ...CAT_VIEW, ...QUOTES.map((q) => `${q}:own`), ...WH_VIEW, ...ORD_VIEW, "orders.create", "feedback.view", "feedback.create", ...DEPT_VIEW, ...XORD_SALES, ...XQ_MANAGE, ...XPUR_VIEW, ...XSMP_MGR, ...XINS_VIEW, ...XPRD_VIEW] },
  { code: "technologist", name: "Технолог / конструктор", perms: ["files.view", "files.create", ...CAT_TECH, "warehouse.view", ...TASKS_OWN, ...DEPT_VIEW, "exportorders.edit", "patterns.manage", ...XORD_VIEW, ...XPUR_VIEW, ...XSMP_MGR, ...XINS_VIEW, ...XPRD_VIEW] },
  { code: "production_head", name: "Начальник производства", perms: ["users.view", "files.view", "files.create", "models.view", "materials.view", "warehouse.view", "warehouse.write", "orders.view", "shipments.view", "production.view", "production.manage", "production.report", "production.qc", ...TASKS_OWN, ...DEPT_VIEW, ...XORD_VIEW, ...XPUR_VIEW, ...XSMP_MGR, ...XINS_MGR, ...XPRD_PROD, ...XLOG_VIEW] },
  { code: "foreman", name: "Бригадир / рабочий", perms: ["files.create"] },
  { code: "brigadier", name: "Бригадир", perms: ["production.view", "production.report"] },
  { code: "qc", name: "Контролёр ОТК", perms: ["files.view", "files.create", "warehouse.view", "production.view", "production.report", "production.qc", ...TASKS_OWN, ...DEPT_VIEW, ...XORD_VIEW, ...XPUR_VIEW, ...XSMP_VIEW, ...XINS_MGR, ...XPRD_VIEW] },
  { code: "storekeeper", name: "Кладовщик", perms: ["files.view", "files.create", "models.view", "materials.view", "warehouse.view", "warehouse.write", "warehouse.inventory", "warehouse.manage", "production.view", "shipments.view", "shipments.create", ...TASKS_OWN, ...DEPT_VIEW] },
  { code: "purchaser", name: "Закупщик", perms: ["files.view", "warehouse.view", ...TASKS_OWN, ...DEPT_VIEW, ...XORD_VIEW, ...XPUR_MGR, ...XSMP_VIEW, ...XINS_VIEW, ...XPRD_VIEW] },
  { code: "accountant", name: "Бухгалтер / финансист", perms: ["files.view", "warehouse.view", ...DEPT_VIEW, ...XORD_VIEW, "exportquotes.view", ...XPUR_VIEW, ...XSMP_VIEW, ...XINS_VIEW, ...XPRD_VIEW, ...XVED_VIEW, ...XLOG_VIEW] },
  { code: "ved", name: "Специалист ВЭД", perms: ["files.view", "files.create", "orders.view", "shipments.view", "warehouse.view", ...TASKS_OWN, ...DEPT_VIEW, ...XORD_VIEW, ...XSMP_VIEW, ...XINS_VIEW, ...XPRD_LOG, ...XVED_MGR, ...XLOG_VIEW] },
  { code: "logistics", name: "Логист", perms: ["files.view", "files.create", "orders.view", "shipments.view", "warehouse.view", ...TASKS_OWN, ...DEPT_VIEW, ...XORD_VIEW, ...XPUR_VIEW, ...XSMP_VIEW, ...XINS_VIEW, ...XPRD_LOG, ...XVED_MGR, ...XLOG_MGR] },
  { code: "planner", name: "Планировщик", perms: ["files.view", "orders.view", "production.view", ...TASKS_OWN, ...DEPT_VIEW, ...XORD_VIEW, ...XPUR_VIEW, ...XSMP_VIEW, ...XINS_VIEW, ...XPRD_PROD, ...XLOG_VIEW] },
];

export const DEFAULT_REFERENCES: Record<string, [string, string, string, string, string][]> = {
  // [код, рус, узб, англ, тур]
  lead_source: [["call", "Звонок", "Qo‘ng‘iroq", "Phone call", "Telefon görüşmesi"], ["telegram", "Telegram", "Telegram", "Telegram", "Telegram"],
    ["instagram", "Instagram", "Instagram", "Instagram", "Instagram"], ["site", "Сайт", "Sayt", "Website", "Web sitesi"],
    ["expo", "Выставка", "Ko‘rgazma", "Exhibition", "Fuar"], ["referral", "Рекомендация", "Tavsiya", "Referral", "Tavsiye"]],
  loss_reason: [["price", "Цена", "Narx", "Price", "Fiyat"], ["terms", "Сроки", "Muddat", "Lead time", "Teslim süresi"],
    ["quality", "Качество", "Sifat", "Quality", "Kalite"], ["other", "Другое", "Boshqa", "Other", "Diğer"]],
  complaint_reason: [["quality", "Качество", "Sifat", "Quality", "Kalite"], ["packaging", "Упаковка", "Qadoqlash", "Packaging", "Ambalaj"],
    ["terms", "Сроки", "Muddat", "Lead time", "Teslim süresi"], ["shortage", "Недостача", "Yetishmovchilik", "Shortage", "Eksik teslimat"]],
  defect_reason: [["seam", "Брак шва", "Chok nuqsoni", "Seam defect", "Dikiş hatası"], ["fabric", "Дефект ткани", "Mato nuqsoni", "Fabric defect", "Kumaş hatası"],
    ["size", "Неверный размер", "Noto‘g‘ri o‘lcham", "Wrong size", "Yanlış beden"]],
};

/** Создаёт фабрику с ролями и справочниками. Вызывается от имени администратора платформы (не crm_app). */
export async function provisionTenant(c: pg.ClientBase, slug: string, name: string): Promise<string> {
  const tid = (await c.query("INSERT INTO tenants (slug,name) VALUES ($1,$2) RETURNING id", [slug, name])).rows[0].id;
  const all = (await c.query("SELECT code FROM permissions")).rows.map((r) => r.code as string);
  for (const r of SYSTEM_ROLES) {
    const rid = (await c.query("INSERT INTO roles (tenant_id,code,name,is_system) VALUES ($1,$2,$3,true) RETURNING id",
      [tid, r.code, r.name])).rows[0].id;
    for (const raw of r.perms === "all" ? all : r.perms) {
      const [code, flag] = raw.split(":");
      await c.query("INSERT INTO role_permissions (tenant_id,role_id,permission_code,own_only) VALUES ($1,$2,$3,$4)",
        [tid, rid, code, flag === "own"]);
    }
  }
  for (const [i, [code, dname]] of DEFAULT_DEPARTMENTS.entries())
    await c.query("INSERT INTO departments (tenant_id,code,name,sort) VALUES ($1,$2,$3,$4)", [tid, code, dname, i + 1]);
  for (const [code, aname, unit] of DEFAULT_ACCESSORIES)
    await c.query("INSERT INTO export_accessories (tenant_id,code,name,unit) VALUES ($1,$2,$3,$4)", [tid, code, aname, unit]);
  for (const [i, [name, kind]] of DEFAULT_STAGES.entries())
    await c.query("INSERT INTO pipeline_stages (tenant_id,name,sort,kind) VALUES ($1,$2,$3,$4)", [tid, name, i + 1, kind]);
  for (const [name, kind] of [["Склад сырья", "raw"], ["Цех (незавершённое производство)", "wip"], ["Склад готовой продукции", "finished"]]) {
    const wid = (await c.query("INSERT INTO warehouses (tenant_id,name,kind) VALUES ($1,$2,$3) RETURNING id", [tid, name, kind])).rows[0].id;
    await c.query("INSERT INTO locations (tenant_id,warehouse_id,code,name) VALUES ($1,$2,'MAIN','Основная')", [tid, wid]);
  }
  const grid = (await c.query("INSERT INTO size_grids (tenant_id,name) VALUES ($1,'S–XXL') RETURNING id", [tid])).rows[0].id;
  for (const [i, label] of ["S", "M", "L", "XL", "XXL"].entries())
    await c.query("INSERT INTO sizes (tenant_id,grid_id,label,sort) VALUES ($1,$2,$3,$4)", [tid, grid, label, i + 1]);
  for (const [dict, items] of Object.entries(DEFAULT_REFERENCES))
    for (const [i, [code, ru, uz, en, tr]] of items.entries())
      await c.query(`INSERT INTO reference_values (tenant_id,dictionary,code,name_ru,name_uz,name_en,name_tr,sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tid, dict, code, ru, uz, en, tr, i]);
  return tid;
}
