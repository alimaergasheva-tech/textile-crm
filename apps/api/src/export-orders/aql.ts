/**
 * Выборочный контроль по ISO 2859-1 (ГОСТ Р ИСО 2859-1): общий уровень II, одноступенчатый, нормальный контроль.
 * Приёмочные числа (Ac) для AQL 2.5 и 4.0; Re = Ac + 1. Критические дефекты не допускаются (Ac = 0).
 */
export type Aql = 2.5 | 4;
export const AQLS: Aql[] = [2.5, 4];

/** Партия → кодовая буква и объём выборки (уровень II). */
const LOTS: { upTo: number; code: string; n: number }[] = [
  { upTo: 8, code: "A", n: 2 }, { upTo: 15, code: "B", n: 3 }, { upTo: 25, code: "C", n: 5 }, { upTo: 50, code: "D", n: 8 },
  { upTo: 90, code: "E", n: 13 }, { upTo: 150, code: "F", n: 20 }, { upTo: 280, code: "G", n: 32 }, { upTo: 500, code: "H", n: 50 },
  { upTo: 1200, code: "J", n: 80 }, { upTo: 3200, code: "K", n: 125 }, { upTo: 10000, code: "L", n: 200 }, { upTo: 35000, code: "M", n: 315 },
  { upTo: 150000, code: "N", n: 500 }, { upTo: 500000, code: "P", n: 800 }, { upTo: Infinity, code: "Q", n: 1250 },
];
/** Приёмочное число по объёму выборки. */
const AC: Record<Aql, Record<number, number>> = {
  2.5: { 2: 0, 3: 0, 5: 0, 8: 0, 13: 0, 20: 1, 32: 2, 50: 3, 80: 5, 125: 7, 200: 10, 315: 14, 500: 21, 800: 21, 1250: 21 },
  4: { 2: 0, 3: 0, 5: 0, 8: 0, 13: 1, 20: 2, 32: 3, 50: 5, 80: 7, 125: 10, 200: 14, 315: 21, 500: 21, 800: 21, 1250: 21 },
};
/** Для самых больших партий стрелка таблицы ведёт к выборке, где число уже не растёт (n = 315 при AQL 4.0, n = 500 при AQL 2.5). */
const CAP: Record<Aql, number> = { 2.5: 500, 4: 315 };

export interface AqlPlan { lot: number; code: string; sampleSize: number; ac: number; re: number }
export function plan(lot: number, aql: Aql): AqlPlan {
  if (!(lot > 0)) throw new Error("Размер партии должен быть больше нуля");
  const row = LOTS.find((l) => lot <= l.upTo)!;
  let n = row.n;
  if (n > CAP[aql]) n = CAP[aql];
  if (n > lot) n = lot; // партия меньше выборки — проверяется вся партия
  const ac = n === lot && n < 13 ? 0 : AC[aql][n] ?? AC[aql][CAP[aql]];
  return { lot, code: row.code, sampleSize: n, ac, re: ac + 1 };
}

export interface Defect { severity: "critical" | "major" | "minor"; qty: number }
export interface Verdict { critical: number; major: number; minor: number; result: "pass" | "fail"; reasons: string[] }
/** Итог: критических нет, дефектов major ≤ Ac(major), minor ≤ Ac(minor). */
export function verdict(defects: Defect[], majorAc: number, minorAc: number): Verdict {
  const sum = (s: Defect["severity"]) => defects.filter((d) => d.severity === s).reduce((a, d) => a + d.qty, 0);
  const critical = sum("critical"), major = sum("major"), minor = sum("minor");
  const reasons: string[] = [];
  if (critical > 0) reasons.push(`критических дефектов: ${critical} (допустимо 0)`);
  if (major > majorAc) reasons.push(`основных дефектов: ${major} при допустимых ${majorAc}`);
  if (minor > minorAc) reasons.push(`малозначительных дефектов: ${minor} при допустимых ${minorAc}`);
  return { critical, major, minor, result: reasons.length ? "fail" : "pass", reasons };
}
