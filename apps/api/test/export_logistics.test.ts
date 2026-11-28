import { test } from "node:test";
import assert from "node:assert/strict";
import { cartonM3, planLoad, TRUCKS } from "../src/export-orders/logistics.ts";

const tilt = TRUCKS[0];
const m = (id: string, qty: number, over = {}) => ({ id, code: id, qty, pcsPerCarton: 50, cartonL: 60, cartonW: 40, cartonH: 40, cartonKg: 14, ...over });

test("объём короба в м³", () => assert.equal(cartonM3(60, 40, 40), 0.096));
test("3000 шт по 50 в коробе = 60 коробов, вес и объём", () => {
  const p = planLoad([m("a", 3000)], tilt);
  assert.equal(p.totals.cartons, 60); assert.equal(p.totals.m3, 5.76); assert.equal(p.totals.kg, 840); assert.equal(p.trucks.length, 1);
});
test("несколько машин: короба делятся, штуки сходятся", () => {
  const p = planLoad([m("a", 40000), m("b", 10000)], tilt);
  assert.ok(p.trucks.length >= 2);
  const pcs = (c: string) => p.trucks.flatMap((t) => t.items).filter((i) => i.code === c).reduce((a, i) => a + i.pcs, 0);
  assert.equal(pcs("a"), 40000); assert.equal(pcs("b"), 10000);
  for (const t of p.trucks) { assert.ok(t.m3 <= tilt.m3 * 0.9 + 1e-6); assert.ok(t.kg <= tilt.kg); }
});
test("ограничение по весу", () => {
  const p = planLoad([m("a", 20000, { cartonKg: 60 })], tilt);
  assert.equal(p.limit, "weight"); assert.equal(p.trucks.length, p.minByKg);
});
test("короб больше машины — ошибка", () => assert.throws(() => planLoad([m("a", 100, { cartonL: 1000, cartonW: 300, cartonH: 300 })], TRUCKS[2]), /не помещается/));
test("нулевое количество игнорируется", () => assert.equal(planLoad([m("a", 0)], tilt).trucks.length, 0));
