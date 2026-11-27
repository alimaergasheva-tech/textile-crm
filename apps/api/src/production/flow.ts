import type pg from "pg";
import { BadRequestException } from "@nestjs/common";
import { availableForVariant, applyMovement } from "../warehouse/stock.ts";
import { calcRequirement } from "../catalog/bom.ts";

/** Допустимые переходы статуса задания (PRD-2). Всё остальное отклоняется. */
export const PROD_FLOW: Record<string, string[]> = {
  draft: ["planned", "cancelled"], planned: ["in_progress", "cancelled"], in_progress: ["qc", "cancelled"],
  qc: ["stocked", "in_progress", "cancelled"], stocked: ["closed"], closed: [], cancelled: [],
};
export function assertTransition(from: string, to: string) {
  if (!PROD_FLOW[from]?.includes(to)) throw new BadRequestException(`Переход ${from} → ${to} недопустим`);
}

/** Резервирует из готовой продукции сколько есть; считает остаток нехватки по строке заказа. */
export async function reserveItem(c: pg.PoolClient, tenantId: string, userId: string | null, item: { id: string; variant_id: string; qty: number; reserved: number; shipped?: number }) {
  await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [item.variant_id]);
  const need = item.qty - item.reserved - (item.shipped ?? 0);
  if (need <= 0) return 0;
  const a = await availableForVariant(c, item.variant_id);
  const take = Math.max(0, Math.min(need, Math.floor(a.available)));
  if (take > 0) {
    await c.query("INSERT INTO reservations (tenant_id,variant_id,qty,ref_type,ref_id,created_by) VALUES ($1,$2,$3,'order_item',$4,$5)",
      [tenantId, item.variant_id, take, item.id, userId]);
    await c.query("UPDATE order_items SET reserved = reserved + $2 WHERE id=$1", [item.id, take]);
  }
  return take;
}

export async function nextNumber(c: pg.PoolClient, table: "orders" | "production_orders" | "shipments", prefix: string): Promise<string> {
  const y = new Date().getFullYear();
  const n = Number((await c.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n) + 1;
  return `${prefix}-${y}-${String(n).padStart(4, "0")}`;
}

/** Статус заказа по состоянию строк и заданий. */
export async function refreshOrderStatus(c: pg.PoolClient, orderId: string) {
  const o = (await c.query("SELECT status FROM orders WHERE id=$1", [orderId])).rows[0];
  if (!o || !["confirmed", "in_production", "ready"].includes(o.status)) return;
  const short = (await c.query("SELECT count(*)::int n FROM order_items WHERE order_id=$1 AND reserved + shipped < qty", [orderId])).rows[0].n;
  await c.query("UPDATE orders SET status=$2 WHERE id=$1", [orderId, short ? "in_production" : "ready"]);
}

/** Подтверждённый заказ: резерв по строкам и задания на разницу, сгруппированные по модели (PRD-1). */
export async function reserveAndPlan(c: pg.PoolClient, tenantId: string, userId: string | null, orderId: string) {
  const items = (await c.query("SELECT oi.id,oi.variant_id,oi.qty,oi.reserved,oi.shipped,v.model_id FROM order_items oi JOIN variants v ON v.id=oi.variant_id WHERE oi.order_id=$1 ORDER BY v.sku", [orderId])).rows;
  const shortByModel = new Map<string, { variantId: string; qty: number }[]>();
  for (const it of items) {
    await reserveItem(c, tenantId, userId, it);
    const reserved = (await c.query("SELECT reserved FROM order_items WHERE id=$1", [it.id])).rows[0].reserved;
    const shortage = it.qty - it.shipped - reserved;
    if (shortage > 0) shortByModel.set(it.model_id, [...(shortByModel.get(it.model_id) ?? []), { variantId: it.variant_id, qty: shortage }]);
  }
  const due = (await c.query("SELECT due_date FROM orders WHERE id=$1", [orderId])).rows[0].due_date;
  for (const [modelId, lines] of shortByModel) {
    const number = await nextNumber(c, "production_orders", "PO");
    const poId = (await c.query("INSERT INTO production_orders (tenant_id,number,order_id,model_id,deadline,cutting_lot_code) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [tenantId, number, orderId, modelId, due, "CUT-" + number.slice(3)])).rows[0].id;
    for (const l of lines) await c.query("INSERT INTO production_items (tenant_id,production_order_id,variant_id,planned_qty) VALUES ($1,$2,$3,$4)", [tenantId, poId, l.variantId, l.qty]);
    await c.query(
      `INSERT INTO production_steps (tenant_id,production_order_id,route_operation_id,step,name)
       SELECT $1,$2,id,step,name FROM route_operations WHERE model_id=$3 ORDER BY step`, [tenantId, poId, modelId]);
  }
  await c.query("UPDATE orders SET status='confirmed' WHERE id=$1", [orderId]);
  await refreshOrderStatus(c, orderId);
  return shortByModel.size;
}

/** Списание материалов по BOM при запуске: с сырьевых складов, по рулонам (PRD-3). Нехватка — ошибка со списком. */
export async function consumeMaterials(c: pg.PoolClient, tenantId: string, userId: string | null, poId: string, modelId: string) {
  const items = (await c.query("SELECT v.size_id,pi.planned_qty FROM production_items pi JOIN variants v ON v.id=pi.variant_id WHERE pi.production_order_id=$1", [poId])).rows;
  const bom = (await c.query("SELECT material_id,size_id,qty_per_unit::float8,waste_percent::float8 FROM bom_lines WHERE model_id=$1", [modelId])).rows
    .map((l) => ({ materialId: l.material_id, sizeId: l.size_id, qtyPerUnit: l.qty_per_unit, wastePercent: l.waste_percent }));
  const need = calcRequirement(bom, items.map((i) => ({ sizeId: i.size_id, qty: i.planned_qty })));
  const lacking: string[] = [];
  for (const [mat, qty] of need) {
    const have = Number((await c.query(
      "SELECT COALESCE(sum(sb.qty),0) q FROM stock_balances sb JOIN locations l ON l.id=sb.location_id JOIN warehouses w ON w.id=l.warehouse_id WHERE sb.material_id=$1 AND w.kind='raw'", [mat])).rows[0].q);
    if (have < qty) lacking.push(`${(await c.query("SELECT code FROM materials WHERE id=$1", [mat])).rows[0].code}: нужно ${qty}, есть ${have}`);
  }
  if (lacking.length) throw new BadRequestException("Не хватает материалов — " + lacking.join("; "));
  for (const [mat, qty] of need) {
    await issueMaterial(c, tenantId, userId, mat, qty, poId);
    await c.query("INSERT INTO material_consumption (tenant_id,production_order_id,material_id,planned_qty,actual_qty) VALUES ($1,$2,$3,$4,$4)", [tenantId, poId, mat, qty]);
  }
}

/** Берёт материал с сырьевых остатков: сначала где больше; для партий — по рулонам. */
export async function issueMaterial(c: pg.PoolClient, tenantId: string, userId: string | null, materialId: string, qty: number, poId: string) {
  let left = qty;
  const bals = (await c.query(
    `SELECT sb.location_id,sb.lot_id,sb.qty::float8 q FROM stock_balances sb JOIN locations l ON l.id=sb.location_id JOIN warehouses w ON w.id=l.warehouse_id
      WHERE sb.material_id=$1 AND w.kind='raw' AND sb.qty>0 ORDER BY sb.qty DESC`, [materialId])).rows;
  for (const b of bals) {
    if (left <= 0) break;
    let avail = b.q;
    if (b.lot_id) {
      const rolls = (await c.query("SELECT id,qty_remaining::float8 r FROM fabric_rolls WHERE lot_id=$1 AND qty_remaining>0 ORDER BY roll_no::int", [b.lot_id])).rows;
      for (const r of rolls) {
        if (left <= 0) break;
        const take = Math.round(Math.min(left, r.r) * 1000) / 1000;
        if (take <= 0) continue;
        await applyMovement(c, tenantId, userId, { type: "issue", materialId, lotId: b.lot_id, rollId: r.id, locationId: b.location_id, qty: -take, docType: "production_order", docId: poId });
        left = Math.round((left - take) * 1000) / 1000;
      }
    } else {
      const take = Math.round(Math.min(left, avail) * 1000) / 1000;
      await applyMovement(c, tenantId, userId, { type: "issue", materialId, locationId: b.location_id, qty: -take, docType: "production_order", docId: poId });
      left = Math.round((left - take) * 1000) / 1000;
    }
  }
  if (left > 0.0005) throw new BadRequestException("Недостаточно материала на складе");
}

/**
 * Идемпотентность: запрос с тем же ключом выполняется один раз, повтор возвращает прежний ответ.
 * Ключ занимается в той же транзакции, что и действие: параллельный повтор ждёт и получает сохранённый ответ.
 */
export async function idem<T>(c: pg.PoolClient, tenantId: string, userId: string, key: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!key) return fn();
  if (key.length > 100) throw new BadRequestException("Слишком длинный Idempotency-Key");
  const got = await c.query("INSERT INTO idempotency_keys (tenant_id,key,user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING key", [tenantId, key, userId]);
  if (!got.rowCount) {
    const old = (await c.query("SELECT response FROM idempotency_keys WHERE key=$1", [key])).rows[0];
    return (old?.response ?? { duplicate: true }) as T;
  }
  const res = await fn();
  await c.query("UPDATE idempotency_keys SET response=$2 WHERE key=$1", [key, JSON.stringify(res ?? null)]);
  return res;
}

/** Постановка уведомления в очередь (отправляет фоновая задача). */
export async function notify(c: pg.PoolClient, tenantId: string, userId: string, text: string) {
  await c.query("INSERT INTO notifications (tenant_id,user_id,text) VALUES ($1,$2,$3)", [tenantId, userId, text]);
}

/** Уведомление всем сотрудникам с указанным правом (через роли). */
export async function notifyPermission(c: pg.PoolClient, tenantId: string, permission: string, text: string) {
  const ids = (await c.query(
    "SELECT DISTINCT ur.user_id FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE rp.permission_code=$1", [permission])).rows;
  for (const r of ids) await notify(c, tenantId, r.user_id, text);
}
