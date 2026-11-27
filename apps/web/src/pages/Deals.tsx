import { DragEvent, FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useDicts } from "../crm";
import { useMe, useUi } from "../state";
import { Currency, formatMoney, toMinor } from "../i18n";

interface Stage { id: string; name: string; kind: "open" | "won" | "lost" }
interface Deal { id: string; title: string; stage_id: string; amount: number; currency: Currency; client_id: string; client_name: string; owner_name: string | null }
interface Board { stages: Stage[]; deals: Deal[] }

export function DealsPage() {
  const { t, lang } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const dicts = useDicts();
  const board = useQuery({ queryKey: ["deals"], queryFn: () => api<Board>("/deals") });
  const clients = useQuery({ queryKey: ["clients", "", 1, "all"], queryFn: () => api<{ items: { id: string; name: string }[] }>("/clients?limit=200"), enabled: can("clients.view") });
  const [over, setOver] = useState<string | null>(null);
  const [lost, setLost] = useState<{ dealId: string; stageId: string } | null>(null);
  const [reason, setReason] = useState("");
  const [f, setF] = useState({ title: "", clientId: "", amount: "", currency: "UZS" as Currency });

  const move = useMutation({
    mutationFn: (p: { dealId: string; stageId: string; lostReasonCode?: string }) =>
      api(`/deals/${p.dealId}/stage`, { method: "PATCH", body: JSON.stringify({ stageId: p.stageId, lostReasonCode: p.lostReasonCode }) }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["deals"] }),
  });
  const add = useMutation({
    mutationFn: () => api("/deals", { method: "POST", body: JSON.stringify({ title: f.title, clientId: f.clientId, amount: f.amount ? toMinor(f.amount) : 0, currency: f.currency }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["deals"] }); setF({ ...f, title: "", amount: "" }); },
  });

  const drop = (e: DragEvent, stage: Stage) => {
    e.preventDefault(); setOver(null);
    const dealId = e.dataTransfer.getData("text/plain");
    const d = board.data?.deals.find((x) => x.id === dealId);
    if (!d || d.stage_id === stage.id || !can("deals.edit")) return;
    if (stage.kind === "lost") { setLost({ dealId, stageId: stage.id }); setReason(""); }
    else move.mutate({ dealId, stageId: stage.id });
  };
  const sums = (id: string) => {
    const by: Partial<Record<Currency, number>> = {};
    board.data?.deals.filter((d) => d.stage_id === id).forEach((d) => { by[d.currency] = (by[d.currency] ?? 0) + d.amount; });
    return (Object.entries(by) as [Currency, number][]).map(([c, a]) => formatMoney(a, c, lang)).join(" · ") || "—";
  };
  const submit = (e: FormEvent) => { e.preventDefault(); add.mutate(); };

  return (
    <div>
      <h1>{t("deals")}</h1>
      {board.isLoading && <p>{t("loading")}</p>}
      <div className="board">
        {board.data?.stages.map((s) => (
          <div key={s.id} className={`col${over === s.id ? " over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setOver(s.id); }} onDragLeave={() => setOver(null)} onDrop={(e) => drop(e, s)}>
            <h3>{s.name}</h3>
            <div className="sum">{sums(s.id)}</div>
            {board.data!.deals.filter((d) => d.stage_id === s.id).map((d) => (
              <div key={d.id} className="deal" draggable={can("deals.edit")} onDragStart={(e) => e.dataTransfer.setData("text/plain", d.id)}>
                <Link to={`/clients/${d.client_id}`}>{d.title}</Link>
                <div className="muted">{d.client_name}</div>
                <div>{formatMoney(d.amount, d.currency, lang)}</div>
                {d.owner_name && <div className="muted">{d.owner_name}</div>}
              </div>))}
          </div>))}
      </div>
      {move.isError && <p className="err">{t("error")}</p>}
      {can("deals.create") && (
        <form className="inline" onSubmit={submit}>
          <h2>{t("newDeal")}</h2>
          <input required placeholder={t("title")} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          <select required value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })}>
            <option value="">{t("client")}…</option>{clients.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input type="number" min="0" placeholder={t("amount")} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          <select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value as Currency })}><option>UZS</option><option>USD</option></select>
          <button type="submit">{t("add")}</button>
          {add.isError && <span className="err">{t("error")}</span>}
        </form>
      )}
      {lost && (
        <div className="modal">
          <div className="card">
            <h2>{t("lostReason")}</h2>
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">…</option>{dicts.list("loss_reason").map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
            </select>
            <button disabled={!reason} onClick={() => { move.mutate({ ...lost, lostReasonCode: reason }); setLost(null); }}>{t("save")}</button>
            <button onClick={() => setLost(null)}>{t("cancel")}</button>
          </div>
        </div>
      )}
    </div>
  );
}
