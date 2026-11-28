import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

interface Report { order_number: string; brand: string | null; collection: string | null; model: string; round: number; status: string; inspected_on: string | null; inspector: string | null; lot_qty: number; sample_size: number;
  aql_major: number; aql_minor: number; ac_major: number; re_major: number; ac_minor: number; re_minor: number; notes: string | null; finalized_at: string | null;
  defects: { id: string; defect: string; severity: string; qty: number; note: string | null }[]; photos: { id: string; caption: string | null; src: string }[];
  verdict: { critical: number; major: number; minor: number; result: "pass" | "fail"; reasons: string[] } }

/** Печатный отчёт финальной инспекции (английский, для клиента). «Сохранить PDF» = печать страницы в PDF средствами браузера. */
export function ExportInspectionReport() {
  const { iid } = useParams();
  const q = useQuery({ queryKey: ["export-inspection-report-page", iid], queryFn: () => api<Report>(`/export-inspections/${iid}/report`) });
  const r = q.data;
  const cell: React.CSSProperties = { border: "1px solid #999", padding: "4px 8px", textAlign: "left" };
  return (
    <div className="aql-report" style={{ position: "fixed", inset: 0, background: "#fff", color: "#111", zIndex: 9999, overflow: "auto", padding: 32, fontFamily: "Arial, sans-serif" }}>
      <style>{`@media print { body * { visibility: hidden } .aql-report, .aql-report * { visibility: visible } .aql-report { position: absolute !important; left: 0; top: 0; overflow: visible !important } .noprint { display: none !important } img { page-break-inside: avoid } }`}</style>
      <div className="noprint" style={{ marginBottom: 16 }}><button onClick={() => window.print()}>Save as PDF / Print</button></div>
      {q.isError && <div style={{ color: "#c0392b" }}>{(q.error as Error).message}</div>}
      {r && (
        <div style={{ maxWidth: 820, margin: "0 auto" }}>
          <h1 style={{ margin: 0 }}>Final Inspection Report (AQL)</h1>
          <p style={{ margin: "4px 0 16px" }}>ISO 2859-1, General Inspection Level II, single sampling, normal inspection</p>
          <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: 12 }}><tbody>
            <tr><th style={cell}>Order</th><td style={cell}>{r.order_number}</td><th style={cell}>Brand / Collection</th><td style={cell}>{[r.brand, r.collection].filter(Boolean).join(" / ") || "—"}</td></tr>
            <tr><th style={cell}>Model</th><td style={cell}>{r.model}{r.round > 1 ? ` (round ${r.round})` : ""}</td><th style={cell}>Inspection date</th><td style={cell}>{r.inspected_on?.slice(0, 10) ?? "—"}</td></tr>
            <tr><th style={cell}>Lot size</th><td style={cell}>{r.lot_qty.toLocaleString()} pcs</td><th style={cell}>Sample size</th><td style={cell}>{r.sample_size}</td></tr>
            <tr><th style={cell}>Inspector</th><td style={cell} colSpan={3}>{r.inspector ?? "—"}</td></tr>
          </tbody></table>
          <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: 12 }}>
            <thead><tr><th style={cell}>Defect class</th><th style={cell}>AQL</th><th style={cell}>Accept / Reject</th><th style={cell}>Found</th></tr></thead>
            <tbody>
              <tr><td style={cell}>Critical</td><td style={cell}>0</td><td style={cell}>0 / 1</td><td style={cell}>{r.verdict.critical}</td></tr>
              <tr><td style={cell}>Major</td><td style={cell}>{r.aql_major}</td><td style={cell}>{r.ac_major} / {r.re_major}</td><td style={cell}>{r.verdict.major}</td></tr>
              <tr><td style={cell}>Minor</td><td style={cell}>{r.aql_minor}</td><td style={cell}>{r.ac_minor} / {r.re_minor}</td><td style={cell}>{r.verdict.minor}</td></tr>
            </tbody>
          </table>
          <h2 style={{ color: r.verdict.result === "pass" ? "#1d7a43" : "#b03a2e" }}>Result: {r.verdict.result === "pass" ? "PASSED" : "FAILED"}</h2>
          {r.verdict.reasons.map((x, k) => <div key={k}>• {x}</div>)}
          {r.defects.length > 0 && (
            <><h3>Defects found</h3>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead><tr><th style={cell}>Defect</th><th style={cell}>Class</th><th style={cell}>Qty</th><th style={cell}>Note</th></tr></thead>
                <tbody>{r.defects.map((d) => <tr key={d.id}><td style={cell}>{d.defect}</td><td style={cell}>{d.severity}</td><td style={cell}>{d.qty}</td><td style={cell}>{d.note ?? ""}</td></tr>)}</tbody>
              </table></>)}
          {r.notes && <p><b>Notes:</b> {r.notes}</p>}
          {r.photos.length > 0 && (
            <><h3>Photos</h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {r.photos.map((p) => <figure key={p.id} style={{ margin: 0 }}><img src={p.src} alt="" style={{ width: "100%" }} /><figcaption style={{ fontSize: 12 }}>{p.caption}</figcaption></figure>)}
              </div></>)}
          <p style={{ marginTop: 24, fontSize: 12 }}>Report finalized: {r.finalized_at?.slice(0, 10) ?? "draft"}</p>
        </div>)}
    </div>
  );
}
