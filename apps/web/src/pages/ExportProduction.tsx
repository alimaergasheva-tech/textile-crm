import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useMe, useUi } from "../state";

interface MRow { modelId: string; code: string; qty: number; cut: number; sew: number; pack: number; shipped: number; shippable: number; aql: "pass" | "fail" | "none"; pctCut: number; pctSew: number; pctPack: number }
interface LogRow { id: string; model: string; stage: "cut" | "sew" | "pack"; day: string; qty: number; note: string | null }
interface Ship { id: string; number: string; status: string; carrier: string | null; plate: string | null; cmr_no: string | null; destination: string; loading_date: string | null; eta: string | null; delivered_on: string | null;
  volume_m3: number | null; weight_kg: number | null; cartons: number | null; note: string | null; version: number; lines: { model_id: string; model: string; qty: number; cartons: number | null }[] }
const today = () => new Date().toISOString().slice(0, 10);
const bar = (p: number, color: string) => (<div style={{ background: "#0001", borderRadius: 3, height: 8, minWidth: 70 }}><div style={{ width: `${p}%`, background: color, height: 8, borderRadius: 3 }} /></div>);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Выпуск по моделям: раскрой → пошив → упаковка с проверкой цепочки. */
export function ExportProduction({ orderId }: { orderId: string }) {
  const { t } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const manage = can("exportproduction.manage");
  const q = useQuery({ queryKey: ["export-production", orderId], queryFn: () => api<{ models: MRow[]; log: LogRow[] }>(`/export-orders/${orderId}/production`) });
  const [f, setF] = useState({ modelId: "", stage: "cut", day: today(), qty: "", note: "" });
  const [err, setErr] = useState("");
  const refresh = () => { qc.invalidateQueries({ queryKey: ["export-production", orderId] }); qc.invalidateQueries({ queryKey: ["export-shipments", orderId] }); qc.invalidateQueries({ queryKey: ["export-order", orderId] }); };
  const add = useMutation({
    mutationFn: () => api(`/export-orders/${orderId}/production`, { method: "POST", body: JSON.stringify({ modelId: f.modelId || q.data!.models[0].modelId, stage: f.stage, day: f.day, qty: Number(f.qty), note: f.note || null }) }),
    onSuccess: () => { setF({ ...f, qty: "", note: "" }); setErr(""); refresh(); }, onError: (e) => setErr(errMsg(e)),
  });
  const del = useMutation({ mutationFn: (id: string) => api(`/export-production/${id}`, { method: "DELETE" }), onSuccess: () => { setErr(""); refresh(); }, onError: (e) => setErr(errMsg(e)) });
  const d = q.data;
  if (!d) return null;
  return (
    <div>
      <h2>{t("prTitle")}</h2>
      <table>
        <thead><tr><th>{t("model")}</th><th>{t("prOrdered")}</th><th>{t("prCut")}</th><th>{t("prSew")}</th><th>{t("prPack")}</th><th>{t("prShipped")}</th><th>AQL</th></tr></thead>
        <tbody>{d.models.map((m) => (
          <tr key={m.modelId}>
            <td>{m.code}</td><td>{m.qty.toLocaleString()}</td>
            <td>{m.cut.toLocaleString()} ({m.pctCut}%){bar(m.pctCut, "#8aa4c8")}</td>
            <td>{m.sew.toLocaleString()} ({m.pctSew}%){bar(m.pctSew, "#e0a030")}</td>
            <td>{m.pack.toLocaleString()} ({m.pctPack}%){bar(m.pctPack, "#3a9d5d")}</td>
            <td>{m.shipped.toLocaleString()}</td>
            <td style={{ color: m.aql === "pass" ? "#3a9d5d" : m.aql === "fail" ? "#c0392b" : undefined }}>{m.aql === "none" ? "—" : m.aql === "pass" ? t("prAqlPass") : t("prAqlFail")}</td>
          </tr>))}</tbody>
      </table>
      {manage && d.models.length > 0 && (
        <div className="toolbar" style={{ marginTop: 8 }}>
          <select value={f.modelId} onChange={(e) => setF({ ...f, modelId: e.target.value })}>{d.models.map((m) => <option key={m.modelId} value={m.modelId}>{m.code}</option>)}</select>
          <select value={f.stage} onChange={(e) => setF({ ...f, stage: e.target.value })}>{(["cut", "sew", "pack"] as const).map((s) => <option key={s} value={s}>{t(`pr_${s}` as never)}</option>)}</select>
          <input type="date" value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })} />
          <input type="number" min={1} placeholder={t("prQty")} style={{ width: 90 }} value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} />
          <input placeholder={t("prNote")} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          <button disabled={add.isPending || !(Number(f.qty) > 0)} onClick={() => add.mutate()}>{t("prAdd")}</button>
        </div>)}
      {err && <p style={{ color: "#c0392b" }}>{err}</p>}
      {d.log.length > 0 && (
        <table>
          <thead><tr><th>{t("prDay")}</th><th>{t("model")}</th><th>{t("prStage")}</th><th>{t("prQty")}</th><th>{t("prNote")}</th><th /></tr></thead>
          <tbody>{d.log.map((r) => (
            <tr key={r.id}><td>{r.day}</td><td>{r.model}</td><td>{t(`pr_${r.stage}` as never)}</td><td>{r.qty.toLocaleString()}</td><td className="muted">{r.note}</td>
              <td>{manage && <button className="link" onClick={() => del.mutate(r.id)}>✕</button>}</td></tr>))}</tbody>
        </table>)}
    </div>
  );
}

/** Отгрузки (машины в США): состав по моделям, перевозчик, объём, статусы. Только модели с принятым итоговым AQL. */
export function ExportShipments({ orderId }: { orderId: string }) {
  const { t } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const manage = can("exportshipments.manage");
  const ships = useQuery({ queryKey: ["export-shipments", orderId], queryFn: () => api<Ship[]>(`/export-orders/${orderId}/shipments`) });
  const prod = useQuery({ queryKey: ["export-production", orderId], queryFn: () => api<{ models: MRow[]; log: LogRow[] }>(`/export-orders/${orderId}/production`), enabled: can("exportproduction.view") });
  const [f, setF] = useState({ carrier: "", plate: "", cmrNo: "", loadingDate: "", eta: "", volumeM3: "", weightKg: "", cartons: "" });
  const [qty, setQty] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  const refresh = () => { qc.invalidateQueries({ queryKey: ["export-shipments", orderId] }); qc.invalidateQueries({ queryKey: ["export-production", orderId] }); qc.invalidateQueries({ queryKey: ["export-order", orderId] }); };
  const num = (s: string) => (s === "" ? null : Number(s));
  const create = useMutation({
    mutationFn: () => api(`/export-orders/${orderId}/shipments`, { method: "POST", body: JSON.stringify({
      carrier: f.carrier || null, plate: f.plate || null, cmrNo: f.cmrNo || null, loadingDate: f.loadingDate || null, eta: f.eta || null,
      volumeM3: num(f.volumeM3), weightKg: num(f.weightKg), cartons: num(f.cartons),
      lines: Object.entries(qty).filter(([, v]) => Number(v) > 0).map(([modelId, v]) => ({ modelId, qty: Number(v) })) }) }),
    onSuccess: () => { setQty({}); setF({ carrier: "", plate: "", cmrNo: "", loadingDate: "", eta: "", volumeM3: "", weightKg: "", cartons: "" }); setErr(""); refresh(); }, onError: (e) => setErr(errMsg(e)),
  });
  const st = useMutation({ mutationFn: (v: { s: Ship; status: string }) => api(`/export-shipments/${v.s.id}/status`, { method: "POST", body: JSON.stringify({ version: v.s.version, status: v.status }) }), onSuccess: () => { setErr(""); refresh(); }, onError: (e) => setErr(errMsg(e)) });
  const del = useMutation({ mutationFn: (id: string) => api(`/export-shipments/${id}`, { method: "DELETE" }), onSuccess: () => { setErr(""); refresh(); }, onError: (e) => setErr(errMsg(e)) });
  const NEXT: Record<string, string[]> = { planned: ["loaded", "cancelled"], loaded: ["in_transit", "cancelled"], in_transit: ["delivered"], delivered: [], cancelled: [] };
  const avail = (prod.data?.models ?? []).filter((m) => m.aql === "pass" && m.shippable > 0);
  const canCreate = Object.values(qty).some((v) => Number(v) > 0);
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });
  return (
    <div>
      <h2>{t("shTitle")}</h2>
      {!(ships.data ?? []).length && <p className="muted">{t("shNone")}</p>}
      {(ships.data ?? []).length > 0 && (
        <table>
          <thead><tr><th>№</th><th>{t("shStatus")}</th><th>{t("shCarrier")}</th><th>{t("shDates")}</th><th>{t("shLoad")}</th><th>{t("shLines")}</th><th /></tr></thead>
          <tbody>{(ships.data ?? []).map((s) => (
            <tr key={s.id}>
              <td>{s.number}{can("exportved.view") && <div><Link to={`/export-orders/${orderId}/shipments/${s.id}/docs`}>{t("vedOpen")}</Link></div>}<div className="muted">{s.destination}{s.cmr_no ? ` · CMR ${s.cmr_no}` : ""}</div></td>
              <td>{t(`shSt_${s.status}` as never)}</td>
              <td>{s.carrier ?? "—"}<div className="muted">{s.plate}</div></td>
              <td>{s.loading_date ?? "—"} → {s.eta ?? "—"}{s.delivered_on && <div className="muted">{t("shDeliveredOn")}: {s.delivered_on}</div>}</td>
              <td>{s.volume_m3 ?? "—"} m³ · {s.weight_kg ?? "—"} kg · {s.cartons ?? "—"} {t("shCartons")}</td>
              <td>{s.lines.map((l) => `${l.model}: ${l.qty.toLocaleString()}`).join("; ")}</td>
              <td>{manage && <>
                {NEXT[s.status].map((n) => <button key={n} disabled={st.isPending} onClick={() => st.mutate({ s, status: n })}>{t(`shTo_${n}` as never)}</button>)}
                {["planned", "cancelled"].includes(s.status) && <button className="link" onClick={() => del.mutate(s.id)}>✕</button>}</>}</td>
            </tr>))}</tbody>
        </table>)}
      {err && <p style={{ color: "#c0392b" }}>{err}</p>}
      {manage && (
        <div>
          <h3>{t("shNew")}</h3>
          {!avail.length ? <p className="muted">{t("shNoAvail")}</p> : (
            <>
              <table>
                <thead><tr><th>{t("model")}</th><th>{t("shAvail")}</th><th>{t("shQty")}</th></tr></thead>
                <tbody>{avail.map((m) => (<tr key={m.modelId}><td>{m.code}</td><td>{m.shippable.toLocaleString()}</td>
                  <td><input type="number" min={0} max={m.shippable} style={{ width: 90 }} value={qty[m.modelId] ?? ""} onChange={(e) => setQty({ ...qty, [m.modelId]: e.target.value })} /></td></tr>))}</tbody>
              </table>
              <div className="toolbar">
                <input placeholder={t("shCarrier")} value={f.carrier} onChange={(e) => set("carrier", e.target.value)} />
                <input placeholder={t("shPlate")} style={{ width: 110 }} value={f.plate} onChange={(e) => set("plate", e.target.value)} />
                <input placeholder="CMR" style={{ width: 100 }} value={f.cmrNo} onChange={(e) => set("cmrNo", e.target.value)} />
                <input type="date" title={t("shLoadingDate")} value={f.loadingDate} onChange={(e) => set("loadingDate", e.target.value)} />
                <input type="date" title="ETA" value={f.eta} onChange={(e) => set("eta", e.target.value)} />
                <input type="number" placeholder="m³" style={{ width: 70 }} value={f.volumeM3} onChange={(e) => set("volumeM3", e.target.value)} />
                <input type="number" placeholder="kg" style={{ width: 80 }} value={f.weightKg} onChange={(e) => set("weightKg", e.target.value)} />
                <input type="number" placeholder={t("shCartons")} style={{ width: 80 }} value={f.cartons} onChange={(e) => set("cartons", e.target.value)} />
                <button disabled={!canCreate || create.isPending} onClick={() => create.mutate()}>{t("shCreate")}</button>
              </div>
            </>)}
        </div>)}
    </div>
  );
}
