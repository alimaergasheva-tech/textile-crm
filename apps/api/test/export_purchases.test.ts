import { test } from "node:test";
import assert from "node:assert/strict";
import { canMove, fabricLines, lineTotal, sumLines, trimLines } from "../src/export-orders/purchases.ts";

test("строки полотна: кг заказа и цена за кг, нулевые пропускаются", () => {
  const l = fabricLines([{ fabricId: "a", name: "Кулирная гладь 150", kgOrder: 1650, priceUsdKg: 6 }, { fabricId: "b", name: "x", kgOrder: 0, priceUsdKg: 6 }]);
  assert.equal(l.length, 1);
  assert.equal(sumLines(l), 9900);
});
test("фурнитура: только позиции с количеством, единицы и цены из справочника", () => {
  const t = { cordM: 0, tipsPcs: 0, elastic25M: 0, elastic35M: 0, bowM: 0, ttSmall: 0, ttLarge: 0, hangtag: 12360, polybag: 12360, cartons: 309 };
  const l = trimLines(t, { HANGTAG: "Бирка" }, { HANGTAG: 0.05, POLY30: 0.05, CARTON: 0.05 });
  assert.deepEqual(l.map((x) => x.itemCode), ["HANGTAG", "POLY30", "CARTON"]);
  assert.equal(l[0].name, "Бирка"); assert.equal(l[1].name, "POLY30");
  assert.equal(sumLines(l), lineTotal(12360, 0.05) * 2 + lineTotal(309, 0.05));
});
test("переходы статусов заказа поставщику", () => {
  assert.ok(canMove("draft", "sent")); assert.ok(canMove("sent", "confirmed")); assert.ok(canMove("shipped", "received"));
  assert.ok(!canMove("draft", "received")); assert.ok(!canMove("received", "cancelled")); assert.ok(!canMove("cancelled", "sent"));
});
