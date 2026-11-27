import { PhotoStrip } from "./PhotoStrip";
import { FormEvent, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useMe, useUi } from "../state";

const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export function FeedbackPage() {
  const { t } = useUi();
  const { can } = useMe();
  const [tab, setTab] = useState<"ratings" | "complaints" | "suggestions" | "stats">("stats");
  return (
    <div>
      <h1>{t("feedback")}</h1>
      <p>{(["stats", "ratings", "complaints", "suggestions"] as const).map((k) => <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)} style={{ marginRight: 6 }}>{t(k)}</button>)}</p>
      {tab === "stats" && <Stats />}
      {tab === "ratings" && <Ratings />}
      {tab === "complaints" && <Complaints canManage={can("feedback.manage")} canCreate={can("feedback.create")} />}
      {tab === "suggestions" && <Suggestions canManage={can("feedback.manage")} />}
    </div>
  );
}

function Stats() {
  const { t } = useUi();
  const s = useQuery({ queryKey: ["fb-stats"], queryFn: () => api<any>("/feedback/stats") });
  if (!s.data) return <p>{t("loading")}</p>;
  const d = s.data;
  const tile = (label: string, v: string | number) => <div className="card" style={{ display: "inline-block", margin: 6, minWidth: 170 }}><div className="muted">{label}</div><b style={{ fontSize: 26 }}>{v}</b></div>;
  return <div>
    {tile(t("avgRating"), `${d.avgRating} (${d.rated})`)}{tile(t("waiting"), d.waiting)}{tile(t("complaints"), d.complaints)}
    {tile(t("open"), `${d.openComplaints}${d.overdueComplaints ? ` · ${t("overdue")}: ${d.overdueComplaints}` : ""}`)}
    {tile(t("complaintShare"), d.complaintShare)}{tile(t("resolveHours"), d.avgResolveHours)}
    {!!d.topReasons.length && <p>{t("topReasons")}: {d.topReasons.map((r: any) => `${r.reason_code} (${r.n})`).join(", ")}</p>}
  </div>;
}

function Ratings() {
  const { t } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["fb"], queryFn: () => api<any[]>("/feedback") });
  const [v, setV] = useState<Record<string, string>>({});
  const rec = useMutation({ mutationFn: (id: string) => api("/feedback", { method: "POST", body: JSON.stringify({ feedbackId: id, rating: Number(v[id]) }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["fb"] }); qc.invalidateQueries({ queryKey: ["fb-stats"] }); } });
  const link = (tok: string) => `${location.origin}/rate/${tok}`;
  return (
    <table>
      <thead><tr><th>{t("order")}</th><th>{t("client")}</th><th>{t("status")}</th><th>{t("rating")}</th><th>{t("copyLink")}</th></tr></thead>
      <tbody>{list.data?.map((f) => <tr key={f.id}><td>{f.order_number}</td><td>{f.client}</td><td>{f.status}</td>
        <td>{f.rating ? `${"★".repeat(f.rating)} ${f.comment ?? ""}` : can("feedback.create") && f.status !== "scheduled" && <>
          <select value={v[f.id] ?? ""} onChange={(e) => setV({ ...v, [f.id]: e.target.value })}><option value="">—</option>{[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}</select> <button disabled={!v[f.id]} onClick={() => rec.mutate(f.id)}>OK</button></>}</td>
        <td>{f.status !== "answered" && <a href="#" onClick={(e) => { e.preventDefault(); void navigator.clipboard?.writeText(link(f.token)); prompt(t("copyLink"), link(f.token)); }}>{t("copyLink")}</a>}</td></tr>)}</tbody>
    </table>
  );
}

function Complaints({ canManage, canCreate }: { canManage: boolean; canCreate: boolean }) {
  const { can } = useMe();
  const { t } = useUi();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["complaints"], queryFn: () => api<any[]>("/complaints") });
  const orders = useQuery({ queryKey: ["orders"], queryFn: () => api<any[]>("/orders"), enabled: canCreate });
  const reasons = useQuery({ queryKey: ["reasons"], queryFn: () => api<any[]>("/reference-values?dictionary=complaint_reason"), enabled: canCreate });
  const [f, setF] = useState({ orderId: "", reasonCode: "", description: "", qty: "" });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["complaints"] }); qc.invalidateQueries({ queryKey: ["fb-stats"] }); };
  const add = useMutation({ mutationFn: () => api("/complaints", { method: "POST", body: JSON.stringify({ orderId: f.orderId, reasonCode: f.reasonCode, description: f.description || undefined, qty: Number(f.qty) || undefined }) }),
    onSuccess: () => { setF({ orderId: "", reasonCode: "", description: "", qty: "" }); refresh(); } });
  const act = useMutation({ mutationFn: (p: { path: string; method?: string; body: unknown }) => api(p.path, { method: p.method ?? "POST", body: JSON.stringify(p.body) }), onSuccess: refresh });
  const submit = (e: FormEvent) => { e.preventDefault(); add.mutate(); };
  return (
    <div>
      <table>
        <thead><tr><th>№</th><th>{t("order")}</th><th>{t("client")}</th><th>{t("reason")}</th><th>{t("status")}</th><th>{t("deadline")}</th><th>{t("action")}</th></tr></thead>
        <tbody>{list.data?.map((k) => <tr key={k.id}><td>{k.number}</td><td>{k.order_number}</td><td>{k.client}</td><td>{k.reason_code}<br /><span className="muted">{k.description}</span><br /><PhotoStrip entity="complaint" entityId={k.id} canAdd={can("files.create")} /></td>
          <td>{k.status}{k.resolution_type ? ` (${k.resolution_type})` : ""}{k.escalated_at && <span className="err"> {t("escalated")}</span>}</td>
          <td className={k.overdue ? "err" : ""}>{k.due_at?.slice(0, 16).replace("T", " ")}</td>
          <td>{canManage && k.status === "new" && <button onClick={() => act.mutate({ path: `/complaints/${k.id}/status`, method: "PATCH", body: { status: "in_progress" } })}>{t("inWork")}</button>}
            {canManage && ["new", "in_progress"].includes(k.status) && <> {(["replace", "refund", "discount"] as const).map((x) => <button key={x} onClick={() => {
              const amt = x === "discount" ? Number(prompt(t("amount2"))) : undefined;
              if (x === "discount" && !amt) return;
              act.mutate({ path: `/complaints/${k.id}/resolve`, body: { type: x, amount: amt ? Math.round(amt * 100) : undefined } });
            }}>{t(x)}</button>)}</>}
            {canManage && k.status === "resolved" && <button onClick={() => act.mutate({ path: `/complaints/${k.id}/status`, method: "PATCH", body: { status: "closed" } })}>{t("closeComplaint")}</button>}</td></tr>)}</tbody>
      </table>
      {act.isError && <p className="err">{(act.error as Error).message}</p>}
      {canCreate && <form className="inline" onSubmit={submit}>
        <h2>{t("newComplaint")}</h2>
        <select required value={f.orderId} onChange={(e) => setF({ ...f, orderId: e.target.value })}><option value="">{t("order")}</option>{orders.data?.map((o) => <option key={o.id} value={o.id}>{o.number} · {o.client}</option>)}</select>
        <select required value={f.reasonCode} onChange={(e) => setF({ ...f, reasonCode: e.target.value })}><option value="">{t("reason")}</option>{reasons.data?.map((r: any) => <option key={r.code} value={r.code}>{r.name_ru}</option>)}</select>
        <input placeholder={t("comment")} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        <input type="number" min="1" placeholder={t("qty")} value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} />
        <button type="submit">{t("add")}</button>{add.isError && <span className="err"> {(add.error as Error).message}</span>}
      </form>}
    </div>
  );
}

function Suggestions({ canManage }: { canManage: boolean }) {
  const { t } = useUi();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["sugg"], queryFn: () => api<any[]>("/suggestions"), enabled: canManage });
  const [f, setF] = useState({ text: "", kind: "suggestion", anonymous: false });
  const [sent, setSent] = useState(false);
  const add = useMutation({ mutationFn: () => api("/suggestions", { method: "POST", body: JSON.stringify(f) }), onSuccess: () => { setF({ ...f, text: "" }); setSent(true); qc.invalidateQueries({ queryKey: ["sugg"] }); } });
  const st = useMutation({ mutationFn: (p: { id: string; status: string }) => api(`/suggestions/${p.id}`, { method: "PATCH", body: JSON.stringify({ status: p.status }) }), onSuccess: () => qc.invalidateQueries({ queryKey: ["sugg"] }) });
  return (
    <div>
      <form className="inline" onSubmit={(e) => { e.preventDefault(); setSent(false); add.mutate(); }}>
        <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="suggestion">{t("suggestion")}</option><option value="problem">{t("problem")}</option></select>
        <input required style={{ minWidth: 320 }} placeholder={t("comment")} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} />
        <label><input type="checkbox" checked={f.anonymous} onChange={(e) => setF({ ...f, anonymous: e.target.checked })} /> {t("anonymous")}</label>
        <button type="submit">{t("send")}</button>{sent && <span> {t("done")}</span>}
      </form>
      {canManage && <table>
        <thead><tr><th>{t("date")}</th><th>{t("type")}</th><th>{t("comment")}</th><th>{t("users")}</th><th>{t("status")}</th></tr></thead>
        <tbody>{list.data?.map((s) => <tr key={s.id}><td>{s.created_at.slice(0, 10)}</td><td>{s.kind}</td><td>{s.text}</td><td>{s.author ?? t("anonymous")}</td>
          <td>{s.status} {s.status === "new" && <button onClick={() => st.mutate({ id: s.id, status: "seen" })}>✓</button>} {s.status !== "done" && <button onClick={() => st.mutate({ id: s.id, status: "done" })}>{t("done")}</button>}</td></tr>)}</tbody>
      </table>}
    </div>
  );
}

/** Публичная страница оценки для клиента: открывается по секретной ссылке, вход не нужен. */
export function RatePage() {
  const { token } = useParams();
  const [info, setInfo] = useState<any>(null);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [state, setState] = useState<"load" | "ready" | "done" | "bad">("load");
  const [started, setStarted] = useState(false);
  if (!started) {
    setStarted(true);
    fetch(`${BASE}/public/feedback/${token}`).then(async (r) => { if (!r.ok) return setState("bad"); const d = await r.json(); setInfo(d); setState(d.answered ? "done" : "ready"); }).catch(() => setState("bad"));
  }
  const send = async () => {
    const r = await fetch(`${BASE}/public/feedback/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rating, comment: comment || undefined }) });
    setState(r.ok ? "done" : "bad");
  };
  return (
    <div className="center" style={{ flexDirection: "column", gap: 14, padding: 24, textAlign: "center" }}>
      {state === "load" && <p>…</p>}
      {state === "bad" && <p className="err">Ссылка недействительна</p>}
      {state === "done" && <h2>Спасибо за оценку!</h2>}
      {state === "ready" && <>
        <h2>{info?.factory}: оцените заказ {info?.orderNumber}</h2>
        <div style={{ fontSize: 40 }}>{[1, 2, 3, 4, 5].map((n) => <span key={n} style={{ cursor: "pointer", color: n <= rating ? "#f5b301" : "#888" }} onClick={() => setRating(n)}>★</span>)}</div>
        <textarea rows={3} style={{ width: "min(420px, 90vw)" }} placeholder="Комментарий" value={comment} onChange={(e) => setComment(e.target.value)} />
        <button disabled={!rating} onClick={send}>Отправить</button></>}
    </div>
  );
}
