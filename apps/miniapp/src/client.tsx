import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { enqueue, onQueue } from "./queue";
import { Key, Lang } from "./i18n";

type T = (k: Key) => string;
const money = (v: number, cur: string) => `${(v / 100).toLocaleString("ru-RU")} ${cur}`;

function useData<X>(path: string): [X | null, () => void] {
  const [d, setD] = useState<X | null>(null);
  const load = useCallback(() => { api<X>(path).then(setD).catch(() => {}); }, [path]);
  useEffect(() => { load(); return onQueue(load); }, [load]);
  return [d, load];
}

/** Экран клиента: каталог с заказом матрицей «размер × цвет», мои заказы, повтор, оценка и рекламация. */
export function ClientApp({ t, lang }: { t: T; lang: Lang }) {
  const [tab, setTab] = useState<"catalog" | "orders">("catalog");
  return <>
    {tab === "catalog" ? <Catalog t={t} lang={lang} onSent={() => setTab("orders")} /> : <Orders t={t} lang={lang} />}
    <nav className="tabs">{(["catalog", "orders"] as const).map((k) => <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{k === "catalog" ? t("catalog") : t("myOrders")}</button>)}</nav>
  </>;
}

function Catalog({ t, lang, onSent }: { t: T; lang: Lang; onSent: () => void }) {
  const [models] = useData<any[]>("/client/catalog");
  const [cart, setCart] = useState<Record<string, number>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const lines = useMemo(() => (models ?? []).flatMap((m) => m.variants.filter((v: any) => cart[v.id] > 0).map((v: any) => ({ ...v, qty: cart[v.id], price: m.price, currency: m.currency }))), [models, cart]);
  const total = lines.reduce((s, l) => s + l.qty * l.price, 0);
  const pieces = lines.reduce((s, l) => s + l.qty, 0);
  if (!models) return <p className="muted" style={{ padding: 20 }}>…</p>;
  const send = () => {
    enqueue({ path: "/client/orders", method: "POST", body: { items: lines.map((l) => ({ variantId: l.id, qty: l.qty })), note: note || undefined }, label: t("sendOrder") });
    setCart({}); setNote(""); onSent();
  };
  return <>
    {models.map((m) => {
      const colors = [...new Map(m.variants.map((v: any) => [v.color_ru, v])).values()] as any[];
      const sizes = [...new Map(m.variants.map((v: any) => [v.size, v.sort])).entries()].sort((a: any, b: any) => a[1] - b[1]).map((x: any) => x[0]);
      return <div className="card" key={m.id}>
        <div onClick={() => setOpen(open === m.id ? null : m.id)}>
          <h3>{m.name}</h3><div className="muted">{m.code}</div><b>{money(m.price, m.currency)}</b></div>
        {open === m.id && <div style={{ overflowX: "auto", marginTop: 10 }}>
          <table style={{ borderCollapse: "collapse" }}><thead><tr><th />{sizes.map((s) => <th key={s} style={{ padding: 4 }}>{s}</th>)}</tr></thead>
            <tbody>{colors.map((col) => <tr key={col.color_ru}><td style={{ paddingRight: 8, whiteSpace: "nowrap" }}>{lang === "uz" && col.color_uz ? col.color_uz : col.color_ru}</td>
              {sizes.map((s) => { const v = m.variants.find((x: any) => x.color_ru === col.color_ru && x.size === s);
                return <td key={s} style={{ padding: 2 }}>{v ? <input style={{ width: 54, padding: 8, textAlign: "center" }} inputMode="numeric" value={cart[v.id] ?? ""} placeholder={v.available > 0 ? String(v.available) : "—"}
                  onChange={(e) => setCart({ ...cart, [v.id]: Number(e.target.value.replace(/\D/g, "")) || 0 })} /> : null}</td>; })}</tr>)}</tbody></table>
          <div className="muted" style={{ marginTop: 6 }}>{t("available")} / {t("noStock")}</div></div>}
      </div>;
    })}
    {pieces > 0 && <div className="card"><h3>{t("cart")}: {pieces} {t("items")}</h3>
      <div className="muted">{lines.map((l) => `${l.sku}×${l.qty}`).join(", ")}</div>
      <p><b>{t("total")}: {money(total, lines[0].currency)}</b></p>
      <input placeholder={t("notePh")} value={note} onChange={(e) => setNote(e.target.value)} />
      <button style={{ width: "100%", marginTop: 10 }} onClick={send}>{t("sendOrder")}</button></div>}
  </>;
}

function Orders({ t, lang }: { t: T; lang: Lang }) {
  const [rows] = useData<any[]>("/client/orders");
  const [open, setOpen] = useState<string | null>(null);
  if (!rows) return <p className="muted" style={{ padding: 20 }}>…</p>;
  if (!rows.length) return <p className="muted" style={{ padding: 20 }}>{t("empty")}</p>;
  return <>{rows.map((o) => {
    const st = o.source === "client" && o.status === "draft" ? "st_draft" : (`st_${o.status}` as Key);
    return <div className="card" key={o.id}>
      <div onClick={() => setOpen(open === o.id ? null : o.id)}>
        <h3>{o.number} · {t(st)}</h3>
        <div className="muted">{String(o.created_at).slice(0, 10)}{o.due_date ? ` · ${t("deadline")} ${o.due_date}` : ""}</div>
        <b>{money(o.total - (o.discount ?? 0), o.currency)}</b></div>
      {open === o.id && <Detail id={o.id} t={t} lang={lang} />}
    </div>;
  })}</>;
}

function Detail({ id, t, lang }: { id: string; t: T; lang: Lang }) {
  const [o] = useData<any>(`/client/orders/${id}`);
  const [reasons] = useData<any[]>("/client/complaint-reasons");
  const [stars, setStars] = useState(0);
  const [cm, setCm] = useState({ reasonCode: "", description: "" });
  const [msg, setMsg] = useState("");
  if (!o) return <p className="muted">…</p>;
  const reasonCode = cm.reasonCode || reasons?.[0]?.code || "";
  return <div style={{ marginTop: 10 }}>
    {o.items.map((i: any) => <div key={i.variant_id} className="row" style={{ justifyContent: "space-between" }}>
      <span>{i.model_code} · {i.size} · {lang === "uz" && i.color_uz ? i.color_uz : i.color_ru}</span><b>{i.qty}{i.shipped ? ` (${i.shipped})` : ""}</b></div>)}
    {o.shipments.length > 0 && <p className="muted">{t("shipments")}: {o.shipments.map((s: any) => s.number).join(", ")}</p>}
    <div className="row" style={{ marginTop: 8 }}>
      <button className="ghost" onClick={() => { enqueue({ path: `/client/orders/${id}/repeat`, method: "POST", body: {}, label: t("repeat") }); setMsg(t("sent2")); }}>{t("repeat")}</button>
      {o.source === "client" && o.status === "draft" && <button className="ghost" onClick={() => api(`/client/orders/${id}/cancel`, { method: "POST", body: "{}" }).then(() => setMsg(t("st_cancelled"))).catch((e) => setMsg(e.message))}>{t("cancelOrder")}</button>}
    </div>
    {o.canRate && <div style={{ marginTop: 10 }}><div className="muted">{t("rate")}</div>
      <div style={{ fontSize: 34 }}>{[1, 2, 3, 4, 5].map((n) => <span key={n} style={{ color: n <= stars ? "#f5b301" : "#999" }} onClick={() => setStars(n)}>★</span>)}</div>
      <button disabled={!stars} onClick={() => { enqueue({ path: `/client/orders/${id}/rate`, method: "POST", body: { rating: stars }, label: t("rate") }); setMsg(t("thanks")); }}>{t("send")}</button></div>}
    {o.rated && <p className="muted">{t("rate")}: {"★".repeat(o.rated)}</p>}
    {o.complaints.map((k: any) => <p key={k.number} className="muted">{t("complaint")} {k.number}: {k.status}</p>)}
    {o.shipments.length > 0 && <details style={{ marginTop: 10 }}><summary>{t("complaint")}</summary><div className="form" style={{ padding: "8px 0" }}>
      <select value={reasonCode} onChange={(e) => setCm({ ...cm, reasonCode: e.target.value })}>{reasons?.map((r) => <option key={r.code} value={r.code}>{lang === "uz" ? r.name_uz : r.name_ru}</option>)}</select>
      <input placeholder={t("describe")} value={cm.description} onChange={(e) => setCm({ ...cm, description: e.target.value })} />
      <button disabled={cm.description.length < 3 || !reasonCode} onClick={() => { enqueue({ path: "/client/complaints", method: "POST", body: { orderId: id, reasonCode, description: cm.description }, label: t("complaint") }); setCm({ reasonCode: "", description: "" }); setMsg(t("thanks")); }}>{t("send")}</button></div></details>}
    {msg && <p className="muted">{msg}</p>}
  </div>;
}
