import { test } from "node:test";
import assert from "node:assert/strict";
import { canShip, checkProduction, checkRemoval, pct, shippable } from "../src/export-orders/production.ts";

test("цепочка выпуска: пошив ≤ раскрой, упаковка ≤ пошив, раскрой ≤ заказ + 5%", () => {
  assert.equal(checkProduction({ cut: 0, sew: 0, pack: 0 }, "cut", 3100, 3000), null);
  assert.match(checkProduction({ cut: 3000, sew: 0, pack: 0 }, "cut", 200, 3000)!, /превышает заказ/);
  assert.match(checkProduction({ cut: 1000, sew: 900, pack: 0 }, "sew", 200, 3000)!, /Пошив/);
  assert.match(checkProduction({ cut: 1000, sew: 500, pack: 400 }, "pack", 200, 3000)!, /Упаковка/);
  assert.equal(checkProduction({ cut: 1000, sew: 500, pack: 400 }, "pack", 100, 3000), null);
});
test("удаление записи не ломает цепочку и не затрагивает отгруженное", () => {
  assert.match(checkRemoval({ cut: 1000, sew: 900, pack: 0 }, "cut", 200, 0)!, /пошив превысит/);
  assert.match(checkRemoval({ cut: 1000, sew: 900, pack: 800 }, "pack", 200, 700)!, /отгружена/);
  assert.equal(checkRemoval({ cut: 1000, sew: 900, pack: 800 }, "pack", 200, 500), null);
});
test("процент и остаток к отгрузке", () => {
  assert.equal(pct(750, 3000), 25); assert.equal(pct(5000, 3000), 100); assert.equal(pct(1, 0), 0);
  assert.equal(shippable(2000, 1500), 500); assert.equal(shippable(100, 300), 0);
});
test("статусы отгрузки", () => {
  assert.ok(canShip("planned", "loaded") && canShip("loaded", "in_transit") && canShip("in_transit", "delivered"));
  assert.ok(!canShip("planned", "delivered") && !canShip("delivered", "cancelled") && !canShip("in_transit", "cancelled"));
});
