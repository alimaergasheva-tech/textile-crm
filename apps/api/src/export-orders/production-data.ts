import type pg from "pg";
import { verdict } from "./aql.ts";
import { pct, shippable, type Totals } from "./production.ts";

/** Выпуск, отгрузки и итог AQL по моделям заказа (общее для производства, отгрузок и логистики). */
export async function orderTotals(c: pg.PoolClient, orderId: string) {
  const models = (await c.query("SELECT id,code,qty FROM export_models WHERE order_id=$1 ORDER BY sort,code", [orderId])).rows;
  const t = (await c.query("SELECT model_id,stage,sum(qty)::int AS q FROM export_production_log WHERE order_id=$1 GROUP BY 1,2", [orderId])).rows;
  const sh = (await c.query(
    `SELECT l.model_id, sum(l.qty)::int AS q FROM export_shipment_lines l JOIN export_shipments s ON s.id=l.shipment_id WHERE s.order_id=$1 AND s.status<>'cancelled' GROUP BY 1`, [orderId])).rows;
  const ins = (await c.query(
    `SELECT DISTINCT ON (model_id) model_id,id,ac_major,ac_minor FROM export_inspections WHERE order_id=$1 AND status='final' ORDER BY model_id, round DESC`, [orderId])).rows;
  const out = [];
  for (const m of models) {
    const g = (s: string) => Number(t.find((x: any) => x.model_id === m.id && x.stage === s)?.q ?? 0);
    const tot: Totals = { cut: g("cut"), sew: g("sew"), pack: g("pack") };
    const shipped = Number(sh.find((x: any) => x.model_id === m.id)?.q ?? 0);
    const i = ins.find((x: any) => x.model_id === m.id);
    let aql: "pass" | "fail" | "none" = "none";
    if (i) {
      const d = (await c.query("SELECT severity,qty FROM export_inspection_defects WHERE inspection_id=$1", [i.id])).rows;
      aql = verdict(d, i.ac_major, i.ac_minor).result;
    }
    out.push({ modelId: m.id, code: m.code, qty: Number(m.qty), ...tot, shipped, shippable: shippable(tot.pack, shipped), aql,
      pctCut: pct(tot.cut, Number(m.qty)), pctSew: pct(tot.sew, Number(m.qty)), pctPack: pct(tot.pack, Number(m.qty)) });
  }
  return out;
}

