import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useMe, useUi } from "../state";

interface Task { id: string; seq: number; stage: string; name: string; department_code: string | null; party: string | null; duration_days: number; planned_start: string; planned_end: string;
  baseline_end: string | null; actual_start: string | null; actual_end: string | null; status: "todo" | "in_progress" | "blocked" | "done"; version: number; lateDays: number; shiftDays: number }
interface Plan { planStart: string | null; target: string | null; exFactory: string | null; baselineExFactory: string | null; deltaDays: number | null; lateCount: number; today: string; tasks: Task[] }
const DAY = 86400_000;
const ms = (s: string) => +new Date(s.slice(0, 10) + "T00:00:00Z");
const COLORS: Record<Task["status"], string> = { todo: "#8aa4c8", in_progress: "#e0a030", blocked: "#c0392b", done: "#3a9d5d" };

/** План-график заказа: диаграмма Ганта, отметки выполнения этапов, отклонение от цели клиента. */
export function ExportPlan({ orderId }: { orderId: string }) {
  const { t } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const manage = can("exportplan.manage"), update = can("exportplan.update");
  const q = useQuery({ queryKey: ["export-plan", orderId], queryFn: () => api<Plan>(`/export-orders/${orderId}/plan`), refetchInterval: 30_000 });
  const [start, setStart] = useState(""); const [perDay, setPerDay] = useState(1500);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["export-plan", orderId] }); qc.invalidateQueries({ queryKey: ["export-order", orderId] }); };
  const gen = useMutation({
    mutationFn: (force: boolean) => api(`/export-orders/${orderId}/plan/generate`, { method: "POST", body: JSON.stringify({ startDate: start || undefined, sewingSetsPerDay: perDay, force }) }),
    onSuccess: refresh,
  });
  const mark = useMutation({
    mutationFn: (v: { id: string; version: number; status: Task["status"] }) => api(`/export-plan-tasks/${v.id}`, { method: "PATCH", body: JSON.stringify({ status: v.status, version: v.version }) }),
    onSettled: refresh,
  });
  const p = q.data;
  const has = !!p?.tasks.length;
  const regen = () => { if (!has || window.confirm(t("planConfirmRegen"))) gen.mutate(has); };
  const stName = (s: Task["status"]) => t(`planSt_${s}` as never);

  let chart = null;
  if (p && has) {
    const t0 = Math.min(...p.tasks.map((x) => ms(x.planned_start))), t1 = Math.max(...p.tasks.map((x) => ms(x.planned_end)), p.target ? ms(p.target) : 0) + DAY;
    const span = t1 - t0, pct = (v: number) => `${((v - t0) / span) * 100}%`;
    const months: number[] = [];
    for (let d = new Date(t0); +d < t1; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) months.push(+d);
    chart = (
      <div style={{ position: "relative", margin: "8px 0 16px", overflowX: "auto" }}>
        <div style={{ position: "relative", minWidth: 760, height: 22 + p.tasks.length * 22, border: "1px solid #ccd", background: "#fff" }}>
          {months.map((m) => (<div key={m} style={{ position: "absolute", left: pct(m), top: 0, bottom: 0, borderLeft: "1px solid #e3e6ee", fontSize: 11, paddingLeft: 3, color: "#667" }}>{new Date(m).toISOString().slice(0, 7)}</div>))}
          {p.tasks.map((x, i) => {
            const a = ms(x.planned_start), b = ms(x.planned_end) + DAY;
            return (
              <div key={x.id} title={`${x.seq}. ${x.name}\n${x.planned_start} → ${x.planned_end}`} style={{ position: "absolute", top: 22 + i * 22, left: pct(a), width: `${((b - a) / span) * 100}%`, height: 16,
                background: COLORS[x.status], borderRadius: 3, outline: x.lateDays > 0 ? "2px solid #c0392b" : undefined, fontSize: 10, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", paddingLeft: 3 }}>{x.seq}</div>);
          })}
          {p.target && <div title={t("planTarget")} style={{ position: "absolute", left: pct(ms(p.target)), top: 0, bottom: 0, borderLeft: "2px dashed #c0392b" }} />}
          <div title={p.today} style={{ position: "absolute", left: pct(ms(p.today)), top: 0, bottom: 0, borderLeft: "1px solid #3366cc" }} />
        </div>
      </div>
    );
  }
  return (
    <div>
      <h2>{t("planTitle")}</h2>
      {manage && (
        <div className="toolbar">
          <label>{t("planStartDate")} <input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></label>
          <label>{t("planSewing")} <input type="number" min={100} step={100} value={perDay} onChange={(e) => setPerDay(Number(e.target.value) || 1500)} /></label>
          <button disabled={gen.isPending} onClick={regen}>{has ? t("planRegenerate") : t("planGenerate")}</button>
          {gen.isError && <span className="err">{(gen.error as Error)?.message || t("error")}</span>}
        </div>)}
      {!has && <p className="muted">{t("planNoPlan")}</p>}
      {p && has && (
        <>
          <p>
            <b>{t("planExFactory")}: {p.exFactory}</b>{p.target && <> · {t("planTarget")}: {p.target} · <span style={{ color: (p.deltaDays ?? 0) > 0 ? "#c0392b" : "#3a9d5d" }}>{t("planDelta")}: {(p.deltaDays ?? 0) > 0 ? "+" : ""}{p.deltaDays}</span></>}
            {p.lateCount > 0 && <> · <span className="err">{t("planLateCount")}: {p.lateCount}</span></>}
          </p>
          {chart}
          <table>
            <thead><tr><th>#</th><th>{t("planTask")}</th><th>{t("department")}</th><th>{t("planParty")}</th><th>{t("planDur")}</th><th>{t("planPlanned")}</th><th>{t("planActual")}</th><th>{t("status")}</th><th /></tr></thead>
            <tbody>
              {p.tasks.map((x) => (
                <tr key={x.id} style={x.lateDays > 0 ? { background: "#fdecea" } : undefined}>
                  <td>{x.seq}</td><td>{x.name}<div className="muted">{x.stage}</div></td><td>{x.department_code ?? "—"}</td><td>{x.party ?? "—"}</td><td>{x.duration_days}</td>
                  <td>{x.planned_start.slice(5)} → {x.planned_end.slice(5)}{x.lateDays > 0 && <div className="err">{x.lateDays} {t("planLateDays")}</div>}</td>
                  <td>{x.actual_start?.slice(5) ?? "—"} → {x.actual_end?.slice(5) ?? "—"}</td>
                  <td><span style={{ color: COLORS[x.status] }}>●</span> {stName(x.status)}</td>
                  <td>
                    {update && x.status === "todo" && <button onClick={() => mark.mutate({ id: x.id, version: x.version, status: "in_progress" })}>{t("planStart_")}</button>}
                    {update && (x.status === "in_progress" || x.status === "blocked") && <button onClick={() => mark.mutate({ id: x.id, version: x.version, status: "done" })}>{t("planFinish")}</button>}
                    {update && x.status === "in_progress" && <button className="secondary" onClick={() => mark.mutate({ id: x.id, version: x.version, status: "blocked" })}>{t("planBlock")}</button>}
                    {update && x.status === "blocked" && <button className="secondary" onClick={() => mark.mutate({ id: x.id, version: x.version, status: "in_progress" })}>{t("planStart_")}</button>}
                  </td>
                </tr>))}
            </tbody>
          </table>
          {mark.isError && <div className="err">{(mark.error as Error)?.message || t("error")}</div>}
        </>)}
    </div>
  );
}
