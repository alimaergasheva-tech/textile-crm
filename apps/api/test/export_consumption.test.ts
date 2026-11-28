import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PARAMS, kgMain, kgRib, mergeParams, patternArea } from "../src/export-orders/consumption.ts";

// Этап 11: формулы расхода сверены с Excel-моделью (лист «Площади»): GKT1/122 = 3612,75 см², GSH06/122 = 4510 см².
const gkt1 = [
  ["Ширина изделия под проймой", 42.5], ["Ширина изделия внизу", 42.5], ["Длина переда по вертик от плечевого шва", 37.5],
  ["Длина изделия по середине спинки", 36.8], ["Ширина рукава вверху", 17], ["Ширина рукава внизу", 15.5], ["Длина рукава", 14], ["1/2 длины планки горловины", 22.4],
].map(([name, v]) => ({ name: name as string, vals: { "122": v as number } }));

test("GKT1: площадь, кг полотна и длина рибаны", () => {
  const a = patternArea("GKT1", gkt1, DEFAULT_PARAMS);
  assert.deepEqual(a.missing, []);
  assert.ok(Math.abs(a.areaCm2["122"] - 3612.75) < 0.01);
  assert.ok(Math.abs(kgMain(a.areaCm2["122"], 150, DEFAULT_PARAMS) - 0.05853) < 0.0001);
  assert.equal(a.ribCm["122"], 44.8);
  assert.ok(Math.abs(kgRib(44.8, 220, DEFAULT_PARAMS) - 44.8 * 3 * 220 / 1e7 * 1.05) < 1e-9);
});

test("нет мерки — расчёт не падает, а возвращает список недостающих", () => {
  const a = patternArea("GKT1", gkt1.slice(0, 3), DEFAULT_PARAMS);
  assert.ok(a.missing.length >= 4);
  assert.equal(a.areaCm2["122"], undefined);
});

test("неизвестная выкройка не даёт расход, но сообщает причину", () => {
  assert.match(patternArea("XYZ", [], DEFAULT_PARAMS).missing[0], /нет формулы/);
});

test("параметры: мусор и отрицательные значения игнорируются", () => {
  const p = mergeParams({ wasteMain: 0.1, wasteRib: -1, bowCordCm: "x", unitsPerCarton: 50 });
  assert.equal(p.wasteMain, 0.1); assert.equal(p.wasteRib, DEFAULT_PARAMS.wasteRib);
  assert.equal(p.bowCordCm, DEFAULT_PARAMS.bowCordCm); assert.equal(p.unitsPerCarton, 50);
});
