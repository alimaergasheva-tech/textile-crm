import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useUi } from "../state";

interface Row { id: string; number: string; brand: string | null; collection: string | null; status: string; exfactory: string | null; qty: number; cut: number; sew: number; pack: number; shipped: number;
  pctPack: number; pctShipped: number; aqlPass: number; aqlFail: number; models: number; daysLeft: number | null; lateOrders: number }

/** Сводка по всем экспортным заказам: статус, выпуск, AQL, отгрузка, дни до ex-factory. */
interface Alert { key: string; kind: string; order: string; orderId: string; text: string; days: number }

export function ExportDashboardPage() {
  const { t } = useUi();
  const q = useQuery({ queryKey: ["export-dashboard"], queryFn: () => api<Row[]>("/export-dashboard") });
  const alerts = useQuery({ queryKey: ["export-alerts"], queryFn: () => api<Alert[]>("/export-alerts") });
  const rows = q.data ?? [];
  return (
    <div>
      <h1>{t("dbTitle")}</h1>
      {(alerts.data ?? []).length > 0 && (
        <div style={{ border: "1px solid #c0392b", padding: 8, marginBottom: 12 }}>
          <b>{t("dbAlerts")}</b>
          <ul style={{ margin: "4px 0" }}>{(alerts.data ?? []).map((a) => <li key={a.key}><Link to={`/export-orders/${a.orderId}`}>{a.order}</Link>: {a.text}</li>)}</ul>
        </div>)}
      {!rows.length && <p className="muted">{t("dbNone")}</p>}
      {rows.length > 0 && (
        <table>
          <thead><tr><th>{t("dbOrder")}</th><th>{t("shStatus")}</th><th>Ex-factory</th><th>{t("prOrdered")}</th><th>{t("prCut")}</th><th>{t("prSew")}</th><th>{t("prPack")}</th><th>{t("prShipped")}</th><th>AQL</th><th>{t("dbLate")}</th></tr></thead>
          <tbody>{rows.map((r) => {
            const risk = r.daysLeft !== null && r.daysLeft < 14 && r.pctPack < 100 && !["shipped", "closed"].includes(r.status);
            return (
              <tr key={r.id}>
                <td><Link to={`/export-orders/${r.id}`}>{r.number}</Link><div className="muted">{[r.brand, r.collection].filter(Boolean).join(" · ")}</div></td>
                <td>{t(`dbSt_${r.status}` as never)}</td>
                <td>{r.exfactory ?? "—"}{r.daysLeft !== null && <div style={{ color: risk ? "#c0392b" : undefined }}>{r.daysLeft >= 0 ? `${r.daysLeft} ${t("dbDays")}` : t("dbOverdue")}</div>}</td>
                <td>{r.qty.toLocaleString()}</td><td>{r.cut.toLocaleString()}</td><td>{r.sew.toLocaleString()}</td>
                <td>{r.pack.toLocaleString()} ({r.pctPack}%)</td><td>{r.shipped.toLocaleString()} ({r.pctShipped}%)</td>
                <td>{r.aqlPass}/{r.models}{r.aqlFail > 0 && <span style={{ color: "#c0392b" }}> ✕{r.aqlFail}</span>}</td>
                <td style={{ color: r.lateOrders ? "#c0392b" : undefined }}>{r.lateOrders || "—"}</td>
              </tr>);
          })}</tbody>
        </table>)}
    </div>
  );
}
