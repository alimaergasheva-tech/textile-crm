import { SIZES } from "./parsers.ts";

/** Параметры расчёта (хранятся в export_orders.calc_params, переопределяют значения по умолчанию). */
export interface CalcParams {
  wasteMain: number;          // отход основного полотна (раскладка + концы)
  wasteRib: number;           // отход рибаны
  ribStripCm: number;         // ширина полосы рибаны в раскрое, см
  sleeveAllowanceGkt11: number; // припуск на короткий рукав GKT11 (в табеле мерок рукава нет)
  fabricWidthM: number;       // ширина полотна (открытая), м — для пересчёта кг в метры
  trimsReserve: number;       // запас фурнитуры и упаковки
  fabricOrderReserve: number; // страховой запас полотна к заказу
  bowCordCm: number;          // длина шнурка-бантика GSH04, см (в табеле нет)
  unitsPerCarton: number;     // комплектов в коробе
  cmtUsd: number;             // пошив (CMT), $ за комплект
  otherPerSetUsd: number;     // нитки и прочее, $ за комплект
  marginPct: number;          // целевая маржа от цены (0.12 = 12%)
  logisticsUsd: number;       // логистика до США, $ за комплект (показывается отдельной строкой)
}
export const DEFAULT_PARAMS: CalcParams = {
  wasteMain: 0.08, wasteRib: 0.05, ribStripCm: 3, sleeveAllowanceGkt11: 0.10, fabricWidthM: 1.8,
  trimsReserve: 0.03, fabricOrderReserve: 0.03, bowCordCm: 80, unitsPerCarton: 40,
  cmtUsd: 2.2, otherPerSetUsd: 0.1, marginPct: 0.12, logisticsUsd: 0.35,
};
export const mergeParams = (p: unknown): CalcParams => {
  const out = { ...DEFAULT_PARAMS };
  if (p && typeof p === "object") for (const k of Object.keys(out) as (keyof CalcParams)[]) {
    const v = (p as Record<string, unknown>)[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return out;
};

export interface Measure { name: string; vals: Record<string, number> }
type Sz = Record<string, number>;

/** Значение мерки по регулярке названия; null — мерка не найдена (расчёт по этому размеру невозможен). */
const pick = (ms: Measure[], re: RegExp) => ms.find((m) => re.test(m.name.toLowerCase()));
const val = (m: Measure | undefined, s: string) => (m ? m.vals[s] : undefined);

export interface AreaResult { areaCm2: Sz; ribCm: Sz; cordCm: Sz; elasticCm: Sz; elasticMm: 25 | 35 | 0; missing: string[] }

/** Площадь плоских деталей, длина рибаны и фурнитура пояса на 1 изделие по размерам. Оценка по табелю мер, точнее — раскладкой. */
export function patternArea(code: string, ms: Measure[], p: CalcParams): AreaResult {
  const missing: string[] = [];
  const need = (re: RegExp, label: string) => { const m = pick(ms, re); if (!m) missing.push(label); return m; };
  const area: Sz = {}, rib: Sz = {}, cord: Sz = {}, elastic: Sz = {};
  let elasticMm: 0 | 25 | 35 = 0;
  const c = code.toUpperCase();
  const f = (...a: (number | undefined)[]) => (a.some((x) => x === undefined || Number.isNaN(x)) ? undefined : (a as number[]));
  if (c === "GKT1" || c === "GKT19") {
    const chest = need(/ширина изделия под проймой/, "ширина под проймой"), hem = need(/ширина изделия внизу/, "ширина внизу");
    const front = need(c === "GKT1" ? /длина переда/ : /длина полочки/, "длина переда"), back = need(c === "GKT1" ? /длина изделия по середине спинки/ : /длина спинки по центру/, "длина спинки");
    const sTop = need(c === "GKT1" ? /ширина рукава вверху/ : /ширина рукава под проймой/, "ширина рукава верх"), sBot = need(/ширина рукава внизу/, "ширина рукава низ"), sLen = need(/длина рукава/, "длина рукава");
    const ribM = c === "GKT1" ? need(/1\/2 длины планки горловины/, "1/2 длины планки") : need(/длина канта/, "длина канта");
    for (const s of SIZES.map(String)) {
      const v = f(val(chest, s), val(hem, s), val(front, s), val(back, s), val(sTop, s), val(sBot, s), val(sLen, s));
      if (v) area[s] = (v[0] + v[1]) / 2 * (v[2] + v[3]) + (v[4] + v[5]) * v[6];
      const r = val(ribM, s); if (r !== undefined) rib[s] = c === "GKT1" ? 2 * r : r;
    }
  } else if (c === "GKT11") {
    const chest = need(/ширина изделия под проймой/, "ширина под проймой"), hem = need(/ширина по низу изделия/, "ширина по низу");
    const front = need(/длина изделия по полочке/, "длина по полочке"), back = need(/длина изделия посредине спинки/, "длина по спинке");
    for (const s of SIZES.map(String)) {
      const v = f(val(chest, s), val(hem, s), val(front, s), val(back, s));
      if (v) area[s] = (v[0] + v[1]) / 2 * (v[2] + v[3]) * (1 + p.sleeveAllowanceGkt11);
    }
  } else if (c === "GSH06") {
    const lower = need(/длина нижней юбки/, "длина нижней юбки"), upper = need(/длина верхней юбки/, "длина верхней юбки");
    const wLow = need(/ширина по низу нижней юбки/, "ширина низа нижней юбки"), wUp = need(/ширина по низу верхней юбки/, "ширина низа верхней юбки");
    const sh = need(/длина шорт в области бокового шва/, "длина шорт"), shW = need(/ширина на уровне бедер шорт/, "ширина шорт на бёдрах");
    const yoke = need(/длина кокетки/, "длина кокетки"), cut = need(/ширина по подрезу/, "ширина по подрезу");
    const cd = need(/фурнитура: шнур/, "шнур в пояс"), el = need(/фурнитура: резинка/, "резинка в пояс");
    elasticMm = 25;
    for (const s of SIZES.map(String)) {
      const v = f(val(lower, s), val(upper, s), val(wLow, s), val(wUp, s), val(sh, s), val(shW, s), val(yoke, s), val(cut, s));
      if (v) area[s] = 2 * (v[0] * v[2] + v[1] * v[3] + v[4] * v[5]) + v[6] * 2 * v[7];
      const a = val(cd, s), b = val(el, s); if (a !== undefined) cord[s] = a; if (b !== undefined) elastic[s] = b;
    }
  } else if (c === "GSH04") {
    const hips = need(/ширина бедер/, "ширина бёдер"), side = need(/длина по боковому шву/, "длина по боковому шву");
    const bandH = need(/высота пояса/, "высота пояса"), bandW = need(/ширина пояса в растянутом виде/, "ширина пояса растянутая"), gather = need(/ширина пояса в собранном виде/, "ширина пояса собранная");
    const rU = need(/ширина правой отлетной детали вверху/, "прав. отлётная верх"), rD = need(/ширина правой отлетной детали внизу/, "прав. отлётная низ"), rL = need(/длина правой отлетной детали/, "прав. отлётная длина");
    const lU = need(/ширина левой отлетной детали вверху/, "лев. отлётная верх"), lD = need(/ширина левой отлетной детали внизу/, "лев. отлётная низ"), lL = need(/длина левой отлетной детали/, "лев. отлётная длина");
    elasticMm = 35;
    for (const s of SIZES.map(String)) {
      const v = f(val(hips, s), val(side, s), val(bandH, s), val(bandW, s), val(rU, s), val(rD, s), val(rL, s), val(lU, s), val(lD, s), val(lL, s));
      if (v) area[s] = 2 * v[0] * v[1] + 2 * v[2] * v[3] + (v[4] + v[5]) / 2 * v[6] + (v[7] + v[8]) / 2 * v[9];
      const g = val(gather, s); if (g !== undefined) elastic[s] = 2 * g + 2;   // допущение: 2×собранный пояс + 2 см
    }
  } else missing.push(`нет формулы расхода для выкройки ${code}`);
  return { areaCm2: area, ribCm: rib, cordCm: cord, elasticCm: elastic, elasticMm, missing };
}

/** кг на изделие: основное полотно = площадь × плотность / 10⁷ × (1+отход); рибана = длина × ширина полосы × плотность. */
export const kgMain = (areaCm2: number, gsm: number, p: CalcParams) => areaCm2 * gsm / 1e7 * (1 + p.wasteMain);
export const kgRib = (lenCm: number, gsm: number, p: CalcParams) => lenCm * p.ribStripCm * gsm / 1e7 * (1 + p.wasteRib);

/** Термотрансфер: малый — рост 122–146, большой — 152 и 158. */
export const isLargeSize = (s: string) => Number(s) >= 152;
