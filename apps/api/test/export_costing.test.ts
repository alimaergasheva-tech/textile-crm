import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PARAMS } from "../src/export-orders/consumption.ts";
import { costOrder, trimsCost } from "../src/export-orders/costing.ts";

// Этап 12: цена = себестоимость / (1 − маржа); маржа считается от цены, а не от себестоимости.
const zero = { cordM: 0, tipsPcs: 0, elastic25M: 0, elastic35M: 0, bowM: 0, ttSmall: 0, ttLarge: 0, hangtag: 0, polybag: 0, cartons: 0 };
const prices = { CORD: 0.06, TIPS: 0.015, ELASTIC25: 0.14, "TT-S": 0.03, "TT-L": 0.04, HANGTAG: 0.03, POLY30: 0.02, CARTON: 0.8 };

test("фурнитура: сумма по ценам справочника", () => {
  const t = { ...zero, cordM: 100, tipsPcs: 200, hangtag: 10 };
  assert.ok(Math.abs(trimsCost(t, (c) => (prices as any)[c] ?? 0) - (100 * 0.06 + 200 * 0.015 + 10 * 0.03)) < 1e-9);
});

test("цена модели: маржа 12% от цены, пошив и прочее на комплект", () => {
  const r = costOrder({ params: { ...DEFAULT_PARAMS, cmtUsd: 2, otherPerSetUsd: 0.1, marginPct: 0.12 }, accPrices: prices,
    models: [{ code: "A", qty: 1000, parts: [{ kg: 100, priceUsdKg: 5 }, { kg: 50, priceUsdKg: 6 }], trims: { ...zero, hangtag: 1000 } }] });
  const l = r.lines[0];
  assert.equal(l.fabricUsd, 800);
  assert.equal(l.trimsUsd, 30);
  assert.equal(l.totalUsd, 800 + 30 + 100 + 2000);
  assert.ok(Math.abs(l.pricePerSet - (2930 / 1000) / 0.88) < 0.0001);
  assert.ok(Math.abs(l.profitUsd - (l.revenueUsd - 2930)) < 0.01);
  assert.ok(Math.abs(r.totals.profitUsd / r.totals.revenueUsd - 0.12) < 0.001);
});

test("маржа ≥ 100% отвергается, пустые цены дают предупреждение", () => {
  assert.throws(() => costOrder({ params: { ...DEFAULT_PARAMS, marginPct: 1 }, accPrices: {}, models: [] }), /Маржа/);
  const r = costOrder({ params: DEFAULT_PARAMS, accPrices: {}, models: [{ code: "A", qty: 10, parts: [{ kg: 1, priceUsdKg: 0 }], trims: zero }] });
  assert.equal(r.warnings.length, 2);
});
