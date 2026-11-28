import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useMe, useUi } from "../state";
import type { Key } from "../i18n";

interface Line { code: string; qty: number; fabricUsd: number; trimsUsd: number; otherUsd: number; cmtUsd: number; totalUsd: number; costPerSet: number; pricePerSet: number; revenueUsd: number; profitUsd: number }
interface Costing { warnings: string[]; lines: Line[]; params: Record<string, number>;
  totals: { qty: number; costUsd: number; revenueUsd: number; profitUsd: number; avgCostPerSet: number; avgPricePerSet: number; logisticsUsd: number; avgPriceWithLogistics: number } }
interface Quote { id: string; number: string; rev: number; status: string; totals: Costing["totals"]; promised_exfactory: string | null; valid_until: string | null; notes: string | null;
  sent_at: string | null; decided_at: string | null; decided_note: string | null; confirmed_by_name: string | null; version: number }
const n = (x: number, d = 0) => x.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
const day = (s: string | null) => (s ? s.slice(0, 10) : "—");

/** Себестоимость, цена FOB и коммерческое предложение: фиксация, отправка клиенту, подтверждение цены и срока. */
export function ExportQuotes({ orderId }: { orderId: string }) {
  const { t } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const manage = can("exportquotes.manage");
  const cost = useQuery({ queryKey: ["export-costing", orderId], queryFn: () => api<Costing>(`/export-orders/${orderId}/costing`), retry: false });
  const quotes = useQuery({ queryKey: ["export-quotes", orderId], queryFn: () => api<Quote[]>(`/export-orders/${orderId}/quotes`) });
  const [f, setF] = useState({ promisedExfactory: "", validUntil: "", notes: "" });
  const [who, setWho] = useState<Record<string, string>>({});
  const refresh = () => { qc.invalidateQueries({ queryKey: ["export-quotes", orderId] }); qc.invalidateQueries({ queryKey: ["export-order", orderId] }); };
  const create = useMutation({
    mutationFn: () => api(`/export-orders/${orderId}/quotes`, { method: "POST", body: JSON.stringify({ promisedExfactory: f.promisedExfactory || null, validUntil: f.validUntil || null, notes: f.notes || null }) }),
    onSuccess: refresh,
  });
  const setStatus = useMutation({
    mutationFn: (v: { id: string; status: string; version: number; confirmedByName?: string }) =>
      api(`/export-quotes/${v.id}/status`, { method: "PATCH", body: JSON.stringify({ status: v.status, version: v.version, confirmedByName: v.confirmedByName }) }),
    onSettled: refresh,
  });
  const c = cost.data;
  return (
    <div>
      <h2>{t("costAndQuote")}</h2>
      {cost.isError && <div className="err">{(cost.error as Error)?.message || t("error")}</div>}
      {c && (
        <>
          {c.warnings.map((w, i) => <div key={i} className="err">⚠ {w}</div>)}
          <table>
            <thead><tr><th>{t("model")}</th><th>{t("qty")}</th><th>{t("costFabric")}, $</th><th>{t("costTrims")}, $</th><th>{t("costOther")}, $</th><th>{t("costCmt")}, $</th><th>{t("costTotal")}, $</th><th>{t("costPerSet")}</th><th>{t("pricePerSet")}</th><th>{t("revenue")}, $</th></tr></thead>
            <tbody>
              {c.lines.map((l) => (
                <tr key={l.code}><td>{l.code}</td><td>{n(l.qty)}</td><td>{n(l.fabricUsd)}</td><td>{n(l.trimsUsd)}</td><td>{n(l.otherUsd)}</td><td>{n(l.cmtUsd)}</td><td>{n(l.totalUsd)}</td><td>{n(l.costPerSet, 2)}</td><td><b>{n(l.pricePerSet, 2)}</b></td><td>{n(l.revenueUsd)}</td></tr>))}
              <tr><td><b>{t("total")}</b></td><td><b>{n(c.totals.qty)}</b></td><td colSpan={4} /><td><b>{n(c.totals.costUsd)}</b></td><td>{n(c.totals.avgCostPerSet, 2)}</td><td><b>{n(c.totals.avgPricePerSet, 2)}</b></td><td><b>{n(c.totals.revenueUsd)}</b></td></tr>
            </tbody>
          </table>
          <p className="muted">{t("profit")}: ${n(c.totals.profitUsd)} · {t("margin")} {n(c.params.marginPct * 100, 1)}% · {t("logistics")}: ${n(c.totals.logisticsUsd)} ({t("priceWithLogistics")} ${n(c.totals.avgPriceWithLogistics, 2)})</p>
        </>
      )}
      {manage && c && (
        <div className="toolbar">
          <label>{t("promisedExFactory")} <input type="date" value={f.promisedExfactory} onChange={(e) => setF({ ...f, promisedExfactory: e.target.value })} /></label>
          <label>{t("validUntil")} <input type="date" value={f.validUntil} onChange={(e) => setF({ ...f, validUntil: e.target.value })} /></label>
          <input placeholder={t("notes")} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          <button disabled={create.isPending} onClick={() => create.mutate()}>{t("fixQuote")}</button>
          {create.isError && <span className="err">{(create.error as Error)?.message || t("error")}</span>}
        </div>
      )}
      <h3>{t("quotes")}</h3>
      <table>
        <thead><tr><th>№</th><th>{t("status")}</th><th>{t("pricePerSet")}</th><th>{t("revenue")}, $</th><th>{t("promisedExFactory")}</th><th>{t("validUntil")}</th><th>{t("confirmedBy")}</th><th /></tr></thead>
        <tbody>{quotes.data?.map((q) => (
          <tr key={q.id} style={q.status === "superseded" ? { opacity: 0.5 } : undefined}>
            <td>{q.number}</td><td>{t(`qs_${q.status}` as Key)}</td><td>{n(q.totals.avgPricePerSet, 2)}</td><td>{n(q.totals.revenueUsd)}</td><td>{day(q.promised_exfactory)}</td><td>{day(q.valid_until)}</td>
            <td>{q.confirmed_by_name ?? "—"}{q.decided_at ? ` · ${day(q.decided_at)}` : ""}</td>
            <td><Link to={`/export-orders/${orderId}/quotes/${q.id}/print`}>PDF</Link>{manage && (
              <>
                {q.status === "draft" && <button onClick={() => setStatus.mutate({ id: q.id, status: "sent", version: q.version })}>{t("markSent")}</button>}
                {q.status === "sent" && (
                  <>
                    <input style={{ width: 150 }} placeholder={t("confirmedBy")} value={who[q.id] ?? ""} onChange={(e) => setWho({ ...who, [q.id]: e.target.value })} />
                    <button disabled={(who[q.id] ?? "").trim().length < 2} onClick={() => setStatus.mutate({ id: q.id, status: "confirmed", version: q.version, confirmedByName: who[q.id].trim() })}>{t("clientConfirmed")}</button>
                    <button onClick={() => setStatus.mutate({ id: q.id, status: "rejected", version: q.version })}>{t("clientRejected")}</button>
                  </>
                )}
              </>)}</td>
          </tr>))}</tbody>
      </table>
      {setStatus.isError && <div className="err">{(setStatus.error as Error)?.message || t("conflictMsg")}</div>}
    </div>
  );
}
