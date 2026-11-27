import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Key, Lang } from "./i18n";

type T = (k: Key) => string;
const money = (minor: number, cur: string) => `${(minor / 100).toLocaleString("ru-RU")} ${cur}`;

/** Менеджер: открытые сделки, быстрый новый лид, отметка «КП отправлено». */
export function Deals({ t, lang, can }: { t: T; lang: Lang; can: (p: string) => boolean }) {
  const [data, setData] = useState<{ stages: any[]; deals: any[] } | null>(null);
  const [quotes, setQuotes] = useState<any[]>([]);
  const load = useCallback(() => {
    api("/deals").then(setData).catch(() => {});
    if (can("quotes.view")) api("/quotes").then(setQuotes).catch(() => {});
  }, [can]);
  useEffect(load, [load]);
  if (!data) return <p className="muted" style={{ padding: 20 }}>…</p>;
  const open = new Map(data.stages.filter((s) => s.kind === "open").map((s) => [s.id, s.name]));
  const deals = data.deals.filter((d) => open.has(d.stage_id));
  return <>
    {can("leads.create") && <NewLead t={t} lang={lang} />}
    <h3 style={{ margin: "14px 14px 0" }}>{t("open")}: {deals.length}</h3>
    {deals.map((d) => <div className="card" key={d.id}>
      <h3>{d.title}</h3><div className="muted">{d.client_name} · {open.get(d.stage_id)}</div>
      <b>{money(d.amount, d.currency)}</b></div>)}
    {can("quotes.view") && quotes.length > 0 && <>
      <h3 style={{ margin: "14px 14px 0" }}>{t("quotes")}</h3>
      {quotes.slice(0, 20).map((q) => <div className="card" key={q.id}>
        <h3>{q.number} · {q.client_name}</h3><div className="muted">{q.status} · {money(q.total, q.currency)}</div>
        {can("quotes.edit") && q.status === "draft" && <button style={{ marginTop: 8 }} onClick={() => api(`/quotes/${q.id}/status`, { method: "PATCH", body: JSON.stringify({ status: "sent" }) }).then(load).catch(() => {})}>{t("markSent")}</button>}
      </div>)}</>}
  </>;
}

function NewLead({ t, lang }: { t: T; lang: Lang }) {
  const [src, setSrc] = useState<any[]>([]);
  const [f, setF] = useState({ name: "", phone: "", sourceCode: "" });
  const [msg, setMsg] = useState("");
  useEffect(() => { api("/dictionaries").then((r: any[]) => { const s = r.filter((x) => x.dictionary === "lead_source"); setSrc(s); setF((x) => ({ ...x, sourceCode: s[0]?.code ?? "" })); }).catch(() => {}); }, []);
  const go = async () => {
    setMsg("");
    try { await api("/leads", { method: "POST", body: JSON.stringify({ name: f.name, phone: f.phone || undefined, sourceCode: f.sourceCode }) }); setF({ ...f, name: "", phone: "" }); setMsg(t("saved")); }
    catch (e: any) { setMsg(e.message); }
  };
  return <div className="card"><h3>{t("newLead")}</h3><div className="form" style={{ padding: "8px 0 0" }}>
    <input placeholder={t("name")} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
    <input placeholder={t("phone")} inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
    <select value={f.sourceCode} onChange={(e) => setF({ ...f, sourceCode: e.target.value })}>{src.map((s) => <option key={s.code} value={s.code}>{lang === "uz" ? s.name_uz : s.name_ru}</option>)}</select>
    <button disabled={!f.name || !f.sourceCode} onClick={go}>{t("save")}</button>{msg && <span className="muted">{msg}</span>}</div></div>;
}
