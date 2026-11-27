import { createRequire } from "node:module";
import { existsSync } from "node:fs";

const require = createRequire(import.meta.url);

const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const R = L.map((s) => [...s].map((b) => (b === "0" ? "1" : "0")).join(""));
const G = R.map((s) => [...s].reverse().join(""));
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

/** Контрольная цифра EAN-13 по первым 12 цифрам. */
export function ean13Check(body12: string): number {
  const sum = [...body12].reduce((s, d, i) => s + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10;
}

/** Строка из 95 модулей EAN-13 (1 = чёрная полоса). Бросает ошибку, если код неверный. */
export function ean13Modules(code: string): string {
  if (!/^\d{13}$/.test(code)) throw new Error("EAN-13: нужно 13 цифр");
  if (ean13Check(code.slice(0, 12)) !== Number(code[12])) throw new Error("EAN-13: неверная контрольная цифра");
  const par = PARITY[Number(code[0])];
  let out = "101";
  for (let i = 0; i < 6; i++) out += (par[i] === "L" ? L : G)[Number(code[i + 1])];
  out += "01010";
  for (let i = 0; i < 6; i++) out += R[Number(code[i + 7])];
  return out + "101";
}

function fontPaths(): { regular: string; bold: string } {
  try {
    return { regular: require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf"), bold: require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf") };
  } catch { /* пакет не установлен */ }
  const tries: [string, string][] = [
    ["/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"],
    ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
  ];
  const f = tries.find(([r]) => existsSync(r));
  if (!f) throw new Error("Не найден шрифт для PDF: выполните pnpm install");
  return { regular: f[0], bold: f[1] };
}

export interface LabelItem { sku: string; barcode: string; model_code: string; model_name: string; color: string; size: string }
export type LabelFormat = "a4" | "thermal";

const MM = 72 / 25.4;

/**
 * PDF с этикетками. a4 — сетка 3×7 (70×42 мм), thermal — по одной этикетке 58×40 мм на страницу.
 * Каждая позиция печатается `copies` раз.
 */
export async function buildLabelsPdf(items: LabelItem[], format: LabelFormat = "a4", copies = 1): Promise<Buffer> {
  const PDFDocument = (await import("pdfkit")).default;
  const fonts = fontPaths();
  const labelW = format === "a4" ? 70 * MM : 58 * MM;
  const labelH = format === "a4" ? 42 * MM : 40 * MM;
  const doc = new PDFDocument({ size: format === "a4" ? "A4" : [labelW, labelH], margin: 0 });
  doc.registerFont("R", fonts.regular);
  doc.registerFont("B", fonts.bold);
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((res, rej) => { doc.on("data", (c) => chunks.push(c)); doc.on("end", () => res(Buffer.concat(chunks))); doc.on("error", rej); });

  const all: LabelItem[] = [];
  for (const it of items) for (let i = 0; i < copies; i++) all.push(it);

  const cols = format === "a4" ? 3 : 1;
  const rows = format === "a4" ? 7 : 1;
  const perPage = cols * rows;
  const offX = format === "a4" ? (doc.page.width - cols * labelW) / 2 : 0;
  const offY = format === "a4" ? (doc.page.height - rows * labelH) / 2 : 0;

  const drawLabel = (it: LabelItem, x: number, y: number) => {
    const pad = 3 * MM;
    const w = labelW - 2 * pad;
    doc.fillColor("#000").font("R").fontSize(7).text(`${it.model_code} · ${it.model_name}`, x + pad, y + 2.5 * MM, { width: w, height: 9, ellipsis: true, lineBreak: false });
    doc.font("B").fontSize(11).text(`${it.color} / ${it.size}`, x + pad, y + 6.5 * MM, { width: w, height: 14, ellipsis: true, lineBreak: false });
    const bits = ean13Modules(it.barcode);
    const mod = Math.min(0.33 * MM, w / 100);
    const bw = 95 * mod;
    const bx = x + (labelW - bw) / 2;
    const by = y + 12 * MM;
    const bh = 15 * MM;
    for (let i = 0; i < bits.length; ) {
      if (bits[i] !== "1") { i++; continue; }
      let j = i;
      while (j < bits.length && bits[j] === "1") j++;
      doc.rect(bx + i * mod, by, (j - i) * mod, bh).fill("#000");
      i = j;
    }
    doc.fillColor("#000").font("R").fontSize(8).text(it.barcode, x, by + bh + 1 * MM, { width: labelW, align: "center", lineBreak: false });
    doc.font("R").fontSize(6.5).text(it.sku, x + pad, y + labelH - 4.5 * MM, { width: w, align: "center", ellipsis: true, lineBreak: false });
  };

  all.forEach((it, n) => {
    const k = n % perPage;
    if (n > 0 && k === 0) doc.addPage();
    const cx = k % cols;
    const cy = Math.floor(k / cols);
    const x = offX + cx * labelW;
    const y = offY + cy * labelH;
    drawLabel(it, x, y);
    if (format === "a4") doc.rect(x, y, labelW, labelH).lineWidth(0.25).strokeColor("#dddddd").stroke();
  });
  if (all.length === 0) doc.font("R").fontSize(10).text("Нет этикеток", 20, 20);
  doc.end();
  return done;
}
