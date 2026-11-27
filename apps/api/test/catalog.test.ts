import { test } from "node:test";
import assert from "node:assert/strict";
import { calcRequirement } from "../src/catalog/bom.ts";
import { ean13 } from "../src/catalog/ean.ts";

test("BOM: общая норма и отход", () => {
  const need = calcRequirement(
    [{ materialId: "fabric", sizeId: null, qtyPerUnit: 1.5, wastePercent: 10 }],
    [{ sizeId: "S", qty: 10 }, { sizeId: "M", qty: 20 }]);
  assert.equal(need.get("fabric"), 49.5); // 30 × 1.5 × 1.1
});

test("BOM: строка размера перекрывает общую норму", () => {
  const need = calcRequirement(
    [{ materialId: "fabric", sizeId: null, qtyPerUnit: 1, wastePercent: 0 },
     { materialId: "fabric", sizeId: "XL", qtyPerUnit: 1.4, wastePercent: 0 }],
    [{ sizeId: "S", qty: 10 }, { sizeId: "XL", qty: 10 }]);
  assert.equal(need.get("fabric"), 24); // 10×1 + 10×1.4
});

test("BOM: материал только для одного размера не считается для других", () => {
  const need = calcRequirement(
    [{ materialId: "zip", sizeId: "L", qtyPerUnit: 1, wastePercent: 0 }],
    [{ sizeId: "S", qty: 5 }, { sizeId: "L", qty: 7 }]);
  assert.equal(need.get("zip"), 7);
});

test("EAN-13: известное значение контрольной цифры", () => {
  assert.equal(ean13(1), "2000000000015");
  assert.equal(ean13(1).length, 13);
});
