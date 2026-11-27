import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTransition, PROD_FLOW } from "../src/production/flow.ts";

test("задание проходит все статусы по порядку", () => {
  for (const [a, b] of [["draft", "planned"], ["planned", "in_progress"], ["in_progress", "qc"], ["qc", "stocked"], ["stocked", "closed"]])
    assert.doesNotThrow(() => assertTransition(a, b));
});
test("недопустимые переходы отклоняются", () => {
  for (const [a, b] of [["draft", "in_progress"], ["planned", "qc"], ["closed", "draft"], ["cancelled", "planned"], ["stocked", "cancelled"], ["in_progress", "stocked"]])
    assert.throws(() => assertTransition(a, b), a + "→" + b);
});
test("из закрытого и отменённого выхода нет", () => {
  assert.deepEqual(PROD_FLOW.closed, []);
  assert.deepEqual(PROD_FLOW.cancelled, []);
});
