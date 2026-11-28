import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useMe } from "../state";

interface Party { name?: string; address?: string; tin?: string; bank?: string }
interface Details { seller?: Party; consignee?: Party; invoiceNo?: string; invoiceDate?: string; incoterms?: string; place?: string; origin?: string; loadingPlace?: string; deliveryPlace?: string; trailer?: string; gtd?: Record<string, string>; [k: string]: unknown }
interface DocLine { modelId: string; model: string; description: string; hs: string; composition: string; qty: number; unitPrice: number; amount: number; netKg: number; cartons: number | null }
interface Data { shipment: { id: string; order_id: string; number: string; carrier: string | null; plate: string | null; cmr_no: string | null; loading_date: string | null; order_number: string; currency: string; destination: string };
  details: Details; version: number; lines: DocLine[]; totals: { qty: number; amount: number; netKg: number; grossKg: number; cartons: number; volumeM3: number } }

/** Поля ГТД, которые вводятся вручную. Значения по умолчанию — типовые для экспорта автотранспортом из Узбекистана. */
const FIELDS: { k: string; label: string; def?: string; wide?: boolean }[] = [
  { k: "declNo", label: "Номер ГТД (графа A)" }, { k: "type", label: "1. Тип декларации", def: "ЭК 10" },
  { k: "declarant", label: "14. Декларант / брокер (название, ИНН, адрес)", wide: true }, { k: "financial", label: "9. Лицо, отв. за финансовое урегулирование (по умолчанию — продавец)", wide: true },
  { k: "countryDispatchCode", label: "15a. Код страны отправления", def: "860" }, { k: "countryDispatch", label: "15. Страна отправления", def: "УЗБЕКИСТАН" },
  { k: "originCountry", label: "16. Страна происхождения", def: "УЗБЕКИСТАН" }, { k: "originCode", label: "34. Код страны происхождения", def: "860" },
  { k: "destCountry", label: "17. Страна назначения", def: "США" }, { k: "destCode", label: "17a. Код страны назначения", def: "840" },
  { k: "vehicleCountry", label: "18. Код страны ТС", def: "860" }, { k: "vehicleBorder", label: "21. ТС на границе (по умолчанию — как в 18)" },
  { k: "termsCode", label: "20. Код условий поставки", def: "02" }, { k: "currencyCode", label: "22. Код валюты", def: "840" }, { k: "rate", label: "23. Курс валюты (сум за 1 ед.)" },
  { k: "deal", label: "24. Характер сделки", def: "21" }, { k: "transportBorder", label: "25. Вид транспорта на границе", def: "30" }, { k: "transportInland", label: "26. Вид транспорта внутри страны", def: "30" },
  { k: "bank", label: "28. Финансовые и банковские сведения", wide: true }, { k: "customsBorder", label: "29. Таможня на границе (код, название)" }, { k: "goodsLocation", label: "30. Место досмотра товара", wide: true },
  { k: "procedure", label: "37. Процедура", def: "10 00" }, { k: "pref", label: "36. Преференции", def: "" },
  { k: "contract", label: "301. Контракт № (номер и дата)" }, { k: "tir", label: "204. TIR №" }, { k: "other", label: "899. Прочие документы" },
  { k: "unit", label: "41. Код ед. измерения", def: "796" }, { k: "mark", label: "31. Маркировка", def: "БЕЗ МАРКИ" },
];
const money = (n: number) => n.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/ /g, " ");
const kg = (n: number) => n.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 3 });
const box: React.CSSProperties = { border: "1px solid #222", padding: "2px 4px", minHeight: 38, fontSize: 11, overflow: "hidden" };
const lab: React.CSSProperties = { fontSize: 9, color: "#444", display: "block" };

interface Good { n: number; hs: string; text: string[]; pcs: number; cartons: number; gross: number; net: number; amount: number; ctl: string[] }

/** ГТД (ТД-1 + добавочные листы ТД-2 + оборотные листы) для экспорта: заполняется из отгрузки и ведомости ВЭД. Форма для брокера/декларанта; электронная подача — в таможенной системе. */
export function ExportGtdPage() {
  const { id, sid } = useParams();
  const { can } = useMe();
  const qc = useQueryClient();
  const manage = can("exportved.manage");
  const q = useQuery({ queryKey: ["export-ved", sid], queryFn: () => api<Data>(`/export-shipments/${sid}/ved`) });
  const [g, setG] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  useEffect(() => { if (q.data) setG(q.data.details.gtd ?? {}); }, [q.data]);
  const save = useMutation({
    mutationFn: () => api<Data>(`/export-shipments/${sid}/ved`, { method: "PUT", body: JSON.stringify({ version: q.data!.version, details: { ...q.data!.details, gtd: g } }) }),
    onSuccess: (r) => { setErr(""); qc.setQueryData(["export-ved", sid], r); }, onError: (e) => setErr(e instanceof Error ? e.message : String(e)),
  });
  const r = q.data;
  if (!r) return <p className="muted">{q.isError ? (q.error as Error).message : "…"}</p>;
  const v = (k: string) => g[k] ?? FIELDS.find((f) => f.k === k)?.def ?? "";
  const d = r.details, s = r.shipment, T = r.totals;
  const party = (p?: Party) => [p?.name, p?.address, p?.tin ? `ИНН: ${p.tin}` : ""].filter(Boolean);
  // Товары = коды ТН ВЭД: модели с одним кодом объединяются в одну позицию. Брутто распределяется пропорционально нетто.
  const byHs = new Map<string, DocLine[]>();
  for (const l of r.lines) byHs.set(l.hs || "—", [...(byHs.get(l.hs || "—") ?? []), l]);
  const netAll = T.netKg || 1;
  const goods: Good[] = [...byHs.entries()].map(([hs, ls], i) => {
    const net = ls.reduce((a, x) => a + x.netKg, 0), pcs = ls.reduce((a, x) => a + x.qty, 0), cartons = ls.reduce((a, x) => a + (x.cartons ?? 0), 0);
    const text = ls.map((x) => `${x.description || x.model} артикул ${x.model}${x.composition ? ` состав ${x.composition}` : ""}, ${x.qty.toLocaleString("ru-RU")} шт, изготовитель ${d.seller?.name ?? ""} ${d.origin ?? ""} - вес нетто: ${kg(x.netKg)} кг`);
    return { n: i + 1, hs, text, pcs, cartons, gross: Math.round(T.grossKg * (net / netAll) * 100) / 100, net: Math.round(net * 100) / 100, amount: ls.reduce((a, x) => a + x.amount, 0),
      ctl: ls.map((x) => `${x.description || x.model} артикул ${x.model} кол-во: ${x.qty.toLocaleString("ru-RU")} кол-во уп. ${x.cartons ?? 0} коробок`) };
  });
  const rate = Number(v("rate")) || 0;
  const docs = [
    s.cmr_no && `202. CMR № ${s.cmr_no}${s.loading_date ? ` от ${s.loading_date}` : ""}`, v("tir") && `204. TIR № ${v("tir")}`,
    d.invoiceNo && `220. ИНВ № ${d.invoiceNo}${d.invoiceDate ? ` от ${d.invoiceDate}` : ""}`, v("contract") && `301. КНТ № ${v("contract")}`, v("other") && `899. ${v("other")}`,
  ].filter(Boolean) as string[];
  const vehicle = [s.plate, d.trailer].filter(Boolean).join("/");
  const missing: string[] = [];
  const need = (ok: unknown, w: string) => { if (!ok) missing.push(w); };
  need(v("declNo"), "Номер ГТД"); need(v("declarant"), "14. Декларант"); need(v("bank"), "28. Банковские сведения"); need(v("customsBorder"), "29. Таможня на границе"); need(v("goodsLocation"), "30. Место досмотра");
  need(v("contract"), "301. Контракт"); need(rate > 0, "23. Курс валюты"); need(s.plate, "18. Номер ТС"); goods.forEach((x) => need(x.hs !== "—", `Товар ${x.n}: код ТН ВЭД`));
  const Good = ({ x, first }: { x: Good; first?: boolean }) => (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 250px", border: "1px solid #222", borderTop: first ? "1px solid #222" : "none" }}>
      <div style={{ ...box, borderWidth: "0 1px 0 0", minHeight: 150 }}><span style={lab}>31. Грузовые места и описание товаров: маркировка и количество — номера контейнеров — описание товаров</span>
        {x.text.map((t, i) => <div key={i}>{i + 1}) {t}</div>)}<div>2: мест/{x.cartons}/ коробок; 10: {x.pcs.toLocaleString("ru-RU")} шт</div><div>{v("mark")}</div>{d.seller?.tin && <div>ИНН: {d.seller.tin}</div>}
        <span style={{ ...lab, marginTop: 6 }}>44. Дополнительная информация / представляемые документы</span>{docs.map((t) => <div key={t}>{t}</div>)}</div>
      <div style={{ fontSize: 11 }}>
        {([["32. Товар №", String(x.n)], ["33. Код товара", x.hs], ["34. Код страны происх.", v("originCode")], ["35. Вес брутто (кг)", kg(x.gross)], ["36. Преференции", v("pref")], ["37. Процедура", v("procedure")],
          ["38. Вес нетто (кг)", kg(x.net)], ["39. Квота", ""], ["40. Общая декларация / предшествующий документ", ""], ["41. Доп. ед. измерения", `${v("unit")}  ${x.pcs.toLocaleString("ru-RU")} шт`],
          ["42. Фактур. стоимость товара", money(x.amount)], ["45. Таможенная стоимость", rate ? money(x.amount * rate) : ""], ["46. Статистическая стоимость (USD)", money(x.amount)]] as const)
          .map(([l, val]) => <div key={l} style={{ ...box, minHeight: 24, borderWidth: "0 0 1px 0" }}><span style={lab}>{l}</span><b>{val}</b></div>)}
      </div>
    </div>);
  const sheets: Good[][] = []; for (let i = 1; i < goods.length; i += 3) sheets.push(goods.slice(i, i + 3));
  const total = money(T.amount);
  return (
    <div>
      <p className="noprint"><Link to={`/export-orders/${id}/shipments/${sid}/docs`}>← Документы ВЭД</Link></p>
      <div className="noprint">
        {missing.length > 0 && <div style={{ border: "1px solid #e0a030", padding: 8, marginBottom: 8 }}><b>Не заполнено для ГТД:</b> {missing.join("; ")}</div>}
        <details open={missing.length > 0}><summary>Реквизиты ГТД</summary>
          <div className="toolbar" style={{ flexWrap: "wrap" }}>
            {FIELDS.map((f) => <label key={f.k} style={{ display: "block", width: f.wide ? "100%" : 260 }}><span className="muted" style={{ fontSize: 11 }}>{f.label}</span>
              <input disabled={!manage} style={{ width: "100%" }} placeholder={f.def ?? ""} value={g[f.k] ?? ""} onChange={(e) => setG({ ...g, [f.k]: e.target.value })} /></label>)}
          </div>
          {manage && <button disabled={save.isPending} onClick={() => save.mutate()}>Сохранить</button>}{err && <span style={{ color: "#c0392b" }}> {err}</span>}
        </details>
        <p><button onClick={() => window.print()}>Save as PDF / Print</button></p>
      </div>
      <style>{`@media print { body * { visibility: hidden } .gtd-doc, .gtd-doc * { visibility: visible } .gtd-doc { position: absolute; left: 0; top: 0; width: 100% } .noprint { display: none !important } .gtd-page { page-break-after: always } }`}</style>
      <div className="gtd-doc" style={{ background: "#fff", color: "#111", fontFamily: "Arial, sans-serif", padding: 12 }}>
        <div className="gtd-page">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}><b style={{ fontSize: 15 }}>ГРУЗОВАЯ ТАМОЖЕННАЯ ДЕКЛАРАЦИЯ &nbsp; A {v("declNo")}</b><b style={{ fontSize: 16 }}>ТД 1</b></div>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", border: "1px solid #222", borderBottom: "none" }}>
            <div>
              <div style={{ ...box, borderWidth: "0 1px 1px 0" }}><span style={lab}>2. Отправитель / экспортёр</span>{party(d.seller).map((t) => <div key={t}>{t}</div>)}</div>
              <div style={{ ...box, borderWidth: "0 1px 1px 0" }}><span style={lab}>8. Получатель / импортёр</span>{party(d.consignee).map((t) => <div key={t}>{t}</div>)}</div>
              <div style={{ ...box, borderWidth: "0 1px 1px 0" }}><span style={lab}>14. Декларант / представитель</span>{v("declarant")}</div>
            </div>
            <div>
              <div style={{ ...box, borderWidth: "0 0 1px 0" }}><span style={lab}>1. Тип декларации</span><b>{v("type")}</b></div>
              <div style={{ ...box, borderWidth: "0 0 1px 0" }}><span style={lab}>3. Доб. лист</span><b>{1 + sheets.length > 1 ? sheets.length : 0}</b> &nbsp; <span style={lab}>5. Всего наим. товаров: {goods.length} &nbsp; 6. Кол-во мест: {T.cartons}</span></div>
              <div style={{ ...box, borderWidth: "0 0 1px 0" }}><span style={lab}>9. Лицо, ответственное за финансовое урегулирование</span>{v("financial") || party(d.seller).join(", ")}</div>
              <div style={{ ...box, borderWidth: "0 0 1px 0" }}><span style={lab}>12. Общая стоимость · 13</span><b>{total}</b></div>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", border: "1px solid #222", borderBottom: "none" }}>
            {([["15. Страна отправления", `${v("countryDispatch")} (${v("countryDispatchCode")})`], ["16. Страна происхождения", v("originCountry")], ["17. Страна назначения", `${v("destCountry")} (${v("destCode")})`], ["20. Условия поставки", `${v("termsCode")} ${d.incoterms ?? ""} ${d.place ?? ""}`],
              ["18. ТС при отправлении", `АВТО ${vehicle}`], ["19. Контейнер", "0"], ["21. ТС на границе", v("vehicleBorder") || `АВТО ${vehicle}`], ["22. Валюта и общая фактурная стоимость", `${v("currencyCode")}  ${total}`],
              ["23. Курс валюты", rate ? String(rate) : ""], ["24. Характер сделки", v("deal")], ["25. Вид транспорта на границе", v("transportBorder")], ["26. Вид транспорта внутри страны", v("transportInland")],
              ["27. Место погрузки / разгрузки", d.loadingPlace ?? ""], ["28. Финансовые и банковские сведения", v("bank")], ["29. Таможня на границе", v("customsBorder")], ["30. Место досмотра товара", v("goodsLocation")]] as const)
              .map(([l, val]) => <div key={l} style={{ ...box, borderWidth: "0 1px 1px 0" }}><span style={lab}>{l}</span>{val}</div>)}
          </div>
          <Good x={goods[0] ?? { n: 1, hs: "", text: [], pcs: 0, cartons: 0, gross: 0, net: 0, amount: 0, ctl: [] }} first />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", border: "1px solid #222", borderTop: "none" }}>
            <div style={{ ...box, minHeight: 60, borderWidth: "0 1px 0 0" }}><span style={lab}>47. Исчисление таможенных пошлин и сборов</span>Всего: —</div>
            <div style={{ ...box, minHeight: 60 }}><span style={lab}>48. Отсрочка платежей · 49. Наименование склада</span></div>
            <div style={{ ...box, minHeight: 60, borderWidth: "1px 1px 0 0" }}><span style={lab}>50. Доверитель</span>Ответственность за предоставленные сведения несёт: {v("declarant")}<div style={{ marginTop: 12 }}>подпись: ______________</div></div>
            <div style={{ ...box, minHeight: 60, borderTop: "1px solid #222" }}><span style={lab}>54. Место и дата</span>{v("declarant") ? "" : ""}_______________________<div style={{ marginTop: 12 }}>М.П.</div></div>
          </div>
          <p style={{ fontSize: 10, color: "#666" }}>Лист 1 из {1 + sheets.length}. Рабочая копия для декларанта; электронная ГТД подаётся в таможенной системе.</p>
        </div>
        {sheets.map((sh, i) => (
          <div key={i} className="gtd-page">
            <div style={{ display: "flex", justifyContent: "space-between" }}><b style={{ fontSize: 15 }}>ДОБАВОЧНЫЙ ЛИСТ &nbsp; A {v("declNo")}</b><b style={{ fontSize: 16 }}>ТД 2</b></div>
            <p style={{ fontSize: 11 }}>1. Тип декларации: {v("type")} · 3. Доб. лист: {i + 2}/{sheets.length + 1} · 2. Отпр./эксп., 8. Получ./имп.: см. гр. 2 и 8 ТД-1</p>
            {sh.map((x) => <Good key={x.n} x={x} first />)}
          </div>))}
        <div className="gtd-page">
          <b>Оборотная сторона: сведения о товарах</b>
          {goods.map((x) => (<div key={x.n} style={{ margin: "10px 0", fontSize: 12 }}><b>Товар № {x.n}</b>
            <div>1. Сведения о товаре:</div>{x.text.map((t, i) => <div key={i}>{i + 1}) {t}</div>)}
            <div>2. Сведения об упаковке товара: вид — мест; кол. упак.: {x.cartons}</div>
            <div><b>Детализация графы 31:</b></div>{x.ctl.map((t, i) => <div key={i}>{t}</div>)}</div>))}
        </div>
      </div>
    </div>
  );
}
