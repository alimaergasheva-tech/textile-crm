import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDocs } from "../src/export-orders/ved.ts";

const ship = { number: "X-1-S1", carrier: "TIR", plate: "01A", weight_kg: 1000, volume_m3: 80, cartons: 100 };
const lines = [{ modelId: "a", model: "T1", qty: 1000, cartons: 50, unitPrice: 3.5 }, { modelId: "b", model: "S1", qty: 500, cartons: 50, unitPrice: 7 }];
const full = { seller: { name: "F", address: "a", tin: "1" }, consignee: { name: "K", address: "b" }, invoiceNo: "1", invoiceDate: "2027-03-01", incoterms: "FCA",
  models: { a: { description: "T-shirt", hs: "6109100000", netKg: 0.25 }, b: { description: "Sweatshirt", hs: "6110209900", netKg: 0.95 } } };

test("итоги: суммы, нетто, количество", () => {
  const r = computeDocs(ship, lines, full);
  assert.equal(r.totals.qty, 1500); assert.equal(r.totals.amount, 7000); assert.equal(r.totals.netKg, 725);
  assert.equal(r.lines[0].amount, 3500); assert.deepEqual(r.missing, []);
});
test("пустые реквизиты попадают в список недостающих", () => {
  const r = computeDocs({ ...ship, plate: null }, lines, {});
  assert.ok(r.missing.includes("Номер машины")); assert.ok(r.missing.includes("Продавец: название")); assert.ok(r.missing.some((m) => m.startsWith("T1: код ТН ВЭД")));
});
test("нетто больше брутто — предупреждение", () => {
  const r = computeDocs({ ...ship, weight_kg: 500 }, lines, full);
  assert.ok(r.missing.some((m) => m.includes("нетто больше брутто")));
});
