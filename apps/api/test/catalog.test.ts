import { test } from "node:test";
import assert from "node:assert/strict";
import { calcRequirement } from "../src/catalog/bom.ts";
import { ean13 } from "../src/catalog/ean.ts";
import { ean13Modules, buildLabelsPdf } from "../src/catalog/labels.ts";

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

test("Этикетки: EAN-13 даёт 95 модулей с рамками, неверный код отвергается", () => {
  const m = ean13Modules("4006381333931"); // известный пример из спецификации EAN
  assert.equal(m.length, 95);
  assert.equal(m.slice(0, 3), "101");
  assert.equal(m.slice(45, 50), "01010");
  assert.equal(m.slice(92), "101");
  assert.equal(ean13Modules(ean13(12345)).length, 95);
  assert.throws(() => ean13Modules("4006381333932"));
  assert.throws(() => ean13Modules("123"));
});

test("Этикетки: PDF собирается для a4 и thermal", async () => {
  const it = { sku: "T-1-WHT-M", barcode: ean13(1), model_code: "T-1", model_name: "Футболка", color: "Белый", size: "M" };
  for (const f of ["a4", "thermal"] as const) {
    const buf = await buildLabelsPdf([it, it], f, 12);
    assert.equal(buf.subarray(0, 4).toString(), "%PDF");
  }
});
