import type pg from "pg";
import { BadRequestException } from "@nestjs/common";

export type MoveType = "receipt" | "return" | "issue" | "transfer_out" | "transfer_in" | "writeoff" | "inventory_adjust";
export type Move = {
  type: MoveType; locationId: string; qty: number;           // qty со знаком: приход +, расход −
  materialId?: string | null; variantId?: string | null; lotId?: string | null; rollId?: string | null;
  docType?: string | null; docId?: string | null; comment?: string | null;
};
const ZERO = "00000000-0000-0000-0000-000000000000";

/** Единственное место, где меняются остатки: движение + баланс (+ рулон) в одной транзакции.
 *  Уход в минус невозможен: UPDATE с условием qty+Δ ≥ 0 держит блокировку строки, а CHECK в базе — страховка. */
export async function applyMovement(c: pg.PoolClient, tenantId: string, userId: string | null, m: Move) {
  if (!Number.isFinite(m.qty) || m.qty === 0) throw new BadRequestException("Количество не может быть нулевым");
  if (!!m.materialId === !!m.variantId) throw new BadRequestException("Укажите либо материал, либо вариант модели");
  const key = [tenantId, m.locationId, m.materialId ?? ZERO, m.variantId ?? ZERO, m.lotId ?? ZERO];
  if (m.qty > 0) {
    await c.query(
      `INSERT INTO stock_balances (tenant_id,location_id,material_id,variant_id,lot_id,qty)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id,location_id,k_material,k_variant,k_lot) DO UPDATE SET qty = stock_balances.qty + EXCLUDED.qty, updated_at = now()`,
      [tenantId, m.locationId, m.materialId ?? null, m.variantId ?? null, m.lotId ?? null, m.qty]);
  } else {
    const r = await c.query(
      `UPDATE stock_balances SET qty = qty + $6, updated_at = now()
        WHERE tenant_id=$1 AND location_id=$2 AND k_material=$3 AND k_variant=$4 AND k_lot=$5 AND qty + $6 >= 0`,
      [...key, m.qty]);
    if (!r.rowCount) throw new BadRequestException("Недостаточно остатка на складе");
  }
  if (m.rollId) {
    const r = await c.query(
      "UPDATE fabric_rolls SET qty_remaining = qty_remaining + $2 WHERE id=$1 AND qty_remaining + $2 >= 0", [m.rollId, m.qty]);
    if (!r.rowCount) throw new BadRequestException("В рулоне недостаточно ткани");
  }
  await c.query(
    `INSERT INTO stock_movements (tenant_id,type,material_id,variant_id,lot_id,roll_id,location_id,qty,doc_type,doc_id,comment,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [tenantId, m.type, m.materialId ?? null, m.variantId ?? null, m.lotId ?? null, m.rollId ?? null, m.locationId, m.qty,
     m.docType ?? null, m.docId ?? null, m.comment ?? null, userId]);
}

/** Перемещение: расход из одной ячейки и приход в другую — оба движения в одной транзакции. */
export async function transfer(c: pg.PoolClient, tenantId: string, userId: string | null,
  from: string, to: string, item: Omit<Move, "type" | "locationId" | "qty">, qty: number, comment?: string | null) {
  if (from === to) throw new BadRequestException("Ячейки совпадают");
  if (qty <= 0) throw new BadRequestException("Количество должно быть больше нуля");
  await applyMovement(c, tenantId, userId, { ...item, type: "transfer_out", locationId: from, qty: -qty, comment });
  await applyMovement(c, tenantId, userId, { ...item, type: "transfer_in", locationId: to, qty, comment });
}

/** Доступно = остаток − активные резервы (для вариантов моделей). */
export async function availableForVariant(c: pg.PoolClient, variantId: string): Promise<{ onHand: number; reserved: number; available: number }> {
  const s = (await c.query("SELECT COALESCE(sum(qty),0)::float8 AS q FROM stock_balances sb JOIN locations l ON l.id=sb.location_id JOIN warehouses w ON w.id=l.warehouse_id WHERE sb.variant_id=$1 AND w.kind='finished'", [variantId])).rows[0].q;
  const r = (await c.query("SELECT COALESCE(sum(qty),0)::float8 AS q FROM reservations WHERE variant_id=$1 AND status='active'", [variantId])).rows[0].q;
  return { onHand: s, reserved: r, available: s - r };
}

/** Сверка: баланс по каждой позиции должен равняться сумме движений. Возвращает расхождения. */
export async function reconcile(c: pg.PoolClient, fix: boolean) {
  const diffs = (await c.query(
    `WITH mv AS (
       SELECT tenant_id, location_id, material_id, variant_id, lot_id, sum(qty) AS q
         FROM stock_movements GROUP BY 1,2,3,4,5),
     bal AS (
       SELECT tenant_id, location_id, material_id, variant_id, lot_id, qty AS q FROM stock_balances)
     SELECT COALESCE(mv.tenant_id,bal.tenant_id) AS tenant_id, COALESCE(mv.location_id,bal.location_id) AS location_id,
            COALESCE(mv.material_id,bal.material_id) AS material_id, COALESCE(mv.variant_id,bal.variant_id) AS variant_id,
            COALESCE(mv.lot_id,bal.lot_id) AS lot_id,
            COALESCE(mv.q,0)::float8 AS from_movements, COALESCE(bal.q,0)::float8 AS in_balance
       FROM mv FULL JOIN bal ON mv.tenant_id=bal.tenant_id AND mv.location_id=bal.location_id
        AND mv.material_id IS NOT DISTINCT FROM bal.material_id AND mv.variant_id IS NOT DISTINCT FROM bal.variant_id
        AND mv.lot_id IS NOT DISTINCT FROM bal.lot_id
      WHERE COALESCE(mv.q,0) <> COALESCE(bal.q,0)`)).rows;
  if (fix) for (const d of diffs) {
    await c.query(
      `UPDATE stock_balances SET qty=$6, updated_at=now() WHERE tenant_id=$1 AND location_id=$2
         AND k_material=$3 AND k_variant=$4 AND k_lot=$5`,
      [d.tenant_id, d.location_id, d.material_id ?? ZERO, d.variant_id ?? ZERO, d.lot_id ?? ZERO, d.from_movements]);
  }
  return diffs;
}
