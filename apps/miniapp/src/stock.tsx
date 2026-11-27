import { useEffect, useState } from "react";
import { api } from "./api";
import { enqueue } from "./queue";
import { Key } from "./i18n";

type T = (k: Key) => string;
const tg = (window as any).Telegram?.WebApp;

/** Наличие готовой продукции для всех; приход/расход со сканированием кода — для кладовщика (право warehouse.write). */
export function Stock({ t, canWrite }: { t: T; canWrite: boolean }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => {
    const h = setTimeout(() => api(`/stock/balances?kind=variant${q ? `&q=${encodeURIComponent(q)}` : ""}`).then(setRows).catch(() => {}), 250);
    return () => clearTimeout(h);
  }, [q]);
  return <>
    {canWrite && <Op t={t} />}
    <div style={{ padding: "8px 14px" }}><input placeholder={t("search")} value={q} onChange={(e) => setQ(e.target.value)} /></div>
    {rows?.map((r) => <div className="card" key={r.id}>
      <h3>{r.model_code} · {r.size} · {r.color}</h3><div className="muted">{r.model_name} · {r.sku}</div>
      <div><b style={{ fontSize: 22 }}>{Math.max(0, r.qty - r.reserved)}</b> <span className="muted">{t("available")} ({r.qty}, {t("reserved")} {r.reserved})</span></div></div>)}
  </>;
}

function Op({ t }: { t: T }) {
  const [code, setCode] = useState("");
  const [found, setFound] = useState<any>(null);
  const [locs, setLocs] = useState<{ id: string; label: string }[]>([]);
  const [f, setF] = useState({ type: "receipt", locationId: "", qty: "" });
  const [msg, setMsg] = useState("");
  useEffect(() => { api("/warehouses").then((w: any[]) => {
    const l = w.flatMap((x) => x.locations.map((y: any) => ({ id: y.id, label: `${x.name} / ${y.code}` })));
    setLocs(l); setF((x) => ({ ...x, locationId: l[0]?.id ?? "" })); }).catch(() => {}); }, []);
  const lookup = async (c: string) => {
    setMsg(""); setFound(null);
    try { setFound(await api(`/stock/scan?code=${encodeURIComponent(c)}`)); } catch { setMsg(t("notFound")); }
  };
  const scan = () => tg?.showScanQrPopup?.({}, (text: string) => { setCode(text); void lookup(text); tg.closeScanQrPopup?.(); return true; });
  const send = () => {
    if (!found) return setMsg(t("pickCode"));
    const body = { materialId: found.materialId, variantId: found.variantId, lotId: found.lotId, rollId: found.rollId, locationId: f.locationId, qty: Number(f.qty) };
    enqueue({ path: f.type === "receipt" ? "/stock/receipts" : "/stock/issues", method: "POST", body, label: `${t(f.type as Key)} ${found.label}` });
    setMsg(t("saved")); setF({ ...f, qty: "" });
  };
  return <div className="card"><div className="form" style={{ padding: 0 }}>
    <div className="row"><input style={{ flex: 1 }} placeholder={t("code")} value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && lookup(code)} />
      {tg?.showScanQrPopup && <button className="ghost" onClick={scan}>{t("scan")}</button>}<button className="ghost" onClick={() => lookup(code)}>OK</button></div>
    {found && <b>{found.label}{found.qty !== undefined ? ` · ${found.qty}` : ""}</b>}
    <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="receipt">{t("receipt")}</option><option value="issue">{t("issue")}</option></select>
    <select value={f.locationId} onChange={(e) => setF({ ...f, locationId: e.target.value })}>{locs.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</select>
    <input className="qty" style={{ width: "100%" }} inputMode="decimal" placeholder={t("qty")} value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value.replace(",", ".").replace(/[^0-9.]/g, "") })} />
    <button disabled={!found || !Number(f.qty) || !f.locationId} onClick={send}>{t("save")}</button>{msg && <span className="muted">{msg}</span>}</div></div>;
}
