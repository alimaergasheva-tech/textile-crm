import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useMe, useUi } from "../state";

interface Spec { modelId: string; code: string; qty: number; shipped: number; pcsPerCarton: number | null; cartonL: number | null; cartonW: number | null; cartonH: number | null; cartonKg: number | null }
interface Carrier { id: string; name: string; contact: string | null; phone: string | null; email: string | null; rate_per_truck: number | null; currency: string; transit_days: number | null; route: string | null; is_active: boolean }
interface Load { n: number; cartons: number; m3: number; kg: number; fillM3: number; fillKg: number; items: { code: string; cartons: number; pcs: number }[] }
interface Data { specs: Spec[]; missing: string[]; trucks: { code: string; name: string; m3: number; kg: number }[]; error: string | null; cost: number | null;
  plan: { rows: { code: string; qty: number; cartons: number; m3: number; kg: number }[]; totals: { cartons: number; m3: number; kg: number; pcs: number }; trucks: Load[]; minByVol: number; minByKg: number; limit: string } | null }
type Row = { pcs: string; l: string; w: string; h: string; kg: string };

/** Логистика: упаковка по моделям → объём, вес, число машин и раскладка по машинам. */
export function ExportLogistics({ orderId }: { orderId: string }) {
  const { t } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const manage = can("exportlogistics.manage");
  const [truck, setTruck] = useState("tilt"), [basis, setBasis] = useState("order"), [fill, setFill] = useState("0.9"), [priceIn, setPriceIn] = useState("");
  const price = priceIn;
  const q = useQuery({ queryKey: ["export-logistics", orderId, truck, basis, fill, price], queryFn: () => api<Data>(`/export-orders/${orderId}/logistics?truck=${truck}&basis=${basis}&fill=${fill}&price=${price}`) });
  const carriers = useQuery({ queryKey: ["export-carriers"], queryFn: () => api<Carrier[]>("/export-carriers") });
  const [carrierId, setCarrierId] = useState("");
  const carrier = (carriers.data ?? []).find((x) => x.id === carrierId);
  const [msg, setMsg] = useState("");
  const create = useMutation({
    mutationFn: () => api<{ created: string[] }>(`/export-orders/${orderId}/logistics/create-shipments`, { method: "POST", body: JSON.stringify({ truck, fill: Number(fill), carrierId: carrierId || null }) }),
    onSuccess: (r) => { setErr(""); setMsg(`${t("lgCreated")}: ${r.created.join(", ")}`); qc.invalidateQueries({ queryKey: ["export-shipments", orderId] }); qc.invalidateQueries({ queryKey: ["export-production", orderId] }); qc.invalidateQueries({ queryKey: ["export-logistics", orderId] }); },
    onError: (e) => { setMsg(""); setErr(e instanceof Error ? e.message : String(e)); },
  });
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!q.data) return;
    const r: Record<string, Row> = {};
    for (const s of q.data.specs) r[s.modelId] = { pcs: s.pcsPerCarton?.toString() ?? "", l: s.cartonL?.toString() ?? "", w: s.cartonW?.toString() ?? "", h: s.cartonH?.toString() ?? "", kg: s.cartonKg?.toString() ?? "" };
    setRows(r);
  }, [q.data?.specs]);
  const save = useMutation({
    mutationFn: () => {
      const specs = Object.entries(rows).filter(([, v]) => v.pcs && v.l && v.w && v.h && v.kg)
        .map(([modelId, v]) => ({ modelId, pcsPerCarton: Number(v.pcs), cartonL: Number(v.l), cartonW: Number(v.w), cartonH: Number(v.h), cartonKg: Number(v.kg) }));
      return api(`/export-orders/${orderId}/pack-specs`, { method: "PUT", body: JSON.stringify({ specs }) });
    },
    onSuccess: () => { setErr(""); qc.invalidateQueries({ queryKey: ["export-logistics", orderId] }); }, onError: (e) => setErr(e instanceof Error ? e.message : String(e)),
  });
  const d = q.data;
  if (!d) return null;
  const set = (id: string, k: keyof Row, v: string) => setRows({ ...rows, [id]: { ...rows[id], [k]: v } });
  const p = d.plan;
  return (
    <div>
      <h2>{t("lgTitle")}</h2>
      <table>
        <thead><tr><th>{t("model")}</th><th>{t("prOrdered")}</th><th>{t("lgPcs")}</th><th>{t("lgDims")}</th><th>{t("lgKg")}</th></tr></thead>
        <tbody>{d.specs.map((s) => { const v = rows[s.modelId] ?? { pcs: "", l: "", w: "", h: "", kg: "" }; const inp = (k: keyof Row, w: number) => <input disabled={!manage} type="number" style={{ width: w }} value={v[k]} onChange={(e) => set(s.modelId, k, e.target.value)} />;
          return (<tr key={s.modelId}><td>{s.code}</td><td>{s.qty.toLocaleString()}</td><td>{inp("pcs", 70)}</td><td>{inp("l", 60)} × {inp("w", 60)} × {inp("h", 60)}</td><td>{inp("kg", 70)}</td></tr>); })}</tbody>
      </table>
      {manage && <button disabled={save.isPending} onClick={() => save.mutate()}>{t("vedSave")}</button>}
      {err && <span style={{ color: "#c0392b" }}> {err}</span>}
      <div className="toolbar" style={{ marginTop: 8 }}>
        <select value={truck} onChange={(e) => setTruck(e.target.value)}>{d.trucks.map((x) => <option key={x.code} value={x.code}>{x.name} ({x.m3} m³ / {x.kg / 1000} t)</option>)}</select>
        <select value={basis} onChange={(e) => setBasis(e.target.value)}><option value="order">{t("lgAll")}</option><option value="remaining">{t("lgRemaining")}</option></select>
        <label>{t("lgFill")} <input type="number" step="0.05" min="0.5" max="1" style={{ width: 70 }} value={fill} onChange={(e) => setFill(e.target.value)} /></label>
        <label>{t("lgPrice")} <input type="number" style={{ width: 90 }} placeholder={carrier?.rate_per_truck?.toString() ?? ""} value={priceIn} onChange={(e) => setPriceIn(e.target.value)} /></label>
        <select value={carrierId} onChange={(e) => { setCarrierId(e.target.value); const c = (carriers.data ?? []).find((x) => x.id === e.target.value); setPriceIn(c?.rate_per_truck?.toString() ?? ""); }}><option value="">{t("shCarrier")}…</option>{(carriers.data ?? []).filter((x) => x.is_active).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        {can("exportshipments.manage") && <button disabled={create.isPending} onClick={() => create.mutate()}>{t("lgCreate")}</button>}
      </div>
      {msg && <p style={{ color: "#3a9d5d" }}>{msg}</p>}
      {d.missing.length > 0 && <p className="muted">{t("lgMissing")}: {d.missing.join(", ")}</p>}
      {d.error && <p style={{ color: "#c0392b" }}>{d.error}</p>}
      {p && p.trucks.length > 0 && (<>
        <p><b>{p.trucks.length}</b> {t("lgTrucks")} · {p.totals.cartons.toLocaleString()} {t("shCartons")} · {p.totals.m3} m³ · {p.totals.kg.toLocaleString()} kg · {t("lgLimit")}: {p.limit === "weight" ? t("lgByWeight") : t("lgByVolume")}
          {d.cost !== null && <> · {t("lgCost")}: {d.cost.toLocaleString()}</>}</p>
        <table>
          <thead><tr><th>#</th><th>{t("shCartons")}</th><th>m³ ({t("lgFilled")})</th><th>kg</th><th>{t("shLines")}</th></tr></thead>
          <tbody>{p.trucks.map((x) => (<tr key={x.n}><td>{x.n}</td><td>{x.cartons}</td><td>{x.m3} ({x.fillM3}%)</td><td>{x.kg.toLocaleString()} ({x.fillKg}%)</td><td>{x.items.map((i) => `${i.code}: ${i.pcs.toLocaleString()} (${i.cartons} ${t("shCartons")})`).join("; ")}</td></tr>))}</tbody>
        </table></>)}
      <Carriers manage={manage} />
    </div>
  );
}

/** Справочник перевозчиков со ставками за машину. */
function Carriers({ manage }: { manage: boolean }) {
  const { t } = useUi();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["export-carriers"], queryFn: () => api<Carrier[]>("/export-carriers") });
  const [f, setF] = useState({ name: "", phone: "", rate: "", days: "", route: "" });
  const [err, setErr] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["export-carriers"] });
  const add = useMutation({
    mutationFn: () => api("/export-carriers", { method: "POST", body: JSON.stringify({ name: f.name, phone: f.phone || null, ratePerTruck: f.rate ? Number(f.rate) : null, transitDays: f.days ? Number(f.days) : null, route: f.route || null }) }),
    onSuccess: () => { setF({ name: "", phone: "", rate: "", days: "", route: "" }); setErr(""); refresh(); }, onError: (e) => setErr(e instanceof Error ? e.message : String(e)),
  });
  const del = useMutation({ mutationFn: (id: string) => api(`/export-carriers/${id}`, { method: "DELETE" }), onSuccess: refresh });
  return (
    <div>
      <h3>{t("lgCarriers")}</h3>
      {(list.data ?? []).length > 0 && (
        <table>
          <thead><tr><th>{t("shCarrier")}</th><th>{t("lgPhone")}</th><th>{t("lgPrice")}</th><th>{t("lgDays")}</th><th>{t("lgRoute")}</th><th /></tr></thead>
          <tbody>{(list.data ?? []).map((x) => (<tr key={x.id}><td>{x.name}</td><td>{x.phone ?? ""}</td><td>{x.rate_per_truck !== null ? `${x.rate_per_truck.toLocaleString()} ${x.currency}` : "—"}</td><td>{x.transit_days ?? "—"}</td><td>{x.route ?? ""}</td>
            <td>{manage && <button className="link" onClick={() => del.mutate(x.id)}>✕</button>}</td></tr>))}</tbody>
        </table>)}
      {manage && (
        <div className="toolbar">
          <input placeholder={t("shCarrier")} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <input placeholder={t("lgPhone")} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          <input type="number" placeholder={t("lgPrice")} style={{ width: 110 }} value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} />
          <input type="number" placeholder={t("lgDays")} style={{ width: 80 }} value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} />
          <input placeholder={t("lgRoute")} value={f.route} onChange={(e) => setF({ ...f, route: e.target.value })} />
          <button disabled={f.name.length < 2 || add.isPending} onClick={() => add.mutate()}>{t("prAdd")}</button>
        </div>)}
      {err && <p style={{ color: "#c0392b" }}>{err}</p>}
    </div>
  );
}
