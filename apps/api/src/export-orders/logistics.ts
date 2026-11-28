/** Логистика: объём и вес коробов, число машин и раскладка по машинам. */
export interface Truck { code: string; name: string; m3: number; kg: number }
export const TRUCKS: Truck[] = [
  { code: "tilt", name: "Тент 13,6 м", m3: 82, kg: 22000 },
  { code: "mega", name: "Мега-трейлер", m3: 100, kg: 22000 },
  { code: "van", name: "Рефрижератор/фургон 7,2 м", m3: 40, kg: 10000 },
];
export interface ModelIn { id: string; code: string; qty: number; pcsPerCarton: number; cartonL: number; cartonW: number; cartonH: number; cartonKg: number }
export const cartonM3 = (l: number, w: number, h: number) => (l * w * h) / 1e6;
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface TruckLoad { n: number; cartons: number; m3: number; kg: number; fillM3: number; fillKg: number; items: { id: string; code: string; cartons: number; pcs: number }[] }
/**
 * Расчёт: коробов = ceil(qty / штук в коробе); вместимость машины по объёму = m3 × коэффициент укладки,
 * по весу — kg. Короба раскладываются по машинам последовательно (модель за моделью), пока не упрутся в объём или вес.
 */
export function planLoad(models: ModelIn[], truck: Truck, fill = 0.9) {
  const capM3 = truck.m3 * fill, capKg = truck.kg;
  const rows = models.filter((m) => m.qty > 0).map((m) => {
    const cartons = Math.ceil(m.qty / m.pcsPerCarton), v = cartonM3(m.cartonL, m.cartonW, m.cartonH);
    return { ...m, cartons, cartonM3: v, m3: r2(cartons * v), kg: r2(cartons * m.cartonKg) };
  });
  const totals = { cartons: rows.reduce((a, x) => a + x.cartons, 0), m3: r2(rows.reduce((a, x) => a + x.cartons * x.cartonM3, 0)), kg: r2(rows.reduce((a, x) => a + x.kg, 0)), pcs: rows.reduce((a, x) => a + x.qty, 0) };
  const trucks: TruckLoad[] = [];
  let cur: TruckLoad | null = null;
  const fresh = (): TruckLoad => ({ n: trucks.length + 1, cartons: 0, m3: 0, kg: 0, fillM3: 0, fillKg: 0, items: [] });
  for (const m of rows) {
    let left = m.cartons;
    while (left > 0) {
      if (!cur) { cur = fresh(); trucks.push(cur); }
      const byVol = Math.floor((capM3 - cur.m3 + 1e-9) / m.cartonM3), byKg = Math.floor((capKg - cur.kg + 1e-9) / m.cartonKg);
      const take = Math.min(left, byVol, byKg);
      if (take <= 0) {
        if (cur.cartons === 0) throw new Error(`${m.code}: короб не помещается в машину (объём или вес больше вместимости)`);
        cur = null; continue;
      }
      cur.cartons += take; cur.m3 = r2(cur.m3 + take * m.cartonM3); cur.kg = r2(cur.kg + take * m.cartonKg);
      const pcs = Math.min(take * m.pcsPerCarton, m.qty - (m.cartons - left) * m.pcsPerCarton);
      cur.items.push({ id: m.id, code: m.code, cartons: take, pcs });
      left -= take;
    }
  }
  for (const t of trucks) { t.fillM3 = Math.round((t.m3 / truck.m3) * 100); t.fillKg = Math.round((t.kg / truck.kg) * 100); }
  const minByVol = Math.ceil(totals.m3 / capM3 - 1e-9), minByKg = Math.ceil(totals.kg / capKg - 1e-9);
  return { rows, totals, trucks, truck, fill, minByVol, minByKg, limit: minByKg > minByVol ? "weight" : "volume" };
}
