import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDates, deriveStatus, isApproved, needsNewRound } from "../src/export-orders/samples.ts";

test("статус выводится из заполненных полей", () => {
  assert.equal(deriveStatus({}), "planned");
  assert.equal(deriveStatus({ madeAt: "2026-12-01" }), "made");
  assert.equal(deriveStatus({ madeAt: "2026-12-01", sentAt: "2026-12-02" }), "sent");
  assert.equal(deriveStatus({ madeAt: "2026-12-01", sentAt: "2026-12-02", deliveredAt: "2026-12-05" }), "delivered");
  assert.equal(deriveStatus({ sentAt: "2026-12-02", decision: "approved_comments" }), "approved_comments");
});
test("проверка последовательности дат", () => {
  assert.equal(checkDates({ madeAt: "2026-12-01", sentAt: "2026-12-02", deliveredAt: "2026-12-05" }), null);
  assert.match(checkDates({ madeAt: "2026-12-03", sentAt: "2026-12-02" })!, /раньше/);
  assert.match(checkDates({ sentAt: "2026-12-02" })!, /сшитый/);
  assert.match(checkDates({ madeAt: "2026-12-01", decision: "approved" })!, /после отправки/);
});
test("одобрение и новый круг", () => {
  assert.ok(isApproved("approved") && isApproved("approved_comments") && !isApproved("rejected"));
  assert.ok(needsNewRound("rejected") && needsNewRound("approved_comments") && !needsNewRound("approved"));
});
