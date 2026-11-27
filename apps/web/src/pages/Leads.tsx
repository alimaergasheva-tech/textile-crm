import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useDicts } from "../crm";
import { useMe, useUi } from "../state";

interface L { id: string; name: string; company: string | null; phone: string | null; source_code: string; status: string; client_id: string | null }

export function LeadsPage() {
  const { t } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const nav = useNavigate();
  const dicts = useDicts();
  const leads = useQuery({ queryKey: ["leads"], queryFn: () => api<L[]>("/leads") });
  const [f, setF] = useState({ name: "", company: "", phone: "", sourceCode: "" });
  const add = useMutation({
    mutationFn: () => api("/leads", { method: "POST", body: JSON.stringify({ ...f, company: f.company || undefined, phone: f.phone || undefined }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["leads"] }); setF({ name: "", company: "", phone: "", sourceCode: "" }); },
  });
  const conv = useMutation({
    mutationFn: (id: string) => api<{ clientId: string }>(`/leads/${id}/convert`, { method: "POST", body: JSON.stringify({ createDeal: true }) }),
    onSuccess: (r) => { qc.invalidateQueries(); nav(`/clients/${r.clientId}`); },
  });
  const reject = useMutation({
    mutationFn: (id: string) => api(`/leads/${id}`, { method: "PATCH", body: JSON.stringify({ status: "rejected" }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["leads"] }),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); add.mutate(); };
  return (
    <div>
      <h1>{t("leads")}</h1>
      <table>
        <thead><tr><th>{t("name")}</th><th>{t("company")}</th><th>{t("phone")}</th><th>{t("source")}</th><th>{t("status")}</th><th></th></tr></thead>
        <tbody>{leads.data?.map((l) => (
          <tr key={l.id}>
            <td>{l.name}</td><td>{l.company}</td><td>{l.phone}</td><td>{dicts.name("lead_source", l.source_code)}</td><td><span className="tag">{l.status}</span></td>
            <td>{can("leads.edit") && (l.status === "new" || l.status === "in_work") && (<>
              <button onClick={() => conv.mutate(l.id)}>{t("convert")}</button>{" "}
              <button onClick={() => reject.mutate(l.id)}>✕</button></>)}</td>
          </tr>))}</tbody>
      </table>
      {leads.data && !leads.data.length && <p className="muted">{t("noData")}</p>}
      {can("leads.create") && (
        <form className="inline" onSubmit={submit}>
          <h2>{t("newLead")}</h2>
          <input required placeholder={t("name")} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <input placeholder={t("company")} value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} />
          <input placeholder={t("phone")} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          <select required value={f.sourceCode} onChange={(e) => setF({ ...f, sourceCode: e.target.value })}>
            <option value="">{t("source")}…</option>{dicts.list("lead_source").map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </select>
          <button type="submit">{t("add")}</button>
          {add.isError && <span className="err">{t("error")}</span>}
        </form>
      )}
    </div>
  );
}
