/** Масштабирует размерную раскладку до целевого количества методом наибольших остатков (сумма точно = target). */
export function scaleQty(sizeQty: Record<string, number>, target: number): Record<string, number> {
  const keys = Object.keys(sizeQty);
  const total = keys.reduce((a, k) => a + sizeQty[k], 0);
  if (!total || target < 0) return { ...sizeQty };
  const raw = keys.map((k) => ({ k, v: (sizeQty[k] * target) / total }));
  const out: Record<string, number> = {};
  let used = 0;
  for (const r of raw) { out[r.k] = Math.floor(r.v); used += out[r.k]; }
  const order = [...raw].sort((a, b) => (b.v - Math.floor(b.v)) - (a.v - Math.floor(a.v)));
  for (let i = 0; i < target - used; i++) out[order[i % order.length].k] += 1;
  return out;
}
