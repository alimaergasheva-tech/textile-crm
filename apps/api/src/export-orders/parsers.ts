import type { Cell, Sheet } from "./xlsx.ts";

export const SIZES = [122, 128, 134, 140, 146, 152, 158] as const;
const s = (c: Cell | undefined) => (c === null || c === undefined ? "" : String(c).trim());
const num = (c: Cell | undefined): number | null => {
  if (typeof c === "number") return c;
  const m = /^[±+\-]?\s*(\d+(?:[.,]\d+)?)$/.exec(s(c));
  return m ? Number(m[1].replace(",", ".")) : null;
};
/** Серийный номер даты Excel → YYYY-MM-DD. */
export const excelDate = (n: number): string => new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400_000).toISOString().slice(0, 10);

// ---------- Ткани из текстовых описаний ----------
export interface FabricSpec { name: string; composition: string; gsm: number; kind: "main" | "rib"; aop: boolean }

/** «kd Suprem 92% cotton 8% elastane, 170 gr/m2» → состав и плотность. */
export function parseFabric(text: string, kind: "main" | "rib"): FabricSpec | null {
  const t = text.replace(/\s+/g, " ");
  const gsm = /(\d{2,3})\s*(?:gr|г|g)(?![A-Za-zА-Яа-я])/i.exec(t)?.[1];
  if (!gsm) return null;
  const parts: string[] = [];
  for (const m of t.matchAll(/(\d{1,3})\s*%\s*(cotton|elastane|elastan|lycra|polyester|viscose|хлопок|эластан)/gi)) parts.push(`${m[1]}% ${m[2].toLowerCase()}`);
  if (/full lycra/i.test(t) && !parts.length) parts.push("full lycra");
  const aop = /\baop\b/i.test(t);
  const base = kind === "rib" ? "Рибана 1×1" : aop ? "AOP-кулирка" : "Кулирка";
  const composition = parts.join(" / ") || "—";
  return { name: `${base} ${composition} ${gsm} г/м²`, composition, gsm: Number(gsm), kind, aop };
}

/** Делит описание «UST: ... ALT: ...» / «UST ve ALT: ...» на верх и низ. */
export function splitTopBottom(text: string): { top: string; bottom: string } {
  const t = text.replace(/\s+/g, " ").trim();
  const both = /^UST\s+ve\s+ALT\s*:(.*)$/i.exec(t);
  if (both) return { top: both[1].trim(), bottom: both[1].trim() };
  const top = /UST\s*:(.*?)(?=ALT\s*:|$)/i.exec(t)?.[1]?.trim() ?? "";
  const bottom = /ALT\s*:(.*)$/i.exec(t)?.[1]?.trim() ?? "";
  return { top, bottom };
}

// ---------- Файл Status (заказ по моделям) ----------
export interface StatusModel {
  code: string; mainFabricText: string; extraFabricText: string; accessoriesText: string;
  top: FabricSpec | null; bottom: FabricSpec | null; rib: FabricSpec | null;
  sizeQty: Record<string, number>; qty: number; qtyWithReserve: number | null; packSize: string | null; exFactory: string | null;
}

/** Ищет строку заголовков по названиям колонок и читает модели ниже (по коду «SET44.01»). */
export function parseStatus(sheet: Sheet): { models: StatusModel[]; warnings: string[] } {
  const warnings: string[] = [];
  const hi = sheet.rows.findIndex((r) => r.some((c) => /style number|artikul/i.test(s(c))) && r.some((c) => /main fabric|ana kumas/i.test(s(c))));
  if (hi < 0) throw new Error("Не найдена строка заголовков (Style number / main fabric). Это файл Status?");
  const h = sheet.rows[hi];
  const col = (re: RegExp) => h.findIndex((c) => re.test(s(c)));
  const cStyle = col(/style number|artikul/i), cMain = col(/main fabric|ana kumas/i), cExtra = col(/ilave/i), cAcc = col(/aksesuar/i);
  const cSizes = SIZES.map((z) => h.findIndex((c) => num(c) === z));
  if (cSizes.some((x) => x < 0)) throw new Error("В заголовках нет всех размеров 122–158");
  const cQty = h.findIndex((c) => /quantity|siparis adet/i.test(s(c)) && !/\+\s*\d+\s*%/.test(s(c)));
  const cQtyPlus = h.findIndex((c) => /\+\s*\d+\s*%/.test(s(c)));
  const cPack = col(/poset|пакет/i), cDate = col(/yukleme|ex-factory|termin/i);
  const models: StatusModel[] = [];
  for (let i = hi + 1; i < sheet.rows.length; i++) {
    const r = sheet.rows[i], code = s(r[cStyle]);
    if (!/^[A-Z]+\d+\.\d+$/.test(code)) continue;
    const main = s(r[cMain]), extra = s(r[cExtra]);
    const { top, bottom } = splitTopBottom(main);
    const sizeQty: Record<string, number> = {};
    SIZES.forEach((z, k) => { sizeQty[String(z)] = num(r[cSizes[k]]) ?? 0; });
    const sum = Object.values(sizeQty).reduce((a, b) => a + b, 0);
    const qty = cQty >= 0 ? num(r[cQty]) ?? sum : sum;
    if (cQty >= 0 && qty !== sum) warnings.push(`${code}: сумма по размерам ${sum} не равна количеству ${qty}`);
    const rib = /ribana|риб/i.test(extra) ? parseFabric(extra, "rib") : /ribana/i.test(main) ? parseFabric(main.replace(/^.*?(ribana[^.]*)\..*$/i, "$1"), "rib") : null;
    const dt = cDate >= 0 ? num(r[cDate]) : null;
    models.push({ code, mainFabricText: main, extraFabricText: extra === "-" ? "" : extra, accessoriesText: s(r[cAcc]),
      top: parseFabric(top, /^PN\s*Ribana/i.test(top) ? "rib" : "main"), bottom: parseFabric(bottom, "main"), rib,
      sizeQty, qty, qtyWithReserve: cQtyPlus >= 0 ? num(r[cQtyPlus]) : null, packSize: cPack >= 0 ? s(r[cPack]) || null : null,
      exFactory: dt ? excelDate(dt) : null });
  }
  if (!models.length) throw new Error("В файле не найдено ни одной модели (код вида SET44.01)");
  return { models, warnings };
}

/** Какие выкройки назначены моделям на листах «Концепция/заказ»: «Лекала GKT1», «Посадка GKT11». */
export function parsePatternHints(sheets: Sheet[]): Map<string, { tee?: string; skirt?: string }> {
  const out = new Map<string, { tee?: string; skirt?: string }>();
  for (const sh of sheets) {
    let cur: string | null = null;
    for (const r of sh.rows) for (const c of r) {
      const t = s(c);
      if (/^[A-Z]+\d+\.\d+$/.test(t)) { cur = t; continue; }
      const m = cur ? /(?:лекала|посадка)\s+(G[A-Z]+\d+)/i.exec(t) : null;
      if (m && cur) { const e = out.get(cur) ?? {}; if (/^GKT/i.test(m[1])) e.tee = m[1].toUpperCase(); else e.skirt = m[1].toUpperCase(); out.set(cur, e); }
    }
  }
  return out;
}

// ---------- Табели мер ----------
export interface PatternParsed { code: string; kind: "tee" | "skirt" | "other"; measures: { name: string; tolerance: number | null; values: Record<string, number> }[] }

/** Листы «ТМ GKT1», «GSH06» и т.п.: находит строку с размерами 122…158 и читает мерки под ней. */
export function parsePatterns(sheets: Sheet[]): { patterns: PatternParsed[]; warnings: string[] } {
  const patterns: PatternParsed[] = []; const warnings: string[] = [];
  for (const sh of sheets) {
    const code = /(G[A-Z]{2,3}\d{1,3})/i.exec(sh.name)?.[1]?.toUpperCase();
    if (!code) continue;
    let hi = -1, cs: number[] = [];
    for (let i = 0; i < sh.rows.length; i++) {
      const idx = SIZES.map((z) => sh.rows[i].findIndex((c) => num(c) === z));
      if (idx.every((x) => x >= 0)) { hi = i; cs = idx; break; }
    }
    if (hi < 0) { warnings.push(`Лист «${sh.name}»: не найдена строка размеров, пропущен`); continue; }
    const first = cs[0], last = cs[cs.length - 1];
    const measures: PatternParsed["measures"] = []; let section = "";
    for (let i = hi + 1; i < sh.rows.length; i++) {
      const r = sh.rows[i];
      const label = r.slice(0, first).map(s).filter((x) => x && !/^[\d.,±\s]+$/.test(x) && !/^\*+$/.test(x)).sort((a, b) => b.length - a.length)[0] ?? "";
      const vals = cs.map((c) => num(r[c]));
      if (vals.every((v) => v === null)) { if (/фурнитур/i.test(label)) section = "ФУРНИТУРА: "; continue; }
      if (!label || vals.some((v) => v === null)) continue;
      let tol: number | null = null;
      for (let c = first - 1; c >= 0 && tol === null; c--) { const t = s(r[c]); if (t && /^[±\s\d.,]+$/.test(t) && label !== t) tol = num(r[c]); }
      if (tol === null) tol = num(r[last + 1]);
      const values: Record<string, number> = {};
      SIZES.forEach((z, k) => { values[String(z)] = Math.round((vals[k] as number) * 100) / 100; });
      measures.push({ name: section + label.replace(/\s+/g, " "), tolerance: tol, values });
    }
    if (!measures.length) { warnings.push(`Лист «${sh.name}»: мерок не найдено`); continue; }
    patterns.push({ code, kind: code.startsWith("GKT") ? "tee" : code.startsWith("GSH") || code.startsWith("GSK") ? "skirt" : "other", measures });
  }
  return { patterns, warnings };
}
