import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { localeOf } from "../i18n";
import { useMe, useUi } from "../state";
import { Currency, formatMoney } from "../i18n";

interface QL { id: string; number: string; status: string; currency: Currency; total: number; client_name: string; created_at: string }

export function QuotesPage() {
  const { t, lang } = useUi();
  const { can } = useMe();
  const list = useQuery({ queryKey: ["quotes"], queryFn: () => api<QL[]>("/quotes") });
  return (
    <div>
      <h1>{t("quotes")}</h1>
      {can("quotes.create") && <p><Link to="/quotes/new"><button>{t("newQuote")}</button></Link></p>}
      <table>
        <thead><tr><th>{t("number")}</th><th>{t("client")}</th><th>{t("status")}</th><th>{t("total")}</th></tr></thead>
        <tbody>{list.data?.map((q) => (
          <tr key={q.id}><td className="mono"><Link to={`/quotes/${q.id}`}>{q.number}</Link></td><td>{q.client_name}</td><td><span className="tag">{q.status}</span></td>
            <td className="num">{formatMoney(q.total, q.currency, lang)}</td></tr>))}</tbody>
      </table>
      {list.data && !list.data.length && <p className="muted">{t("noData")}</p>}
    </div>
  );
}

interface VariantRow { id: string; sku: string; size_id: string; size: string; color_id: string; color: string; is_active: boolean }

export function QuoteNew() {
  const { t } = useUi();
  const nav = useNavigate();
  const qc = useQueryClient();
  const clients = useQuery({ queryKey: ["clients", "", 1, "all"], queryFn: () => api<{ items: { id: string; name: string }[] }>("/clients?limit=200") });
  const models = useQuery({ queryKey: ["models", ""], queryFn: () => api<{ id: string; code: string; name: string }[]>("/models?q=") });
  const [clientId, setClientId] = useState("");
  const [currency, setCurrency] = useState<Currency>("UZS");
  const [discount, setDiscount] = useState("0");
  const [modelId, setModelId] = useState("");
  const [qty, setQty] = useState<Record<string, string>>({});
  const model = useQuery({ queryKey: ["model", modelId], queryFn: () => api<{ variants: VariantRow[] }>(`/models/${modelId}`), enabled: !!modelId });
  const variants = (model.data?.variants ?? []).filter((v) => v.is_active);
  const sizes = [...new Map(variants.map((v) => [v.size_id, v.size])).entries()];
  const colors = [...new Map(variants.map((v) => [v.color_id, v.color])).entries()];
  const lines = Object.entries(qty).filter(([, v]) => Number(v) > 0).map(([variantId, v]) => ({ variantId, qty: Math.floor(Number(v)) }));
  const create = useMutation({
    mutationFn: () => api<{ id: string }>("/quotes", { method: "POST", body: JSON.stringify({ clientId, currency, discountPercent: Number(discount) || 0, lines }) }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["quotes"] }); nav(`/quotes/${r.id}`); },
  });
  return (
    <div>
      <p><Link to="/quotes">← {t("quotes")}</Link></p>
      <h1>{t("newQuote")}</h1>
      <div className="inline">
        <select value={clientId} onChange={(e) => setClientId(e.target.value)}>
          <option value="">{t("client")}…</option>{clients.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}><option>UZS</option><option>USD</option></select>
        <input type="number" min="0" max="100" step="0.5" style={{ width: 110 }} placeholder={t("discount")} value={discount} onChange={(e) => setDiscount(e.target.value)} />
      </div>
      <div className="inline">
        <select value={modelId} onChange={(e) => setModelId(e.target.value)}>
          <option value="">{t("pickModel")}…</option>{models.data?.map((m) => <option key={m.id} value={m.id}>{m.code} · {m.name}</option>)}
        </select>
      </div>
      {modelId && (
        <table className="matrix">
          <thead><tr><th>{t("color")}</th>{sizes.map(([id, label]) => <th key={id}>{label}</th>)}</tr></thead>
          <tbody>{colors.map(([cid, cname]) => (
            <tr key={cid}><td>{cname}</td>{sizes.map(([sid]) => {
              const v = variants.find((x) => x.color_id === cid && x.size_id === sid);
              return <td key={sid}>{v ? <input type="number" min="0" value={qty[v.id] ?? ""} onChange={(e) => setQty({ ...qty, [v.id]: e.target.value })} /> : "—"}</td>;
            })}</tr>))}</tbody>
        </table>
      )}
      <p className="muted">{t("qty")}: {lines.reduce((s, l) => s + l.qty, 0)}</p>
      <button disabled={!clientId || !lines.length} onClick={() => create.mutate()}>{t("save")}</button>
      {create.isError && <p className="err">{t("error")}: {String((create.error as Error).message)}</p>}
    </div>
  );
}

interface QV {
  quote: { id: string; number: string; status: string; currency: Currency; discount_percent: number; total: number; valid_until: string | null; created_at: string; client_name: string; address: string | null; tax_id: string | null; owner_name: string | null };
  lines: { qty: number; unit_price: number; sku: string; size: string; color: string; model: string; model_code: string }[];
}

export function QuoteView() {
  const { id } = useParams();
  const { t, lang } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["quote", id], queryFn: () => api<QV>(`/quotes/${id}`) });
  const setStatus = useMutation({
    mutationFn: (status: string) => api(`/quotes/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["quote", id] }),
  });
  if (!q.data) return <p>{t("loading")}</p>;
  const { quote, lines } = q.data;
  const cur = quote.currency;
  const subtotal = lines.reduce((s, l) => s + l.qty * l.unit_price, 0);
  return (
    <div>
      <p className="no-print"><Link to="/quotes">← {t("quotes")}</Link></p>
      <h1>{t("quotes")} {quote.number}</h1>
      <p>{quote.client_name}{quote.tax_id ? ` · ${quote.tax_id}` : ""}{quote.address ? ` · ${quote.address}` : ""}</p>
      <p className="muted">{new Date(quote.created_at).toLocaleDateString(localeOf(lang))}
        {quote.valid_until ? ` · ${t("validUntil")}: ${quote.valid_until}` : ""}{quote.owner_name ? ` · ${quote.owner_name}` : ""}</p>
      <table>
        <thead><tr><th>{t("sku")}</th><th>{t("models")}</th><th>{t("color")}</th><th>{t("size")}</th><th>{t("qty")}</th><th>{t("price")}</th><th>{t("amount")}</th></tr></thead>
        <tbody>{lines.map((l) => (
          <tr key={l.sku}><td className="mono">{l.sku}</td><td>{l.model}</td><td>{l.color}</td><td>{l.size}</td><td className="num">{l.qty}</td>
            <td className="num">{formatMoney(l.unit_price, cur, lang)}</td><td className="num">{formatMoney(l.qty * l.unit_price, cur, lang)}</td></tr>))}</tbody>
      </table>
      <p className="num">{quote.discount_percent > 0 && <>{formatMoney(subtotal, cur, lang)} − {quote.discount_percent}%<br /></>}<strong>{t("total")}: {formatMoney(quote.total, cur, lang)}</strong></p>
      <div className="inline no-print">
        <button onClick={() => window.print()}>{t("print")}</button>
        <span className="tag">{quote.status}</span>
        {can("quotes.edit") && ["sent", "accepted", "rejected"].map((s) => <button key={s} onClick={() => setStatus.mutate(s)}>{s}</button>)}
      </div>
    </div>
  );
}
