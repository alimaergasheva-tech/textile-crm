import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useMe, useUi } from "../state";

interface Line { id: string; item_code: string; name: string; unit: string; qty: number; price_usd: number; total_usd: number }
interface Purchase { id: string; number: string; kind: "fabric" | "trims"; supplier: string; status: Status; expected_date: string | null; total_usd: number; version: number; lines: Line[] }
type Status = "draft" | "sent" | "confirmed" | "in_production" | "shipped" | "received" | "cancelled";
const NEXT: Partial<Record<Status, Status>> = { draft: "sent", sent: "confirmed", confirmed: "in_production", in_production: "shipped", shipped: "received" };
const n = (x: number, d = 0) => x.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });

/** Закупки по заказу: полотно (Узтекс) и фурнитура (Eren Textile) — формируются из расчёта расхода, статусы до получения на склад. */
export function ExportPurchases({ orderId }: { orderId: string }) {
  const { t } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const manage = can("exportpurchases.manage");
  const q = useQuery({ queryKey: ["export-purchases", orderId], queryFn: () => api<Purchase[]>(`/export-orders/${orderId}/purchases`) });
  const [dates, setDates] = useState<Record<string, string>>({});
  const [warn, setWarn] = useState<string[]>([]);
  const refresh = () => qc.invalidateQueries({ queryKey: ["export-purchases", orderId] });
  const gen = useMutation({
    mutationFn: () => api<{ warnings: string[] }>(`/export-orders/${orderId}/purchases/generate`, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: (r) => { setWarn(r.warnings ?? []); refresh(); },
  });
  const move = useMutation({
    mutationFn: (v: { p: Purchase; status: Status }) =>
      api(`/export-purchases/${v.p.id}/status`, { method: "PATCH", body: JSON.stringify({ status: v.status, version: v.p.version, expectedDate: dates[v.p.id] || undefined }) }),
    onSettled: refresh,
  });
  const edit = useMutation({
    mutationFn: (v: { id: string; priceUsd?: number; qty?: number }) => api(`/export-purchase-lines/${v.id}`, { method: "PATCH", body: JSON.stringify(v) }),
    onSettled: refresh,
  });
  const data = q.data ?? [];
  const label = (s: Status) => t(`poSt_${s}` as never);
  const nextLabel: Record<string, string> = { sent: t("poSend"), confirmed: t("poConfirm"), in_production: t("poInProd"), shipped: t("poShipped"), received: t("poReceived") };
  return (
    <div>
      <h2>{t("poTitle")}</h2>
      {manage && (
        <div className="toolbar">
          <button disabled={gen.isPending} onClick={() => gen.mutate()}>{data.length ? t("poRegen") : t("poGenerate")}</button>
          {gen.isError && <span className="err">{(gen.error as Error)?.message || t("error")}</span>}
        </div>)}
      {warn.map((w, i) => <div key={i} className="err">⚠ {w}</div>)}
      {!data.length && <p className="muted">{t("poNone")}</p>}
      {data.map((p) => {
        const editable = manage && (p.status === "draft" || p.status === "sent");
        const next = NEXT[p.status];
        return (
          <div key={p.id} style={{ margin: "12px 0" }}>
            <h3>{p.number} · {p.supplier} <span className="muted">({p.kind === "fabric" ? t("poFabric") : t("poTrims")})</span> — <b>{label(p.status)}</b></h3>
            <table>
              <thead><tr><th>{t("poItem")}</th><th>{t("poUnit")}</th><th>{t("qty")}</th><th>{t("poPrice")}, $</th><th>{t("poSum")}, $</th></tr></thead>
              <tbody>
                {p.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.name}</td><td>{l.unit}</td><td>{n(l.qty, 1)}</td>
                    <td>{editable
                      ? <input type="number" step="0.01" min={0} defaultValue={l.price_usd} style={{ width: 90 }} onBlur={(e) => { const v = Number(e.target.value); if (v !== l.price_usd && v >= 0) edit.mutate({ id: l.id, priceUsd: v }); }} />
                      : n(l.price_usd, 2)}</td>
                    <td>{n(l.total_usd, 2)}</td>
                  </tr>))}
                <tr><td colSpan={4}><b>{t("total")}</b></td><td><b>{n(p.total_usd, 2)}</b></td></tr>
              </tbody>
            </table>
            {manage && (next || (p.status !== "received" && p.status !== "cancelled")) && (
              <div className="toolbar">
                {p.status === "sent" || p.status === "confirmed" || p.status === "in_production" ? (
                  <label>{t("poExpected")} <input type="date" value={dates[p.id] ?? p.expected_date?.slice(0, 10) ?? ""} onChange={(e) => setDates({ ...dates, [p.id]: e.target.value })} /></label>
                ) : null}
                {next && <button disabled={move.isPending} onClick={() => move.mutate({ p, status: next })}>{nextLabel[next]}</button>}
                {p.status !== "received" && p.status !== "cancelled" && <button className="secondary" disabled={move.isPending} onClick={() => move.mutate({ p, status: "cancelled" })}>{t("poCancel")}</button>}
              </div>)}
            {p.expected_date && <div className="muted">{t("poExpected")}: {p.expected_date.slice(0, 10)}</div>}
          </div>);
      })}
      {(move.isError || edit.isError) && <div className="err">{((move.error || edit.error) as Error)?.message || t("error")}</div>}
    </div>
  );
}
