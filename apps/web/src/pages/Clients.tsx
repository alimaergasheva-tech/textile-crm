import { FormEvent, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { localeOf } from "../i18n";
import { PortalAccounts } from "./PortalAccounts";
import { useMe, useUi } from "../state";
import { formatMoney, toMinor } from "../i18n";

interface C { id: string; name: string; type: string; segment: string | null; credit_limit: number; credit_currency: "UZS" | "USD"; deals_count: number }

export function ClientsPage() {
  const { t, lang } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const q = sp.get("q") ?? "";
  const [page, setPage] = useState(1);
  const [f, setF] = useState({ name: "", type: "wholesale", creditLimit: "" });
  const list = useQuery({ queryKey: ["clients", q, page], queryFn: () => api<{ items: C[]; total: number }>(`/clients?q=${encodeURIComponent(q)}&page=${page}&limit=20`) });
  const add = useMutation({
    mutationFn: () => api("/clients", { method: "POST", body: JSON.stringify({ name: f.name, type: f.type, creditLimit: f.creditLimit ? toMinor(f.creditLimit) : 0 }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["clients"] }); setF({ name: "", type: "wholesale", creditLimit: "" }); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); add.mutate(); };
  return (
    <div>
      <h1>{t("clients")}</h1>
      <input placeholder={t("search2")} value={q} onChange={(e) => { setSp(e.target.value ? { q: e.target.value } : {}); setPage(1); }} />
      <table>
        <thead><tr><th>{t("name")}</th><th>{t("type")}</th><th>{t("creditLimit")}</th><th>{t("deals_count")}</th></tr></thead>
        <tbody>{list.data?.items.map((c) => (
          <tr key={c.id}>
            <td><Link to={`/clients/${c.id}`}>{c.name}</Link></td><td>{c.type}</td>
            <td>{formatMoney(c.credit_limit, c.credit_currency, lang)}</td><td>{c.deals_count}</td>
          </tr>))}</tbody>
      </table>
      {list.data && !list.data.items.length && <p className="muted">{t("noData")}</p>}
      <div className="pager">
        <button disabled={page <= 1} onClick={() => setPage(page - 1)}>{t("previous")}</button><span>{page}</span>
        <button disabled={(list.data?.total ?? 0) <= page * 20} onClick={() => setPage(page + 1)}>{t("next")}</button>
      </div>
      {can("clients.create") && (
        <form className="inline" onSubmit={submit}>
          <h2>{t("newClient")}</h2>
          <input required placeholder={t("name")} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
            {["wholesale", "corporate", "retail", "distributor"].map((x) => <option key={x}>{x}</option>)}
          </select>
          <input type="number" min="0" placeholder={t("creditLimit")} value={f.creditLimit} onChange={(e) => setF({ ...f, creditLimit: e.target.value })} />
          <button type="submit">{t("add")}</button>
          {add.isError && <span className="err">{t("error")}: {(add.error as Error).message}</span>}
        </form>
      )}
    </div>
  );
}

interface Card {
  client: { id: string; name: string; type: string; price_type: string; tax_id: string | null; address: string | null; credit_limit: number; credit_currency: "UZS" | "USD" };
  contacts: { id: string; name: string; position: string | null; phone: string | null; email: string | null; is_primary: boolean }[];
  deals: { id: string; title: string; amount: number; currency: "UZS" | "USD"; stage: string; kind: string }[];
  timeline: { id: number; type: string; text: string | null; created_at: string; author: string | null }[];
}

export function ClientCard() {
  const { id } = useParams();
  const { t, lang } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const card = useQuery({ queryKey: ["client", id], queryFn: () => api<Card>(`/clients/${id}`) });
  const tasks = useQuery({ queryKey: ["tasks", "client", id], queryFn: () => api<{ id: string; title: string; due_at: string | null; done_at: string | null }[]>(`/tasks?entity=client&entityId=${id}`), enabled: can("tasks.view") });
  const [ct, setCt] = useState({ name: "", phone: "", position: "" });
  const [ix, setIx] = useState({ type: "note", text: "" });
  const [task, setTask] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["client", id] });
  const addContact = useMutation({
    mutationFn: () => api(`/clients/${id}/contacts`, { method: "POST", body: JSON.stringify({ name: ct.name, phone: ct.phone || undefined, position: ct.position || undefined, isPrimary: !card.data?.contacts.length }) }),
    onSuccess: () => { refresh(); setCt({ name: "", phone: "", position: "" }); },
  });
  const addIx = useMutation({
    mutationFn: () => api(`/clients/${id}/interactions`, { method: "POST", body: JSON.stringify(ix) }),
    onSuccess: () => { refresh(); setIx({ ...ix, text: "" }); },
  });
  const addTask = useMutation({
    mutationFn: () => api("/tasks", { method: "POST", body: JSON.stringify({ title: task, entity: "client", entityId: id }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["tasks", "client", id] }); setTask(""); },
  });
  const doneTask = useMutation({
    mutationFn: (p: { id: string; done: boolean }) => api(`/tasks/${p.id}`, { method: "PATCH", body: JSON.stringify({ done: p.done }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks", "client", id] }),
  });
  if (card.isLoading) return <p>{t("loading")}</p>;
  if (!card.data) return <p>{t("error")}</p>;
  const { client, contacts, deals, timeline } = card.data;
  const fmt = (s: string) => new Date(s).toLocaleString(localeOf(lang));

  return (
    <div>
      <p><Link to="/clients">← {t("clients")}</Link></p>
      <h1>{client.name}</h1>
      <p className="muted">{client.type} · {client.price_type} · {t("creditLimit")}: {formatMoney(client.credit_limit, client.credit_currency, lang)}
        {client.tax_id ? ` · ${client.tax_id}` : ""}{client.address ? ` · ${client.address}` : ""}</p>
      <div className="row2">
        <section>
          <h2>{t("contacts")}</h2>
          <table><tbody>{contacts.map((c) => <tr key={c.id}><td>{c.name}{c.is_primary ? " ★" : ""}</td><td>{c.position}</td><td>{c.phone}</td></tr>)}</tbody></table>
          {can("clients.edit") && (
            <form className="inline" onSubmit={(e) => { e.preventDefault(); addContact.mutate(); }}>
              <input required placeholder={t("name")} value={ct.name} onChange={(e) => setCt({ ...ct, name: e.target.value })} />
              <input placeholder={t("position")} value={ct.position} onChange={(e) => setCt({ ...ct, position: e.target.value })} />
              <input placeholder={t("phone")} value={ct.phone} onChange={(e) => setCt({ ...ct, phone: e.target.value })} />
              <button type="submit">{t("add")}</button>
            </form>)}
          <h2>{t("deals")}</h2>
          <table><tbody>{deals.map((d) => (
            <tr key={d.id}><td>{d.title}</td><td>{formatMoney(d.amount, d.currency, lang)}</td><td><span className="tag">{d.stage}</span></td></tr>))}</tbody></table>
          {can("tasks.view") && (<>
            <h2>{t("tasks")}</h2>
            <table><tbody>{tasks.data?.map((x) => (
              <tr key={x.id}><td><input type="checkbox" checked={!!x.done_at} disabled={!can("tasks.edit")} onChange={() => doneTask.mutate({ id: x.id, done: !x.done_at })} /></td>
                <td style={{ textDecoration: x.done_at ? "line-through" : "none" }}>{x.title}</td></tr>))}</tbody></table>
            {can("tasks.create") && (
              <form className="inline" onSubmit={(e) => { e.preventDefault(); addTask.mutate(); }}>
                <input required placeholder={t("newTask")} value={task} onChange={(e) => setTask(e.target.value)} /><button type="submit">{t("add")}</button>
              </form>)}
          </>)}
        </section>
        <section>
          <h2>{t("timeline")}</h2>
          {can("clients.edit") && (
            <form className="inline" onSubmit={(e) => { e.preventDefault(); addIx.mutate(); }}>
              <select value={ix.type} onChange={(e) => setIx({ ...ix, type: e.target.value })}>
                {(["note", "call", "message", "meeting"] as const).map((x) => <option key={x} value={x}>{t(x)}</option>)}
              </select>
              <input required style={{ flex: 1 }} placeholder={t("note")} value={ix.text} onChange={(e) => setIx({ ...ix, text: e.target.value })} />
              <button type="submit">{t("add")}</button>
            </form>)}
          <table><tbody>{timeline.map((i) => (
            <tr key={i.id}><td className="muted">{fmt(i.created_at)}</td><td><span className="tag">{i.type}</span> {i.text}</td><td className="muted">{i.author}</td></tr>))}</tbody></table>
        </section>
      </div>
      {can("clients.edit") && id && <PortalAccounts clientId={id} />}
    </div>
  );
}
