/** Строки заказов поставщикам из расчёта расхода и допустимые переходы статуса. */
export interface PLine { itemCode: string; name: string; unit: string; qty: number; priceUsd: number }
export interface FabricTotal { fabricId: string; name: string; kgOrder: number; priceUsdKg: number }
export type TrimTotals = Record<"cordM" | "tipsPcs" | "elastic25M" | "elastic35M" | "bowM" | "ttSmall" | "ttLarge" | "hangtag" | "polybag" | "cartons", number>;

const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** Код позиции справочника фурнитуры → поле расчёта и единица. */
export const TRIM_MAP: { code: string; key: keyof TrimTotals; unit: string }[] = [
  { code: "CORD", key: "cordM", unit: "м" }, { code: "TIPS", key: "tipsPcs", unit: "шт" }, { code: "ELASTIC25", key: "elastic25M", unit: "м" },
  { code: "ELASTIC35", key: "elastic35M", unit: "м" }, { code: "BOW", key: "bowM", unit: "м" }, { code: "TT-S", key: "ttSmall", unit: "шт" },
  { code: "TT-L", key: "ttLarge", unit: "шт" }, { code: "HANGTAG", key: "hangtag", unit: "шт" }, { code: "POLY30", key: "polybag", unit: "шт" }, { code: "CARTON", key: "cartons", unit: "шт" },
];

export const fabricLines = (f: FabricTotal[]): PLine[] =>
  f.filter((x) => x.kgOrder > 0).map((x) => ({ itemCode: x.fabricId, name: x.name, unit: "кг", qty: r3(x.kgOrder), priceUsd: x.priceUsdKg }));

/** names — названия позиций справочника по коду; prices — цены за единицу. Нулевые количества пропускаются. */
export function trimLines(t: TrimTotals, names: Record<string, string>, prices: Record<string, number>): PLine[] {
  return TRIM_MAP.filter((m) => t[m.key] > 0).map((m) => ({ itemCode: m.code, name: names[m.code] ?? m.code, unit: m.unit, qty: r3(Math.ceil(t[m.key] * 1000) / 1000), priceUsd: prices[m.code] ?? 0 }));
}

export const lineTotal = (qty: number, price: number) => Math.round(qty * price * 100) / 100;
export const sumLines = (l: PLine[]) => Math.round(l.reduce((a, x) => a + lineTotal(x.qty, x.priceUsd), 0) * 100) / 100;

export const STATUSES = ["draft", "sent", "confirmed", "in_production", "shipped", "received", "cancelled"] as const;
export type PStatus = (typeof STATUSES)[number];
const NEXT: Record<PStatus, PStatus[]> = {
  draft: ["sent", "cancelled"], sent: ["confirmed", "cancelled"], confirmed: ["in_production", "shipped", "cancelled"],
  in_production: ["shipped", "cancelled"], shipped: ["received", "cancelled"], received: [], cancelled: [],
};
export const canMove = (from: PStatus, to: PStatus) => NEXT[from]?.includes(to) ?? false;
