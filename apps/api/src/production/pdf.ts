import { createRequire } from "node:module";
import { existsSync } from "node:fs";

const require = createRequire(import.meta.url);
type Lang = "ru" | "uz" | "en" | "tr";
const L: Record<Lang, Record<string, string>> = {
  ru: { invoice: "Накладная", packing: "Упаковочный лист", order: "Заказ", client: "Клиент", date: "Дата", color: "Цвет", size: "Размер", qty: "Кол-во", price: "Цена", amount: "Сумма", total: "Итого", barcode: "Штрихкод", name: "Наименование", from: "Отправитель", sign1: "Отпустил", sign2: "Получил" },
  uz: { invoice: "Yuk xati", packing: "Qadoqlash varaqasi", order: "Buyurtma", client: "Mijoz", date: "Sana", color: "Rang", size: "O‘lcham", qty: "Miqdor", price: "Narx", amount: "Summa", total: "Jami", barcode: "Shtrixkod", name: "Nomi", from: "Jo‘natuvchi", sign1: "Topshirdi", sign2: "Qabul qildi" },
  en: { invoice: "Delivery note", packing: "Packing list", order: "Order", client: "Client", date: "Date", color: "Color", size: "Size", qty: "Qty", price: "Price", amount: "Amount", total: "Total", barcode: "Barcode", name: "Item", from: "Sender", sign1: "Released by", sign2: "Received by" },
  tr: { invoice: "İrsaliye", packing: "Çeki listesi", order: "Sipariş", client: "Müşteri", date: "Tarih", color: "Renk", size: "Beden", qty: "Adet", price: "Fiyat", amount: "Tutar", total: "Toplam", barcode: "Barkod", name: "Ürün", from: "Gönderen", sign1: "Teslim eden", sign2: "Teslim alan" },
};

/** Шрифт с кириллицей: из пакета dejavu-fonts-ttf, иначе системный Arial / DejaVu. */
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

export interface ShipmentDoc {
  number: string; factory: string; client: string; order_number: string; currency: string; shipped_at: string | null; created_at: string;
  items: { sku: string; model_name: string; color: string; size: string; qty: number; unit_price: number; barcode: string }[];
  totalQty: number; totalAmount: number;
}

const money = (minor: number) => (minor / 100).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Накладная (стр. 1) и упаковочный лист (стр. 2) одним PDF. Суммы хранятся в минимальных единицах. */
export async function buildShipmentPdf(s: ShipmentDoc, lang: Lang = "ru"): Promise<Buffer> {
  // Подгружается только при печати: если пакет не установлен, остальной API работает.
  const PDFDocument = (await import("pdfkit")).default;
  const t = L[lang] ?? L.ru;
  const fonts = fontPaths();
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  doc.registerFont("R", fonts.regular);
  doc.registerFont("B", fonts.bold);
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((res, rej) => { doc.on("data", (c) => chunks.push(c)); doc.on("end", () => res(Buffer.concat(chunks))); doc.on("error", rej); });
  const date = new Date(s.shipped_at ?? s.created_at).toISOString().slice(0, 10);
  const right = doc.page.width - 40;

  const header = (title: string) => {
    doc.font("B").fontSize(16).text(`${title} ${s.number}`, 40, 40);
    doc.font("R").fontSize(10).moveDown(0.5)
      .text(`${t.from}: ${s.factory}`).text(`${t.client}: ${s.client}`).text(`${t.order}: ${s.order_number}   ${t.date}: ${date}`);
    doc.moveDown(1);
  };
  type Col = { x: number; w: number; label: string; align?: "right" };
  const table = (cols: Col[], rows: string[][], foot?: string[]) => {
    let y = doc.y;
    const row = (cells: string[], bold: boolean) => {
      if (y > doc.page.height - 90) { doc.addPage(); y = 40; }
      doc.font(bold ? "B" : "R").fontSize(9);
      const h = Math.max(...cells.map((c, i) => doc.heightOfString(c, { width: cols[i].w })));
      cells.forEach((c, i) => doc.text(c, cols[i].x, y, { width: cols[i].w, align: cols[i].align }));
      y += h + 4;
      doc.moveTo(40, y - 2).lineTo(right, y - 2).strokeColor("#bbbbbb").lineWidth(0.5).stroke();
    };
    row(cols.map((c) => c.label), true);
    rows.forEach((r) => row(r, false));
    if (foot) row(foot, true);
    doc.x = 40; doc.y = y + 6;
  };

  header(t.invoice);
  table(
    [{ x: 40, w: 90, label: "SKU" }, { x: 132, w: 130, label: t.name }, { x: 264, w: 70, label: t.color }, { x: 336, w: 40, label: t.size },
     { x: 378, w: 40, label: t.qty, align: "right" }, { x: 420, w: 60, label: t.price, align: "right" }, { x: 482, w: 73, label: t.amount, align: "right" }],
    s.items.map((i) => [i.sku, i.model_name, i.color, i.size, String(i.qty), money(i.unit_price), money(i.qty * i.unit_price)]),
    [t.total, "", "", "", String(s.totalQty), "", `${money(s.totalAmount)} ${s.currency}`]);
  doc.moveDown(2).font("R").fontSize(10).text(`${t.sign1}: ____________________          ${t.sign2}: ____________________`, 40);

  doc.addPage();
  header(t.packing);
  table(
    [{ x: 40, w: 180, label: "SKU" }, { x: 224, w: 200, label: t.barcode }, { x: 430, w: 125, label: t.qty, align: "right" }],
    s.items.map((i) => [i.sku, i.barcode, String(i.qty)]), [t.total, "", String(s.totalQty)]);
  doc.end();
  return done;
}
