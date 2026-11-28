import type { CalcParams } from "./consumption.ts";

type Trims = Record<"cordM" | "tipsPcs" | "elastic25M" | "elastic35M" | "bowM" | "ttSmall" | "ttLarge" | "hangtag" | "polybag" | "cartons", number>;
export interface CostInput {
  params: CalcParams;
  accPrices: Record<string, number>;
  models: { code: string; qty: number; parts: { kg: number; priceUsdKg: number }[]; trims: Trims }[];
}
export interface CostLine {
  code: string; qty: number; fabricUsd: number; trimsUsd: number; otherUsd: number; cmtUsd: number; totalUsd: number;
  costPerSet: number; pricePerSet: number; revenueUsd: number; profitUsd: number;
}
export interface CostResult { lines: CostLine[]; totals: { qty: number; costUsd: number; revenueUsd: number; profitUsd: number; avgCostPerSet: number; avgPricePerSet: number; logisticsUsd: number; avgPriceWithLogistics: number }; warnings: string[] }

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/** Стоимость трима по справочнику цен: код позиции → количество. */
export function trimsCost(t: Trims, price: (code: string) => number): number {
  return t.cordM * price("CORD") + t.tipsPcs * price("TIPS") + t.elastic25M * price("ELASTIC25") + t.elastic35M * price("ELASTIC35") + t.bowM * price("BOW")
    + t.ttSmall * price("TT-S") + t.ttLarge * price("TT-L") + t.hangtag * price("HANGTAG") + t.polybag * price("POLY30") + t.cartons * price("CARTON");
}

/**
 * Себестоимость и цена FOB по моделям. Цена = себестоимость / (1 − маржа), то есть маржа считается от цены.
 * Полотно считается по расчётному расходу (без страхового запаса к заказу), фурнитура — с запасом, как в закупке.
 */
export function costOrder(inp: CostInput): CostResult {
  const p = inp.params, price = (code: string) => inp.accPrices[code] ?? 0;
  const warnings: string[] = [];
  if (p.marginPct >= 1) throw new Error("Маржа должна быть меньше 100%");
  const lines: CostLine[] = inp.models.map((m) => {
    const fabricUsd = m.parts.reduce((a, x) => a + x.kg * x.priceUsdKg, 0);
    const trimsUsd = trimsCost(m.trims, price);
    const otherUsd = m.qty * p.otherPerSetUsd, cmtUsd = m.qty * p.cmtUsd;
    const totalUsd = fabricUsd + trimsUsd + otherUsd + cmtUsd;
    const costPerSet = m.qty ? totalUsd / m.qty : 0;
    const pricePerSet = costPerSet / (1 - p.marginPct);
    const revenueUsd = pricePerSet * m.qty;
    return { code: m.code, qty: m.qty, fabricUsd: r2(fabricUsd), trimsUsd: r2(trimsUsd), otherUsd: r2(otherUsd), cmtUsd: r2(cmtUsd), totalUsd: r2(totalUsd),
      costPerSet: r4(costPerSet), pricePerSet: r4(pricePerSet), revenueUsd: r2(revenueUsd), profitUsd: r2(revenueUsd - totalUsd) };
  });
  const qty = lines.reduce((a, l) => a + l.qty, 0);
  const costUsd = lines.reduce((a, l) => a + l.totalUsd, 0), revenueUsd = lines.reduce((a, l) => a + l.revenueUsd, 0);
  if (lines.some((l) => l.fabricUsd === 0)) warnings.push("Часть моделей без стоимости полотна: проверьте цены за кг и назначение полотна.");
  if (lines.some((l) => l.trimsUsd === 0)) warnings.push("Часть моделей без стоимости фурнитуры: заполните цены в «Полотна и фурнитура».");
  const avgPrice = qty ? revenueUsd / qty : 0;
  return { lines, warnings, totals: { qty, costUsd: r2(costUsd), revenueUsd: r2(revenueUsd), profitUsd: r2(revenueUsd - costUsd),
    avgCostPerSet: r4(qty ? costUsd / qty : 0), avgPricePerSet: r4(avgPrice), logisticsUsd: r2(qty * p.logisticsUsd), avgPriceWithLogistics: r4(avgPrice + p.logisticsUsd) } };
}
