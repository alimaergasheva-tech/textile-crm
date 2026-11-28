import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useMe, useUi } from "../state";

interface Party { name?: string; address?: string; tin?: string; bank?: string }
interface ModelDet { description?: string; hs?: string; composition?: string; netKg?: number }
interface Details { gtd?: Record<string, string>; seller?: Party; consignee?: Party; invoiceNo?: string; invoiceDate?: string; incoterms?: string; place?: string; origin?: string; paymentTerms?: string;
  loadingPlace?: string; deliveryPlace?: string; driver?: string; trailer?: string; remarks?: string; models?: Record<string, ModelDet> }
interface DocLine { modelId: string; model: string; description: string; hs: string; composition: string; qty: number; unitPrice: number; amount: number; netKg: number; cartons: number | null }
interface Data { shipment: { id: string; order_id: string; number: string; carrier: string | null; plate: string | null; cmr_no: string | null; destination: string; loading_date: string | null; po_no: string | null; order_number: string; brand: string | null; collection: string | null; currency: string };
  details: Details; version: number; lines: DocLine[]; totals: { qty: number; amount: number; netKg: number; grossKg: number; cartons: number; volumeM3: number }; missing: string[]; models: { modelId: string; model: string; kind: string | null }[] }
type Tab = "invoice" | "packing" | "cmr" | "customs";
const cell: React.CSSProperties = { border: "1px solid #999", padding: "4px 8px", textAlign: "left", verticalAlign: "top" };
const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const lines = (p?: Party) => [p?.name, p?.address, p?.tin ? `TIN ${p.tin}` : ""].filter(Boolean).map((x, i) => <div key={i}>{x}</div>);

/** Документы ВЭД по отгрузке: реквизиты + печатные формы (инвойс, упаковочный лист, CMR, таможенная ведомость). PDF — печать страницы. */
export function ExportVedPage() {
  const { id, sid } = useParams();
  const { t } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const manage = can("exportved.manage");
  const q = useQuery({ queryKey: ["export-ved", sid], queryFn: () => api<Data>(`/export-shipments/${sid}/ved`) });
  const [d, setD] = useState<Details>({});
  const [tab, setTab] = useState<Tab>("invoice");
  const [err, setErr] = useState("");
  useEffect(() => { if (q.data) setD(q.data.details); }, [q.data]);
  const save = useMutation({
    mutationFn: () => api<Data>(`/export-shipments/${sid}/ved`, { method: "PUT", body: JSON.stringify({ version: q.data!.version, details: d }) }),
    onSuccess: (r) => { setErr(""); qc.setQueryData(["export-ved", sid], r); }, onError: (e) => setErr(e instanceof Error ? e.message : String(e)),
  });
  const r = q.data;
  if (!r) return <p className="muted">{q.isError ? (q.error as Error).message : "…"}</p>;
  const s = r.shipment;
  const set = (k: keyof Details, v: string) => setD({ ...d, [k]: v });
  const party = (k: "seller" | "consignee", f: keyof Party, v: string) => setD({ ...d, [k]: { ...d[k], [f]: v } });
  const model = (mid: string, f: keyof ModelDet, v: string) => setD({ ...d, models: { ...d.models, [mid]: { ...d.models?.[mid], [f]: f === "netKg" ? (v === "" ? undefined : Number(v)) : v } } });
  const L = r.lines, T = r.totals, x = r.details;
  const head = (title: string) => (<><h1 style={{ margin: 0 }}>{title}</h1><p style={{ margin: "4px 0 12px" }}>No. {x.invoiceNo} · {x.invoiceDate ?? ""}{s.po_no ? ` · PO ${s.po_no}` : ""}</p></>);
  return (
    <div>
      <p><Link to={`/export-orders/${id}`}>← {s.order_number}</Link></p>
      <h2>{t("vedTitle")}: {s.number}</h2>
      <p><Link to={`/export-orders/${id}/shipments/${sid}/gtd`}>ГТД (ТД-1, ТД-2) →</Link></p>
      {r.missing.length > 0 && <div style={{ border: "1px solid #e0a030", padding: 8, marginBottom: 8 }}><b>{t("vedMissing")}</b><ul style={{ margin: "4px 0" }}>{r.missing.map((m) => <li key={m}>{m}</li>)}</ul></div>}
      <details open={r.missing.length > 0}>
        <summary>{t("vedDetails")}</summary>
        <div className="toolbar" style={{ flexWrap: "wrap" }}>
          {(["seller", "consignee"] as const).map((k) => (
            <fieldset key={k} style={{ minWidth: 260 }}><legend>{k === "seller" ? t("vedSeller") : t("vedBuyer")}</legend>
              {(["name", "address", "tin", "bank"] as const).map((f) => (f === "bank" && k === "consignee") ? null :
                <input key={f} disabled={!manage} placeholder={f} style={{ display: "block", width: "100%" }} value={d[k]?.[f] ?? ""} onChange={(e) => party(k, f, e.target.value)} />)}
            </fieldset>))}
          <fieldset><legend>{t("vedInvoice")}</legend>
            <input disabled={!manage} placeholder="Invoice No" value={d.invoiceNo ?? ""} onChange={(e) => set("invoiceNo", e.target.value)} />
            <input disabled={!manage} type="date" value={d.invoiceDate ?? ""} onChange={(e) => set("invoiceDate", e.target.value)} />
            <input disabled={!manage} placeholder="Incoterms" style={{ width: 80 }} value={d.incoterms ?? ""} onChange={(e) => set("incoterms", e.target.value)} />
            <input disabled={!manage} placeholder="Place (e.g. Tashkent)" value={d.place ?? ""} onChange={(e) => set("place", e.target.value)} />
            <input disabled={!manage} placeholder="Origin" value={d.origin ?? ""} onChange={(e) => set("origin", e.target.value)} />
            <input disabled={!manage} placeholder="Payment terms" value={d.paymentTerms ?? ""} onChange={(e) => set("paymentTerms", e.target.value)} />
          </fieldset>
          <fieldset><legend>CMR</legend>
            <input disabled={!manage} placeholder="Loading place" value={d.loadingPlace ?? ""} onChange={(e) => set("loadingPlace", e.target.value)} />
            <input disabled={!manage} placeholder="Delivery place" value={d.deliveryPlace ?? ""} onChange={(e) => set("deliveryPlace", e.target.value)} />
            <input disabled={!manage} placeholder="Driver" value={d.driver ?? ""} onChange={(e) => set("driver", e.target.value)} />
            <input disabled={!manage} placeholder="Trailer" value={d.trailer ?? ""} onChange={(e) => set("trailer", e.target.value)} />
            <input disabled={!manage} placeholder="Remarks" value={d.remarks ?? ""} onChange={(e) => set("remarks", e.target.value)} />
          </fieldset>
        </div>
        <table>
          <thead><tr><th>{t("model")}</th><th>Description</th><th>HS code</th><th>Composition</th><th>{t("vedNet")}</th></tr></thead>
          <tbody>{r.models.map((m) => { const v = d.models?.[m.modelId] ?? {}; return (
            <tr key={m.modelId}><td>{m.model}</td>
              <td><input disabled={!manage} value={v.description ?? ""} onChange={(e) => model(m.modelId, "description", e.target.value)} /></td>
              <td><input disabled={!manage} style={{ width: 110 }} value={v.hs ?? ""} onChange={(e) => model(m.modelId, "hs", e.target.value)} /></td>
              <td><input disabled={!manage} value={v.composition ?? ""} onChange={(e) => model(m.modelId, "composition", e.target.value)} /></td>
              <td><input disabled={!manage} type="number" step="0.001" style={{ width: 80 }} value={v.netKg ?? ""} onChange={(e) => model(m.modelId, "netKg", e.target.value)} /></td></tr>); })}</tbody>
        </table>
        {manage && <button disabled={save.isPending} onClick={() => save.mutate()}>{t("vedSave")}</button>}
        {err && <span style={{ color: "#c0392b" }}> {err}</span>}
      </details>
      <div className="toolbar" style={{ marginTop: 8 }}>
        {(["invoice", "packing", "cmr", "customs"] as Tab[]).map((k) => <button key={k} disabled={tab === k} onClick={() => setTab(k)}>{t(`vedTab_${k}` as never)}</button>)}
        <button onClick={() => window.print()}>Save as PDF / Print</button>
      </div>
      <style>{`@media print { body * { visibility: hidden } .ved-doc, .ved-doc * { visibility: visible } .ved-doc { position: absolute; left: 0; top: 0; width: 100% } }`}</style>
      <div className="ved-doc" style={{ background: "#fff", color: "#111", padding: 24, fontFamily: "Arial, sans-serif", fontSize: 13 }}>
        {tab === "invoice" && (<div>{head("COMMERCIAL INVOICE")}
          <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: 10 }}><tbody><tr>
            <td style={cell}><b>Seller / Exporter</b>{lines(x.seller)}<div>{x.seller?.bank}</div></td><td style={cell}><b>Consignee / Buyer</b>{lines(x.consignee)}</td></tr>
            <tr><td style={cell}>Terms of delivery: {x.incoterms} {x.place}<br />Payment: {x.paymentTerms ?? "—"}</td><td style={cell}>Country of origin: {x.origin}<br />Destination: {s.destination}<br />Brand: {[s.brand, s.collection].filter(Boolean).join(" / ")}</td></tr></tbody></table>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead><tr>{["Model", "Description / composition", "HS code", "Qty, pcs", `Unit price, ${s.currency}`, `Amount, ${s.currency}`].map((h) => <th key={h} style={cell}>{h}</th>)}</tr></thead>
            <tbody>{L.map((l) => <tr key={l.modelId}><td style={cell}>{l.model}</td><td style={cell}>{l.description}{l.composition ? `, ${l.composition}` : ""}</td><td style={cell}>{l.hs}</td><td style={cell}>{l.qty.toLocaleString()}</td><td style={cell}>{money(l.unitPrice)}</td><td style={cell}>{money(l.amount)}</td></tr>)}
              <tr><th style={cell} colSpan={3}>TOTAL</th><th style={cell}>{T.qty.toLocaleString()}</th><th style={cell} /><th style={cell}>{money(T.amount)}</th></tr></tbody></table>
          <p style={{ marginTop: 40 }}>Signature: ______________________</p></div>)}
        {tab === "packing" && (<div>{head("PACKING LIST")}
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead><tr>{["Model", "Description", "Cartons", "Qty, pcs", "Net weight, kg"].map((h) => <th key={h} style={cell}>{h}</th>)}</tr></thead>
            <tbody>{L.map((l) => <tr key={l.modelId}><td style={cell}>{l.model}</td><td style={cell}>{l.description}</td><td style={cell}>{l.cartons ?? ""}</td><td style={cell}>{l.qty.toLocaleString()}</td><td style={cell}>{money(l.netKg)}</td></tr>)}
              <tr><th style={cell} colSpan={2}>TOTAL</th><th style={cell}>{T.cartons}</th><th style={cell}>{T.qty.toLocaleString()}</th><th style={cell}>{money(T.netKg)}</th></tr></tbody></table>
          <p>Gross weight: {money(T.grossKg)} kg · Volume: {T.volumeM3} m³ · Truck: {s.plate ?? "—"}{x.trailer ? ` / ${x.trailer}` : ""}</p></div>)}
        {tab === "cmr" && (<div>{head("CMR — consignment note data")}
          <table style={{ borderCollapse: "collapse", width: "100%" }}><tbody>
            <tr><td style={cell}><b>1. Sender</b>{lines(x.seller)}</td><td style={cell}><b>CMR No</b><div>{s.cmr_no ?? "—"}</div></td></tr>
            <tr><td style={cell}><b>2. Consignee</b>{lines(x.consignee)}</td><td style={cell}><b>16. Carrier</b><div>{s.carrier}</div><div>Truck {s.plate}{x.trailer ? ` / trailer ${x.trailer}` : ""}</div><div>Driver: {x.driver ?? "—"}</div></td></tr>
            <tr><td style={cell}><b>3. Place of delivery</b><div>{x.deliveryPlace}</div></td><td style={cell}><b>4. Place and date of loading</b><div>{x.loadingPlace ?? "—"}, {s.loading_date ?? ""}</div></td></tr>
            <tr><td style={cell} colSpan={2}><b>6–12. Goods</b>{L.map((l) => <div key={l.modelId}>{l.model} — {l.description}, HS {l.hs}: {l.qty.toLocaleString()} pcs</div>)}
              <div style={{ marginTop: 6 }}>Cartons: {T.cartons} · Gross: {money(T.grossKg)} kg · Volume: {T.volumeM3} m³</div></td></tr>
            <tr><td style={cell} colSpan={2}><b>13. Sender's instructions / remarks</b><div>{x.remarks ?? ""} Invoice {x.invoiceNo}; {x.incoterms} {x.place}</div></td></tr>
          </tbody></table></div>)}
        {tab === "customs" && (<div><h1 style={{ margin: 0 }}>Таможенная ведомость (для декларанта: ГТД / СТ-1)</h1>
          <p>Инвойс {x.invoiceNo} от {x.invoiceDate ?? "—"} · {x.incoterms} {x.place} · страна происхождения: {x.origin} · страна назначения: {s.destination}</p>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead><tr>{["№", "Код ТН ВЭД", "Наименование", "Кол-во, шт", "Нетто, кг", "Стоимость, " + s.currency].map((h) => <th key={h} style={cell}>{h}</th>)}</tr></thead>
            <tbody>{L.map((l, i) => <tr key={l.modelId}><td style={cell}>{i + 1}</td><td style={cell}>{l.hs}</td><td style={cell}>{l.model} {l.description} {l.composition}</td><td style={cell}>{l.qty.toLocaleString()}</td><td style={cell}>{money(l.netKg)}</td><td style={cell}>{money(l.amount)}</td></tr>)}
              <tr><th style={cell} colSpan={3}>Итого</th><th style={cell}>{T.qty.toLocaleString()}</th><th style={cell}>{money(T.netKg)}</th><th style={cell}>{money(T.amount)}</th></tr></tbody></table>
          <p>Брутто: {money(T.grossKg)} кг · мест: {T.cartons} · транспорт: {s.carrier} {s.plate} · CMR {s.cmr_no ?? "—"}</p>
          <p style={{ color: "#666" }}>Ведомость содержит данные для заполнения ГТД и СТ-1 декларантом или брокером; официальные бланки формируются в таможенной системе.</p></div>)}
      </div>
    </div>
  );
}
