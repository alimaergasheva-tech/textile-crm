import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, verdict } from "../src/export-orders/aql.ts";

test("партия 3000 (KOTON): уровень II, код K, выборка 125; AQL 2.5 → 7/8, AQL 4.0 → 10/11", () => {
  assert.deepEqual(plan(3000, 2.5), { lot: 3000, code: "K", sampleSize: 125, ac: 7, re: 8 });
  assert.deepEqual(plan(3000, 4), { lot: 3000, code: "K", sampleSize: 125, ac: 10, re: 11 });
});
test("типовые партии при AQL 2.5", () => {
  assert.equal(plan(1000, 2.5).sampleSize, 80); assert.equal(plan(1000, 2.5).ac, 5);
  assert.equal(plan(5000, 2.5).sampleSize, 200); assert.equal(plan(5000, 2.5).ac, 10);
  assert.equal(plan(12000, 2.5).sampleSize, 315); assert.equal(plan(12000, 2.5).ac, 14);
  assert.equal(plan(50000, 2.5).ac, 21);
});
test("партия меньше выборки проверяется целиком, допуск 0", () => {
  const p = plan(1, 2.5); assert.equal(p.sampleSize, 1); assert.equal(p.ac, 0); assert.equal(p.re, 1);
});
test("вердикт: критический дефект — отказ, превышение major — отказ, в пределах — принято", () => {
  assert.equal(verdict([{ severity: "major", qty: 7 }, { severity: "minor", qty: 10 }], 7, 10).result, "pass");
  assert.equal(verdict([{ severity: "major", qty: 8 }], 7, 10).result, "fail");
  const v = verdict([{ severity: "critical", qty: 1 }], 7, 10); assert.equal(v.result, "fail"); assert.match(v.reasons[0], /критических/);
});
