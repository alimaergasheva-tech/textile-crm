/** Разбор CSV из Excel: BOM, разделитель «;», «,» или табуляция (по первой строке), кавычки с удвоением. Пустые строки пропускаются. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const first = src.split(/\r?\n/, 1)[0] ?? "";
  const sep = [";", "\t", ","].map((s) => [s, first.split(s).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = []; let row: string[] = [], cur = "", q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) { if (ch === '"') { if (src[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === sep) { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && src[i + 1] === "\n") i++; row.push(cur); cur = ""; if (row.some((x) => x.trim() !== "")) rows.push(row); row = []; }
    else cur += ch;
  }
  row.push(cur); if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows.map((r) => r.map((x) => x.trim()));
}

/** Приводит заголовки к кодам по словарю синонимов; неизвестные колонки игнорируются. */
export function mapRows(rows: string[][], aliases: Record<string, string[]>): { rows: Record<string, string>[]; unknown: string[] } {
  if (!rows.length) return { rows: [], unknown: [] };
  const norm = (s: string) => s.toLowerCase().replace(/[\s._-]+/g, "");
  const lookup = new Map<string, string>();
  for (const [code, list] of Object.entries(aliases)) for (const a of [code, ...list]) lookup.set(norm(a), code);
  const cols = rows[0].map((h) => lookup.get(norm(h)) ?? "");
  const unknown = rows[0].filter((_, i) => !cols[i]);
  return { rows: rows.slice(1).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i] ?? ""]).filter(([c]) => c))), unknown };
}

/** Число из Excel: пробелы-разделители, запятая как десятичный знак. NaN, если не число. */
export function toNum(s: string): number {
  const x = s.replace(/[\s ]/g, "").replace(",", ".");
  return x === "" ? NaN : Number(x);
}
