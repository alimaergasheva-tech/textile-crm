import { BadRequestException, Body, Controller, Inject, Param, Post, Req } from "@nestjs/common";
import type pg from "pg";
import { z } from "zod";
import { DbService } from "../db/db.service.ts";
import { AuditService } from "../audit/audit.service.ts";
import { RequirePermission } from "../rbac/rbac.ts";
import { R } from "../crm/common.ts";
import { applyMovement } from "../warehouse/stock.ts";
import { mapRows, parseCsv, toNum } from "./csv.ts";

const MAX_ROWS = 5000;
type Err = { row: number; message: string };
class Rollback { constructor(public result: unknown) {} }

const CLIENT_COLS = {
  name: ["название", "клиент", "наименование", "имя", "client"], type: ["тип"], price_type: ["тип цены", "прайс"], tax_id: ["инн", "stir", "tax", "taxid"],
  address: ["адрес"], phone: ["телефон", "тел"], contact: ["контакт", "контактное лицо"], credit_limit: ["кредитный лимит", "лимит"],
  currency: ["валюта"], external_id: ["внешний id", "id 1с", "код 1с", "extid"],
};
const MATERIAL_COLS = { code: ["код", "артикул"], name: ["название", "наименование"], type: ["тип"], unit: ["ед", "единица", "ед. изм."], min_stock: ["мин. остаток", "минимальный остаток", "минимум"], external_id: ["внешний id", "id 1с"] };
const STOCK_COLS = { sku: ["артикул", "sku"], material_code: ["код материала", "материал"], qty: ["количество", "кол-во", "остаток"], location: ["ячейка", "место"] };

const CLIENT_TYPES: Record<string, string> = { wholesale: "wholesale", опт: "wholesale", оптовый: "wholesale", corporate: "corporate", корпоративный: "corporate", retail: "retail", розница: "retail", розничный: "retail", distributor: "distributor", дистрибьютор: "distributor" };
const PRICE_TYPES: Record<string, string> = { retail: "retail", розница: "retail", wholesale: "wholesale", опт: "wholesale", large_wholesale: "large_wholesale", "крупный опт": "large_wholesale" };
const MAT_TYPES: Record<string, string> = { fabric: "fabric", ткань: "fabric", lining: "lining", подкладка: "lining", thread: "thread", нитки: "thread", нить: "thread", trim: "trim", фурнитура: "trim", packaging: "packaging", упаковка: "packaging" };
const UNITS: Record<string, string> = { m: "m", м: "m", метр: "m", kg: "kg", кг: "kg", pcs: "pcs", шт: "pcs", roll: "roll", рулон: "roll", set: "set", комплект: "set", spool: "spool", бобина: "spool" };

/** Импорт из CSV: «сначала проверка» (dryRun=true, ничего не пишется), затем загрузка. Любая ошибка в строках — не загружается ничего. */
@Controller("import")
export class ImportController {
  constructor(@Inject(DbService) private db: DbService, @Inject(AuditService) private audit: AuditService) {}

  @Post(":entity") @RequirePermission("data.import")
  async run(@Req() req: R, @Param("entity") entity: string, @Body() body: unknown) {
    const d = z.object({ csv: z.string().min(1).max(5_000_000), dryRun: z.boolean().default(true) }).parse(body);
    const spec = { clients: CLIENT_COLS, materials: MATERIAL_COLS, stock: STOCK_COLS }[entity];
    if (!spec) throw new BadRequestException("Можно импортировать: clients, materials, stock");
    const { rows, unknown } = mapRows(parseCsv(d.csv), spec);
    if (!rows.length) throw new BadRequestException("В файле нет строк с данными (нужна строка заголовков и хотя бы одна строка)");
    if (rows.length > MAX_ROWS) throw new BadRequestException(`Не больше ${MAX_ROWS} строк за раз`);
    const errors: Err[] = []; const counts = { created: 0, updated: 0 };
    try {
      await this.db.tx(req.user.tenantId, async (c) => {
        for (let i = 0; i < rows.length; i++) {
          const n = i + 2; // номер строки в файле (1 — заголовки)
          try {
            const r = rows[i];
            const how = entity === "clients" ? await this.client(c, req, r) : entity === "materials" ? await this.material(c, req.user.tenantId, r) : await this.stock(c, req, r);
            counts[how]++;
          } catch (e) { errors.push({ row: n, message: (e as Error).message }); }
        }
        if (!d.dryRun && !errors.length)
          await this.audit.log(c, { tenantId: req.user.tenantId, userId: req.user.id, entity: "import", action: entity, after: { ...counts }, ip: req.ip });
        if (d.dryRun || errors.length) throw new Rollback(null);
      });
    } catch (e) { if (!(e instanceof Rollback)) throw e; }
    return { entity, dryRun: d.dryRun, applied: !d.dryRun && !errors.length, rows: rows.length, ...counts, errors: errors.slice(0, 200), errorCount: errors.length, ignoredColumns: unknown };
  }

  private async client(c: pg.PoolClient, req: R, r: Record<string, string>): Promise<"created" | "updated"> {
    if (!r.name) throw new Error("Не указано название клиента");
    const type = r.type ? CLIENT_TYPES[r.type.toLowerCase()] : undefined; if (r.type && !type) throw new Error(`Неизвестный тип клиента «${r.type}»`);
    const price = r.price_type ? PRICE_TYPES[r.price_type.toLowerCase()] : undefined; if (r.price_type && !price) throw new Error(`Неизвестный тип цены «${r.price_type}»`);
    const cur = r.currency ? r.currency.toUpperCase() : undefined; if (cur && !["UZS", "USD", "СУМ"].includes(cur)) throw new Error(`Неизвестная валюта «${r.currency}»`);
    const currency = cur === "USD" ? "USD" : cur ? "UZS" : undefined;
    let limit: number | undefined;
    if (r.credit_limit) { const v = toNum(r.credit_limit); if (!Number.isFinite(v) || v < 0) throw new Error(`Кредитный лимит «${r.credit_limit}» — не число`); limit = Math.round(v * 100); } // в минимальных единицах
    const t = req.user.tenantId;
    const found = (await c.query(
      r.external_id ? "SELECT id FROM clients WHERE external_id=$1 AND deleted_at IS NULL" : "SELECT id FROM clients WHERE lower(name)=lower($1) AND deleted_at IS NULL LIMIT 1",
      [r.external_id || r.name])).rows[0];
    let id: string, how: "created" | "updated";
    if (found) {
      id = found.id; how = "updated";
      await c.query(`UPDATE clients SET name=$2, type=COALESCE($3,type), price_type=COALESCE($4,price_type), tax_id=COALESCE($5,tax_id), address=COALESCE($6,address),
        credit_limit=COALESCE($7,credit_limit), credit_currency=COALESCE($8,credit_currency), external_id=COALESCE($9,external_id) WHERE id=$1`,
        [id, r.name, type ?? null, price ?? null, r.tax_id || null, r.address || null, limit ?? null, currency ?? null, r.external_id || null]);
    } else {
      how = "created";
      id = (await c.query(`INSERT INTO clients (tenant_id,name,type,price_type,tax_id,address,credit_limit,credit_currency,external_id,owner_id)
        VALUES ($1,$2,COALESCE($3,'wholesale'),COALESCE($4,'wholesale'),$5,$6,COALESCE($7,0),COALESCE($8,'UZS'),$9,$10) RETURNING id`,
        [t, r.name, type ?? null, price ?? null, r.tax_id || null, r.address || null, limit ?? null, currency ?? null, r.external_id || null, req.user.id])).rows[0].id;
    }
    if ((r.phone || r.contact) && !(await c.query("SELECT 1 FROM contacts WHERE client_id=$1 AND COALESCE(phone,'')=$2 AND name=$3", [id, r.phone, r.contact || r.name])).rowCount)
      await c.query("INSERT INTO contacts (tenant_id,client_id,name,phone,is_primary) VALUES ($1,$2,$3,$4,NOT EXISTS (SELECT 1 FROM contacts WHERE client_id=$2))", [t, id, r.contact || r.name, r.phone || null]);
    return how;
  }

  private async material(c: pg.PoolClient, t: string, r: Record<string, string>): Promise<"created" | "updated"> {
    if (!r.code || !r.name) throw new Error("Нужны код и название материала");
    const type = MAT_TYPES[(r.type ?? "").toLowerCase()]; if (!type) throw new Error(`Неизвестный тип «${r.type ?? ""}» (ткань, подкладка, нитки, фурнитура, упаковка)`);
    const unit = UNITS[(r.unit ?? "").toLowerCase()]; if (!unit) throw new Error(`Неизвестная единица «${r.unit ?? ""}» (м, кг, шт, рулон, комплект, бобина)`);
    let min = 0; if (r.min_stock) { min = toNum(r.min_stock); if (!Number.isFinite(min) || min < 0) throw new Error(`Минимальный остаток «${r.min_stock}» — не число`); }
    const found = (await c.query("SELECT id FROM materials WHERE code=$1", [r.code])).rows[0];
    if (found) { await c.query("UPDATE materials SET name=$2,type=$3,unit=$4,min_stock=$5,external_id=COALESCE($6,external_id) WHERE id=$1", [found.id, r.name, type, unit, min, r.external_id || null]); return "updated"; }
    await c.query("INSERT INTO materials (tenant_id,code,name,type,unit,min_stock,external_id) VALUES ($1,$2,$3,$4,$5,$6,$7)", [t, r.code, r.name, type, unit, min, r.external_id || null]);
    return "created";
  }

  /** Начальные остатки: готовая продукция по артикулу или сырьё по коду (кроме ткани — её принимают рулонами на складе). Один раз на позицию. */
  private async stock(c: pg.PoolClient, req: R, r: Record<string, string>): Promise<"created" | "updated"> {
    const qty = toNum(r.qty ?? ""); if (!Number.isFinite(qty) || qty <= 0) throw new Error(`Количество «${r.qty ?? ""}» должно быть числом больше нуля`);
    if (!!r.sku === !!r.material_code) throw new Error("Укажите либо артикул (готовая продукция), либо код материала");
    const isVar = !!r.sku;
    const item = (await c.query(isVar ? "SELECT id FROM variants WHERE sku=$1" : "SELECT id,type FROM materials WHERE code=$1", [r.sku || r.material_code])).rows[0];
    if (!item) throw new Error(`${isVar ? "Артикул" : "Материал"} «${r.sku || r.material_code}» не найден`);
    if (!isVar && item.type === "fabric") throw new Error("Ткань принимается рулонами и партиями на экране «Склад → Приход», не импортом");
    if (isVar && !Number.isInteger(qty)) throw new Error("Готовая продукция считается целыми штуками");
    const col = isVar ? "variant_id" : "material_id";
    if ((await c.query(`SELECT 1 FROM stock_movements WHERE ${col}=$1 LIMIT 1`, [item.id])).rowCount) throw new Error("По позиции уже есть движения — начальный остаток загружается один раз");
    const loc = (await c.query(
      `SELECT l.id FROM locations l JOIN warehouses w ON w.id=l.warehouse_id WHERE w.kind=$1 AND w.is_active AND ($2='' OR l.code=$2) ORDER BY l.code LIMIT 1`,
      [isVar ? "finished" : "raw", r.location ?? ""])).rows[0];
    if (!loc) throw new Error(r.location ? `Ячейка «${r.location}» не найдена на нужном складе` : "Нет склада для этой позиции");
    await applyMovement(c, req.user.tenantId, req.user.id, { type: "receipt", locationId: loc.id, qty, [isVar ? "variantId" : "materialId"]: item.id, docType: "import", comment: "Начальный остаток (импорт)" });
    return "created";
  }
}
