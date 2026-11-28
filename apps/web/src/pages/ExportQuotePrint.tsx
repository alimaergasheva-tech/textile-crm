import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

interface Q { number: string; rev: number; currency: string; date: string; promised_exfactory: string | null; valid_until: string | null; notes: string | null; order_number: string; brand: string | null; collection: string | null;
  po_no: string | null; incoterms: string; client_name: string; client_address: string | null; seller: string; rows: { code: string; kind: string | null; qty: number; unitPrice: number; amount: number }[]; total: number; qty: number }
const money = (n: number, d = 2) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

/** Коммерческое предложение для клиента (английский). Без себестоимости и маржи. PDF — печать страницы. */
export function ExportQuotePrint() {
  const { qid } = useParams();
  const q = useQuery({ queryKey: ["export-quote-print", qid], queryFn: () => api<Q>(`/export-quotes/${qid}/print`) });
  const r = q.data;
  const cell: React.CSSProperties = { border: "1px solid #999", padding: "4px 8px", textAlign: "left" };
  return (
    <div className="quote-print" style={{ position: "fixed", inset: 0, background: "#fff", color: "#111", zIndex: 9999, overflow: "auto", padding: 32, fontFamily: "Arial, sans-serif" }}>
      <style>{`@media print { body * { visibility: hidden } .quote-print, .quote-print * { visibility: visible } .quote-print { position: absolute !important; left: 0; top: 0; overflow: visible !important } .noprint { display: none !important } }`}</style>
      <div className="noprint" style={{ marginBottom: 16 }}><button onClick={() => window.print()}>Save as PDF / Print</button></div>
      {q.isError && <div style={{ color: "#c0392b" }}>{(q.error as Error).message}</div>}
      {r && (
        <div style={{ maxWidth: 820, margin: "0 auto" }}>
          <h1 style={{ margin: 0 }}>COMMERCIAL OFFER</h1>
          <p style={{ margin: "4px 0 16px" }}>No. {r.number} · {r.date}{r.po_no ? ` · Your PO ${r.po_no}` : ""}</p>
          <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: 12 }}><tbody>
            <tr><th style={cell}>From</th><td style={cell}>{r.seller}</td><th style={cell}>To</th><td style={cell}>{r.client_name}{r.client_address ? <div>{r.client_address}</div> : null}</td></tr>
            <tr><th style={cell}>Brand / Collection</th><td style={cell}>{[r.brand, r.collection].filter(Boolean).join(" / ") || "—"}</td><th style={cell}>Terms</th><td style={cell}>{r.incoterms}, prices in {r.currency}</td></tr>
            <tr><th style={cell}>Ex-factory date</th><td style={cell}>{r.promised_exfactory ?? "—"}</td><th style={cell}>Offer valid until</th><td style={cell}>{r.valid_until ?? "—"}</td></tr>
          </tbody></table>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead><tr>{["Model", "Item", "Qty, pcs", `Unit price, ${r.currency}`, `Amount, ${r.currency}`].map((h) => <th key={h} style={cell}>{h}</th>)}</tr></thead>
            <tbody>{r.rows.map((x) => <tr key={x.code}><td style={cell}>{x.code}</td><td style={cell}>{x.kind ?? ""}</td><td style={cell}>{x.qty.toLocaleString()}</td><td style={cell}>{money(x.unitPrice)}</td><td style={cell}>{money(x.amount)}</td></tr>)}
              <tr><th style={cell} colSpan={2}>TOTAL</th><th style={cell}>{r.qty.toLocaleString()}</th><th style={cell} /><th style={cell}>{money(r.total)}</th></tr></tbody>
          </table>
          {r.notes && <p style={{ marginTop: 12 }}>{r.notes}</p>}
          <p style={{ marginTop: 40 }}>Accepted by (name, signature, date): ______________________________</p>
        </div>)}
    </div>
  );
}
