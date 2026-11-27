import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { enqueue, onQueue } from "./queue";
import { Key } from "./i18n";

type T = (k: Key) => string;
function useData<X>(path: string): X | null {
  const [d, setD] = useState<X | null>(null);
  const load = useCallback(() => { api<X>(path).then(setD).catch(() => {}); }, [path]);
  useEffect(() => { load(); return onQueue(load); }, [load]);
  return d;
}

/** Подрядчики: передать крой, отметить привезённое, принять (годные/брак). Все действия идут через очередь без дублей. */
export function Contractors({ t, canAccept }: { t: T; canAccept: boolean }) {
  const rows = useData<any[]>("/contractor-holdings");
  const pending = useData<any[]>("/contractor-receipts");
  if (!rows) return <p className="muted" style={{ padding: 20 }}>…</p>;
  return <>
    {canAccept && (pending ?? []).map((r) => <Accept key={r.id} r={r} t={t} />)}
    {!rows.length && !pending?.length && <p className="muted" style={{ padding: 20 }}>{t("empty")}</p>}
    {rows.map((r) => <Step key={r.step_id} r={r} t={t} />)}
  </>;
}

function Step({ r, t }: { r: any; t: T }) {
  const [qty, setQty] = useState("");
  const n = Number(qty) || 0;
  const send = (kind: "transfer" | "receipts", label: Key) => {
    if (n <= 0) return;
    enqueue({ path: `/production-steps/${r.step_id}/${kind}`, method: "POST", body: { qty: n }, label: `${r.contractor}: ${t(label)} ${n}` });
    setQty("");
  };
  return <div className="card">
    <h3>{r.contractor}</h3><div className="muted">{r.number} · {r.model_code} · {r.step}</div>
    <div className="muted">{t("planWord")} {r.plan} · {t("sentWord")} {r.transferred} · {t("acceptedWord")} {r.accepted}{r.defect ? ` · ${t("defect")} ${r.defect}` : ""}</div>
    <div><b style={{ fontSize: 22 }}>{r.at_contractor}</b> <span className="muted">{t("atContractor")}{r.pending ? ` (${t("pendingQc")}: ${r.pending})` : ""}</span></div>
    <div className="row" style={{ marginTop: 8 }}>
      <input className="qty" inputMode="numeric" value={qty} placeholder="0" onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))} />
      <button disabled={n <= 0} onClick={() => send("transfer", "sendCut")}>{t("sendCut")}</button>
      <button className="ghost" disabled={n <= 0} onClick={() => send("receipts", "brought")}>{t("brought")}</button>
    </div></div>;
}

function Accept({ r, t }: { r: any; t: T }) {
  const [good, setGood] = useState(String(r.qty));
  const defect = Math.max(0, r.qty - (Number(good) || 0));
  return <div className="card"><h3>{r.contractor} · {r.qty}</h3><div className="muted">{r.number} · {r.step}</div>
    <div className="row" style={{ margin: "8px 0" }}><input className="qty" inputMode="numeric" value={good} onChange={(e) => setGood(e.target.value.replace(/\D/g, ""))} aria-label={t("good")} />
      <span className="muted">{t("good")} / {t("defect")}: {defect}</span></div>
    <button style={{ width: "100%" }} disabled={(Number(good) || 0) > r.qty}
      onClick={() => enqueue({ path: `/contractor-receipts/${r.id}/accept`, method: "POST", body: { good: Number(good) || 0, defect }, label: `${t("accept")} ${r.contractor}` })}>{t("accept")}</button></div>;
}
