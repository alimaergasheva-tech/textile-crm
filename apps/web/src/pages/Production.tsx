import { PhotoStrip } from "./PhotoStrip";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useMe, useUi } from "../state";

const COLS = ["draft", "planned", "in_progress", "qc", "stocked", "closed"];

export function ProductionPage() {
  const { t } = useUi();
  const list = useQuery({ queryKey: ["pos"], queryFn: () => api<any[]>("/production-orders") });
  const board = useQuery({ queryKey: ["board"], queryFn: () => api<{ load: { id: string; name: string; steps: number }[] }>("/production/board") });
  return (
    <div>
      <h1>{t("productionOrders")}</h1>
      {!!board.data?.load.length && <p>{t("load")}: {board.data.load.map((b) => <span key={b.id} className="chip">{b.name}: {b.steps}</span>)}</p>}
      <div className="board">
        {COLS.map((s) => (
          <div key={s} className="col"><h3>{s}</h3>
            {list.data?.filter((p) => p.status === s).map((p) => (
              <Link key={p.id} to={`/production/${p.id}`} className="card" style={{ display: "block" }}>
                <b>{p.number}</b> · {p.model_code}<br />{p.planned} · {p.order_number}{p.deadline && <> · {p.deadline.slice(0, 10)}</>}{p.overdue && <span className="err"> {t("overdue")}</span>}
              </Link>))}
          </div>))}
      </div>
    </div>
  );
}

export function ProductionView() {
  const { id } = useParams();
  const { t } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const d = useQuery({ queryKey: ["po", id], queryFn: () => api<any>(`/production-orders/${id}`) });
  const brigades = useQuery({ queryKey: ["brigades"], queryFn: () => api<any[]>("/brigades") });
  const contractors = useQuery({ queryKey: ["contractors"], queryFn: () => api<any[]>("/contractors") });
  const [qty, setQty] = useState<Record<string, string>>({});
  const [qcv, setQcv] = useState<Record<string, { good: string; defect: string }>>({});
  const [err, setErr] = useState("");
  const refresh = () => { qc.invalidateQueries({ queryKey: ["po", id] }); qc.invalidateQueries({ queryKey: ["pos"] }); qc.invalidateQueries({ queryKey: ["balances"] }); setErr(""); };
  const call = useMutation({
    mutationFn: ({ path, method = "POST", body }: { path: string; method?: string; body?: unknown }) => api(path, { method, body: body ? JSON.stringify(body) : undefined }),
    onSuccess: refresh, onError: (e: Error) => setErr(e.message),
  });
  if (!d.data) return <p>{t("loading")}</p>;
  const p = d.data, manage = can("production.manage"), rep = can("production.report"), qcOk = can("production.qc");
  const go = (a: string, body?: unknown) => call.mutate({ path: `/production-orders/${id}/${a}`, body });
  return (
    <div>
      <h1>{p.number} · {p.model_code} {p.model_name}</h1>
      <p><b>{p.status}</b> · {p.order_number} · {t("planned")}: {p.plannedTotal} {p.deadline && `· ${p.deadline.slice(0, 10)}`}</p>
      {err && <p className="err">{err}</p>}
      {manage && <p>
        {p.status === "draft" && <button onClick={() => go("plan", {})}>{t("plan")}</button>}{" "}
        {p.status === "planned" && <button onClick={() => go("start")}>{t("startProd")}</button>}{" "}
        {p.status === "in_progress" && <button onClick={() => go("to-qc")}>{t("toQc")}</button>}{" "}
        {p.status === "stocked" && <button onClick={() => go("close")}>{t("closeIt")}</button>}{" "}
        {["draft", "planned"].includes(p.status) && <button onClick={() => go("cancel")}>{t("cancelIt")}</button>}</p>}

      <h2>{t("variants")}</h2>
      <table><thead><tr><th>SKU</th><th>{t("planned")}</th><th>{t("good")}</th><th>{t("defectQty")}</th>{p.status === "qc" && qcOk && <><th>{t("good")}</th><th>{t("defectQty")}</th></>}</tr></thead>
        <tbody>{p.items.map((i: any) => <tr key={i.id}><td>{i.sku}</td><td className="num">{i.planned_qty}</td><td className="num">{i.done_qty}</td><td className="num">{i.defect_qty}</td>
          {p.status === "qc" && qcOk && <><td><input type="number" min="0" style={{ width: 70 }} defaultValue={i.planned_qty} onChange={(e) => setQcv({ ...qcv, [i.variant_id]: { good: e.target.value, defect: qcv[i.variant_id]?.defect ?? "0" } })} /></td>
            <td><input type="number" min="0" style={{ width: 70 }} defaultValue={0} onChange={(e) => setQcv({ ...qcv, [i.variant_id]: { good: qcv[i.variant_id]?.good ?? String(i.planned_qty), defect: e.target.value } })} /></td></>}</tr>)}</tbody></table>
      {p.status === "qc" && qcOk && <p><button onClick={() => go("qc", { lines: p.items.map((i: any) => ({ variantId: i.variant_id, good: Number(qcv[i.variant_id]?.good ?? i.planned_qty), defect: Number(qcv[i.variant_id]?.defect ?? 0), action: "writeoff" })) })}>{t("qcAccept")}</button></p>}

      <h2>{t("steps")}</h2>
      <table><thead><tr><th>#</th><th>{t("name")}</th><th>{t("status")}</th><th>{t("planned")}</th><th>{t("brigade")} / {t("contractor")}</th><th>{t("action")}</th></tr></thead>
        <tbody>{p.steps.map((s: any) => (
          <tr key={s.id}><td>{s.step}</td><td>{s.name}</td><td>{s.status}</td><td className="num">{s.reported}/{p.plannedTotal}</td>
            <td>{manage && s.status !== "done"
              ? <select value={s.brigade_id ?? (s.contractor_id ? "c:" + s.contractor_id : "")} onChange={(e) => { const v = e.target.value; if (v) call.mutate({ path: `/production-steps/${s.id}/assign`, method: "PUT", body: v.startsWith("c:") ? { contractorId: v.slice(2) } : { brigadeId: v } }); }}>
                  <option value="">—</option>{brigades.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}{contractors.data?.map((x) => <option key={x.id} value={"c:" + x.id}>{x.name}</option>)}</select>
              : (s.brigade ?? s.contractor ?? "—")}</td>
            <td>{p.status === "in_progress" && s.status !== "done" && <>
              {rep && <><input type="number" min="1" style={{ width: 70 }} value={qty[s.id] ?? ""} onChange={(e) => setQty({ ...qty, [s.id]: e.target.value })} /> <button onClick={() => call.mutate({ path: `/production-steps/${s.id}/report`, body: { qty: Number(qty[s.id]) } })}>{t("report")}</button></>}
              {manage && <> <button onClick={() => { const r = prompt(t("reason")); if (r) call.mutate({ path: `/production-steps/${s.id}/close`, body: { reason: r } }); }}>{t("closeStep")}</button></>}</>}</td></tr>))}</tbody></table>

      {!!p.consumption.length && <><h2>{t("consumption")}</h2>
        <table><thead><tr><th>{t("material")}</th><th>{t("planned")}</th><th>{t("actual")}</th></tr></thead>
          <tbody>{p.consumption.map((m: any) => <tr key={m.material_id}><td>{m.code} {m.name}</td><td className="num">{m.planned_qty} {m.unit}</td>
            <td>{p.status === "in_progress" && manage ? <input type="number" step="0.001" style={{ width: 100 }} defaultValue={m.actual_qty} onBlur={(e) => Number(e.target.value) !== m.actual_qty && call.mutate({ path: `/production-orders/${id}/consumption`, body: { materialId: m.material_id, actual: Number(e.target.value) } })} /> : m.actual_qty}</td></tr>)}</tbody></table></>}
      {!!p.defects.length && <p>{t("defectQty")}: {p.defects.map((x: any) => `${x.sku} × ${x.qty} (${x.action})`).join(", ")}</p>}
      {(!!p.defects.length || p.status === "qc") && <p>📷 <PhotoStrip entity="production_order" entityId={p.id} canAdd={can("files.create")} /></p>}
    </div>
  );
}
