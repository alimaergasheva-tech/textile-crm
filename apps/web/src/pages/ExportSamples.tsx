import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useMe, useUi } from "../state";

type Decision = "approved" | "approved_comments" | "rejected";
interface Sample { id: string; model_id: string; model: string; kind: "1fit" | "pp"; round: number; status: string; planned_send: string | null; made_at: string | null; sent_at: string | null;
  delivered_at: string | null; decided_at: string | null; courier: string | null; awb: string | null; client_comment: string | null; version: number }
interface Draft { plannedSend?: string; madeAt?: string; sentAt?: string; deliveredAt?: string; decision?: Decision | ""; courier?: string; awb?: string; clientComment?: string }
const COLORS: Record<string, string> = { planned: "#8aa4c8", made: "#8aa4c8", sent: "#e0a030", delivered: "#e0a030", approved: "#3a9d5d", approved_comments: "#b8a030", rejected: "#c0392b" };

/** Образцы 1-fit и PP по моделям: сшит → отправлен (курьер, AWB) → доставлен → решение клиента. PP — только после подтверждённого 1-fit. */
export function ExportSamples({ orderId }: { orderId: string }) {
  const { t } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const manage = can("exportsamples.manage");
  const q = useQuery({ queryKey: ["export-samples", orderId], queryFn: () => api<Sample[]>(`/export-orders/${orderId}/samples`) });
  const [draft, setDraft] = useState<Record<string, Draft>>({});
  const refresh = () => { qc.invalidateQueries({ queryKey: ["export-samples", orderId] }); setDraft({}); };
  const gen = useMutation({ mutationFn: () => api(`/export-orders/${orderId}/samples/generate`, { method: "POST", body: JSON.stringify({}) }), onSuccess: refresh });
  const round = useMutation({ mutationFn: (s: Sample) => api(`/export-orders/${orderId}/samples/round`, { method: "POST", body: JSON.stringify({ modelId: s.model_id, kind: s.kind }) }), onSuccess: refresh });
  const save = useMutation({
    mutationFn: (s: Sample) => {
      const d = draft[s.id] ?? {};
      const body: Record<string, unknown> = { version: s.version };
      for (const k of ["plannedSend", "madeAt", "sentAt", "deliveredAt", "courier", "awb", "clientComment"] as const) if (d[k] !== undefined) body[k] = d[k] || null;
      if (d.decision !== undefined) body.decision = d.decision || null;
      return api(`/export-samples/${s.id}`, { method: "PATCH", body: JSON.stringify(body) });
    },
    onSuccess: refresh,
  });
  const rows = q.data ?? [];
  const set = (id: string, k: keyof Draft, v: string) => setDraft({ ...draft, [id]: { ...draft[id], [k]: v } });
  const val = (s: Sample, k: keyof Draft, orig: string | null) => (draft[s.id]?.[k] as string | undefined) ?? orig?.slice(0, 10) ?? "";
  const latest = (s: Sample) => !rows.some((r) => r.model_id === s.model_id && r.kind === s.kind && r.round > s.round);
  return (
    <div>
      <h2>{t("smTitle")}</h2>
      {manage && <div className="toolbar"><button disabled={gen.isPending} onClick={() => gen.mutate()}>{t("smGenerate")}</button></div>}
      {!rows.length && <p className="muted">{t("smNone")}</p>}
      {rows.length > 0 && (
        <table>
          <thead><tr><th>{t("model")}</th><th>{t("smKind")}</th><th>{t("smPlanned")}</th><th>{t("smMade")}</th><th>{t("smSent")}</th><th>{t("smCourier")} / AWB</th><th>{t("smDelivered")}</th><th>{t("smDecision")}</th><th>{t("smComment")}</th><th /></tr></thead>
          <tbody>
            {rows.map((s) => {
              const dec = (draft[s.id]?.decision ?? (["approved", "approved_comments", "rejected"].includes(s.status) ? s.status : "")) as string;
              const dirty = !!draft[s.id];
              return (
                <tr key={s.id}>
                  <td>{s.model}</td>
                  <td>{s.kind === "1fit" ? "1-fit" : "PP"}{s.round > 1 ? ` #${s.round}` : ""}<div style={{ color: COLORS[s.status] }}>● {t(`smSt_${s.status}` as never)}</div></td>
                  {([["plannedSend", s.planned_send], ["madeAt", s.made_at], ["sentAt", s.sent_at]] as const).map(([k, o]) => (
                    <td key={k}><input type="date" disabled={!manage} value={val(s, k, o)} onChange={(e) => set(s.id, k, e.target.value)} /></td>))}
                  <td>
                    <input disabled={!manage} placeholder={t("smCourier")} style={{ width: 90 }} value={draft[s.id]?.courier ?? s.courier ?? ""} onChange={(e) => set(s.id, "courier", e.target.value)} />
                    <input disabled={!manage} placeholder="AWB" style={{ width: 120 }} value={draft[s.id]?.awb ?? s.awb ?? ""} onChange={(e) => set(s.id, "awb", e.target.value)} />
                  </td>
                  <td><input type="date" disabled={!manage} value={val(s, "deliveredAt", s.delivered_at)} onChange={(e) => set(s.id, "deliveredAt", e.target.value)} /></td>
                  <td>
                    <select disabled={!manage} value={dec} onChange={(e) => set(s.id, "decision", e.target.value)}>
                      <option value="">—</option>
                      <option value="approved">{t("smSt_approved")}</option>
                      <option value="approved_comments">{t("smSt_approved_comments")}</option>
                      <option value="rejected">{t("smSt_rejected")}</option>
                    </select>
                  </td>
                  <td><input disabled={!manage} style={{ width: 160 }} value={draft[s.id]?.clientComment ?? s.client_comment ?? ""} onChange={(e) => set(s.id, "clientComment", e.target.value)} /></td>
                  <td>
                    {manage && dirty && <button disabled={save.isPending} onClick={() => save.mutate(s)}>{t("save")}</button>}
                    {manage && latest(s) && (s.status === "rejected" || s.status === "approved_comments") && <button className="secondary" onClick={() => round.mutate(s)}>{t("smNewRound")}</button>}
                  </td>
                </tr>);
            })}
          </tbody>
        </table>)}
      {(save.isError || round.isError || gen.isError) && <div className="err">{((save.error || round.error || gen.error) as Error)?.message || t("error")}</div>}
    </div>
  );
}
