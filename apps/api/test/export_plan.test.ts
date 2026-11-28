import { test } from "node:test";
import assert from "node:assert/strict";
import { TEMPLATE, schedule, endFrom, toDate, fmt, lateDays, workdaysBetween } from "../src/export-orders/plan.ts";

const mk = (sewing = 24) => TEMPLATE.map((t) => ({ seq: t.seq, days: t.days === "sewing" ? sewing : t.days, pred: t.pred, status: "todo" as const }));

test("рабочие дни: пятница + 1 → понедельник, выходные пропускаются", () => {
  assert.equal(fmt(endFrom(toDate("2026-12-04"), 2)), "2026-12-07");
  assert.equal(fmt(endFrom(toDate("2026-12-05"), 1)), "2026-12-07"); // суббота → понедельник
});
test("план по шаблону: 25 этапов, пошив 24 дня, выпуск 12.04.2027", () => {
  const s = schedule(mk(), "2026-11-30", "2026-11-30");
  assert.equal(s.length, 25);
  assert.equal(s[s.length - 1].end, "2027-04-12");
  for (const t of TEMPLATE) for (const p of t.pred) assert.ok(s[t.seq - 1].start > s[p - 1].end, `этап ${t.seq} начинается после ${p}`);
});
test("выполненный раньше срока этап сдвигает цепочку вперёд, невыполненный просроченный — назад", () => {
  const base = schedule(mk(), "2026-11-30", "2026-11-30");
  const early = mk().map((t) => t.seq === 1 ? { ...t, status: "done" as const, actualStart: "2026-11-30", actualEnd: "2026-11-30" } : t);
  assert.equal(schedule(early, "2026-11-30", "2026-11-30")[24].end, base[24].end);
  const slip = schedule(mk(), "2026-11-30", "2026-12-10"); // сегодня 10.12, ничего не сделано
  assert.ok(slip[0].end >= "2026-12-10" && slip[24].end > base[24].end);
});
test("цикл в предшественниках — ошибка", () => {
  assert.throws(() => schedule([{ seq: 1, days: 1, pred: [2], status: "todo" }, { seq: 2, days: 1, pred: [1], status: "todo" }], "2026-11-30", "2026-11-30"), /Цикл/);
});
test("просрочка и разница в рабочих днях", () => {
  assert.equal(lateDays("2026-11-20", "todo", "2026-11-28"), 8);
  assert.equal(lateDays("2026-11-20", "done", "2026-11-28"), 0);
  assert.equal(workdaysBetween(toDate("2026-12-04"), toDate("2026-12-07")), 1);
});
