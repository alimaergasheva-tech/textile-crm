/** Документы ВЭД по отгрузке: расчёт строк и итогов, проверка полноты реквизитов. */
export interface Party { name?: string; address?: string; tin?: string; bank?: string }
export interface ModelDet { description?: string; hs?: string; composition?: string; netKg?: number }
export interface Details {
  seller?: Party; consignee?: Party; invoiceNo?: string; invoiceDate?: string; incoterms?: string; place?: string; origin?: string; paymentTerms?: string;
  loadingPlace?: string; deliveryPlace?: string; driver?: string; trailer?: string; remarks?: string;
  models?: Record<string, ModelDet>;
  /** Реквизиты ГТД (ТД-1/ТД-2): ключ → значение, набор ключей задаёт экран. */
  gtd?: Record<string, string>;
}
export interface LineIn { modelId: string; model: string; qty: number; cartons: number | null; unitPrice: number | null }
export interface ShipIn { number: string; carrier: string | null; plate: string | null; weight_kg: number | null; volume_m3: number | null; cartons: number | null }
export interface DocLine { modelId: string; model: string; description: string; hs: string; composition: string; qty: number; unitPrice: number; amount: number; netKg: number; cartons: number | null }
const r2 = (n: number) => Math.round(n * 100) / 100;

export function computeDocs(ship: ShipIn, lines: LineIn[], d: Details) {
  const out: DocLine[] = lines.map((l) => {
    const m = d.models?.[l.modelId] ?? {};
    const unit = Number(l.unitPrice ?? 0);
    return { modelId: l.modelId, model: l.model, description: m.description ?? "", hs: m.hs ?? "", composition: m.composition ?? "", qty: l.qty, unitPrice: unit, amount: r2(l.qty * unit),
      netKg: r2(l.qty * Number(m.netKg ?? 0)), cartons: l.cartons };
  });
  const sum = (f: (x: DocLine) => number) => out.reduce((a, x) => a + f(x), 0);
  const cartonsLines = sum((x) => x.cartons ?? 0);
  const totals = { qty: sum((x) => x.qty), amount: r2(sum((x) => x.amount)), netKg: r2(sum((x) => x.netKg)), grossKg: ship.weight_kg ?? 0, cartons: ship.cartons ?? (cartonsLines || 0), volumeM3: ship.volume_m3 ?? 0 };
  const missing: string[] = [];
  const need = (ok: unknown, what: string) => { if (!ok) missing.push(what); };
  need(d.seller?.name, "Продавец: название"); need(d.seller?.address, "Продавец: адрес"); need(d.seller?.tin, "Продавец: ИНН");
  need(d.consignee?.name, "Покупатель: название"); need(d.consignee?.address, "Покупатель: адрес");
  need(d.invoiceNo, "Номер инвойса"); need(d.invoiceDate, "Дата инвойса"); need(d.incoterms, "Incoterms");
  for (const l of out) {
    need(l.hs, `${l.model}: код ТН ВЭД`); need(l.description, `${l.model}: описание товара`);
    need(l.unitPrice > 0, `${l.model}: цена за штуку (клиентская цена в модели)`); need(l.netKg > 0, `${l.model}: вес нетто одного изделия`);
  }
  need(ship.carrier, "Перевозчик"); need(ship.plate, "Номер машины"); need(totals.grossKg > 0, "Вес брутто отгрузки"); need(totals.cartons > 0, "Количество коробок");
  if (totals.grossKg > 0 && totals.netKg > totals.grossKg) missing.push("Вес нетто больше брутто — проверьте веса");
  return { lines: out, totals, missing };
}
