import type pg from "pg";
import { CalcParams, isLargeSize, kgMain, kgRib, mergeParams, Measure, patternArea } from "./consumption.ts";
import { SIZES } from "./parsers.ts";

const SZ = SIZES.map(String);
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export interface PartRow { part: "top" | "bottom" | "rib"; fabricId: string | null; fabricName: string | null; gsm: number | null; priceUsdKg: number; pattern: string | null; kg: number; kgPerPiece: Record<string, number> }
export interface Trims { cordM: number; tipsPcs: number; elastic25M: number; elastic35M: number; bowM: number; ttSmall: number; ttLarge: number; hangtag: number; polybag: number; cartons: number }

/** Расход полотна и фурнитуры по заказу (чистый расчёт из моделей, табелей мер и параметров). Используется расходом, себестоимостью и КП. */
export async function computeConsumption(c: pg.PoolClient, id: string) {
  const o = (await c.query("SELECT id,number,calc_params,version FROM export_orders WHERE id=$1", [id])).rows[0];
  if (!o) return null;
  const p = mergeParams(o.calc_params);
  const models = (await c.query(
    `SELECT m.id,m.code,m.qty,m.size_qty,m.tee_pattern_id,m.skirt_pattern_id,m.fabric_top_id,m.fabric_bottom_id,m.fabric_rib_id,m.spec,
            tp.code AS tee_code,sp.code AS skirt_code
       FROM export_models m LEFT JOIN patterns tp ON tp.id=m.tee_pattern_id LEFT JOIN patterns sp ON sp.id=m.skirt_pattern_id
      WHERE m.order_id=$1 ORDER BY m.sort,m.code`, [id])).rows;
  const fabrics = new Map<string, { id: string; name: string; gsm: number; price: number; kind: string }>(
    (await c.query("SELECT id,name,gsm,price_usd_kg,kind FROM export_fabrics")).rows.map((f: any) => [f.id, { id: f.id, name: f.name, gsm: f.gsm, price: Number(f.price_usd_kg), kind: f.kind }]));
  const prices = new Map<string, number>((await c.query("SELECT code,price_usd FROM export_accessories")).rows.map((a: any) => [a.code, Number(a.price_usd)]));
  const measures = new Map<string, Measure[]>();
  for (const row of (await c.query("SELECT p.id,m.name,m.vals FROM patterns p JOIN pattern_measures m ON m.pattern_id=p.id ORDER BY m.sort")).rows)
    (measures.get(row.id) ?? measures.set(row.id, []).get(row.id)!).push({ name: row.name, vals: row.vals });

  const warnings: string[] = [];
  const outModels: any[] = [];
  const byFabric = new Map<string, { kg: number; models: Set<string> }>();
  const totalTrims: Trims = { cordM: 0, tipsPcs: 0, elastic25M: 0, elastic35M: 0, bowM: 0, ttSmall: 0, ttLarge: 0, hangtag: 0, polybag: 0, cartons: 0 };
  const w = 1 + p.trimsReserve;

  for (const m of models) {
    const sq: Record<string, number> = m.size_qty ?? {};
    const qty = sum(SZ.map((s) => sq[s] ?? 0)) || m.qty;
    const parts: PartRow[] = [];
    const addPart = (part: PartRow["part"], patternId: string | null, patternCode: string | null, fabricId: string | null, ribOf: boolean) => {
      const fab = fabricId ? fabrics.get(fabricId) : undefined;
      const row: PartRow = { part, fabricId, fabricName: fab?.name ?? null, gsm: fab?.gsm ?? null, priceUsdKg: fab?.price ?? 0, pattern: patternCode, kg: 0, kgPerPiece: {} };
      const manual = part === "top" ? Number(m.spec?.kg_per_piece_top) : 0; // расход, заданный вручную (кг на изделие), если выкройки нет
      if (manual > 0 && fab) {
        row.pattern = "вручную";
        for (const s of SZ) if ((sq[s] ?? 0) > 0) row.kgPerPiece[s] = manual;
        row.kg = manual * qty;
      } else if (!patternId || !patternCode) warnings.push(`${m.code}: не назначена выкройка (${part === "bottom" ? "юбка-шорты" : "футболка"})`);
      else if (!fab) { if (!(ribOf && !fabricId)) warnings.push(`${m.code}: не назначено полотно (${part})`); }
      else if (!measures.get(patternId)?.length) warnings.push(`${m.code}: у выкройки ${patternCode} нет табеля мер`);
      else {
        const a = patternArea(patternCode, measures.get(patternId)!, p);
        for (const miss of a.missing) warnings.push(`${m.code}/${patternCode}: нет мерки «${miss}»`);
        for (const s of SZ) {
          const per = part === "rib" ? (a.ribCm[s] !== undefined ? kgRib(a.ribCm[s], fab.gsm, p) : undefined) : (a.areaCm2[s] !== undefined ? kgMain(a.areaCm2[s], fab.gsm, p) : undefined);
          if (per === undefined) { if ((sq[s] ?? 0) > 0 && !(part === "rib" && !Object.keys(a.ribCm).length)) warnings.push(`${m.code}: нет данных для размера ${s} (${patternCode})`); continue; }
          row.kgPerPiece[s] = r3(per * 1000) / 1000;
          row.kg += per * (sq[s] ?? 0);
        }
      }
      row.kg = r3(row.kg);
      if (fabricId && row.kg > 0) {
        const b = byFabric.get(fabricId) ?? byFabric.set(fabricId, { kg: 0, models: new Set() }).get(fabricId)!;
        b.kg += row.kg; b.models.add(m.code);
      }
      parts.push(row);
    };
    addPart("top", m.tee_pattern_id, m.tee_code, m.fabric_top_id, false);
    // Одиночное изделие с расходом, заданным вручную (футболка, свитшот, брюки), нижней части не имеет
    if (!(Number(m.spec?.kg_per_piece_top) > 0)) addPart("bottom", m.skirt_pattern_id, m.skirt_code, m.fabric_bottom_id, false);
    if (m.fabric_rib_id) addPart("rib", m.tee_pattern_id, m.tee_code, m.fabric_rib_id, true);

    // Фурнитура юбки-шорт и упаковка по размерам.
    const t: Trims = { cordM: 0, tipsPcs: 0, elastic25M: 0, elastic35M: 0, bowM: 0, ttSmall: 0, ttLarge: 0, hangtag: 0, polybag: 0, cartons: 0 };
    const skirt = m.skirt_pattern_id && m.skirt_code ? patternArea(m.skirt_code, measures.get(m.skirt_pattern_id) ?? [], p) : null;
    for (const s of SZ) {
      const n = sq[s] ?? 0; if (!n) continue;
      if (skirt) {
        if (skirt.elasticMm === 25) { t.cordM += (skirt.cordCm[s] ?? 0) * n / 100; t.tipsPcs += 2 * n; t.elastic25M += (skirt.elasticCm[s] ?? 0) * n / 100; }
        if (skirt.elasticMm === 35) { t.elastic35M += (skirt.elasticCm[s] ?? 0) * n / 100; t.bowM += p.bowCordCm * n / 100; }
      }
      if (isLargeSize(s)) t.ttLarge += n; else t.ttSmall += n;
    }
    t.hangtag = qty; t.polybag = qty;
    for (const k of Object.keys(t) as (keyof Trims)[]) t[k] = Math.ceil(t[k] * w);
    t.cartons = Math.ceil(qty / p.unitsPerCarton);
    for (const k of Object.keys(t) as (keyof Trims)[]) totalTrims[k] += t[k];
    outModels.push({ id: m.id, code: m.code, qty, tee: m.tee_code, skirt: m.skirt_code, parts, trims: t });
  }

  const fabricTotals = [...byFabric.entries()].map(([fid, b]) => {
    const f = fabrics.get(fid)!;
    const kgOrder = r3(b.kg * (1 + p.fabricOrderReserve));
    return { fabricId: fid, name: f.name, gsm: f.gsm, kind: f.kind, kg: r3(b.kg), kgOrder, meters: Math.round(kgOrder * 1000 / (f.gsm * p.fabricWidthM)),
      priceUsdKg: f.price, costUsd: Math.round(kgOrder * f.price * 100) / 100, models: [...b.models] };
  }).sort((a, b) => b.kgOrder - a.kgOrder);
  const price = (code: string) => prices.get(code) ?? 0;
  const trimCost = Math.round((totalTrims.cordM * price("CORD") + totalTrims.tipsPcs * price("TIPS") + totalTrims.elastic25M * price("ELASTIC25") + totalTrims.elastic35M * price("ELASTIC35")
    + totalTrims.bowM * price("BOW") + totalTrims.ttSmall * price("TT-S") + totalTrims.ttLarge * price("TT-L") + totalTrims.hangtag * price("HANGTAG")
    + totalTrims.polybag * price("POLY30") + totalTrims.cartons * price("CARTON")) * 100) / 100;
  if (fabricTotals.some((f) => f.priceUsdKg === 0)) warnings.push("У части полотен не указана цена за кг («Полотна и фурнитура»)");
  if (!prices.size || [...prices.values()].every((v) => v === 0)) warnings.push("Цены фурнитуры не заполнены («Полотна и фурнитура»)");
  if (outModels.some((m) => m.skirt === "GSH04")) warnings.push("GSH04: длина резинки принята как 2×собранный пояс + 2 см, длина бантика — параметр «bowCordCm» (в табеле нет). Уточнить у технолога.");
  return { orderId: id, version: o.version, params: p, accPrices: Object.fromEntries(prices), models: outModels, fabrics: fabricTotals, trims: totalTrims,
    totals: { fabricKg: r3(sum(fabricTotals.map((f) => f.kgOrder))), fabricCostUsd: Math.round(sum(fabricTotals.map((f) => f.costUsd)) * 100) / 100, trimsCostUsd: trimCost },
    warnings: [...new Set(warnings)] };

}
