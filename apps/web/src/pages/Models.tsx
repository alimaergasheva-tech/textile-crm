import { FormEvent, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useMe, useUi } from "../state";
import { Color, Grid } from "./CatalogSettings";

interface ML { id: string; code: string; name: string; collection: string | null; season: string | null; category: string | null; variants_count: number }

export function ModelsPage() {
  const { t } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const list = useQuery({ queryKey: ["models", q], queryFn: () => api<ML[]>(`/models?q=${encodeURIComponent(q)}`) });
  const grids = useQuery({ queryKey: ["grids"], queryFn: () => api<Grid[]>("/size-grids") });
  const [f, setF] = useState({ code: "", name: "", category: "", sizeGridId: "" });
  const add = useMutation({
    mutationFn: () => api("/models", { method: "POST", body: JSON.stringify({ code: f.code, name: f.name, category: f.category || undefined, sizeGridId: f.sizeGridId || undefined }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["models"] }); setF({ code: "", name: "", category: "", sizeGridId: f.sizeGridId }); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); add.mutate(); };
  return (
    <div>
      <h1>{t("models")}</h1>
      <input placeholder={t("search2")} value={q} onChange={(e) => setQ(e.target.value)} />
      <table>
        <thead><tr><th>{t("code")}</th><th>{t("name")}</th><th>{t("category")}</th><th>{t("variants")}</th></tr></thead>
        <tbody>{list.data?.map((m) => <tr key={m.id}><td className="mono"><Link to={`/models/${m.id}`}>{m.code}</Link></td><td>{m.name}</td><td>{m.category}</td><td className="num">{m.variants_count}</td></tr>)}</tbody>
      </table>
      {can("models.create") && (
        <form className="inline" onSubmit={submit}>
          <h2>{t("newModel")}</h2>
          <input required placeholder={t("code")} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
          <input required placeholder={t("name")} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <input placeholder={t("category")} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} />
          <select required value={f.sizeGridId} onChange={(e) => setF({ ...f, sizeGridId: e.target.value })}>
            <option value="">{t("grid")}…</option>{grids.data?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          <button type="submit">{t("add")}</button>
          {add.isError && <span className="err">{t("error")}</span>}
        </form>
      )}
    </div>
  );
}

interface Detail {
  model: { id: string; code: string; name: string; collection: string | null; season: string | null; category: string | null; fabric_composition: string | null; size_grid_id: string | null };
  variants: { id: string; sku: string; barcode: string; size_id: string; size: string; color_id: string; color: string; is_active: boolean }[];
  bom: { material_id: string; material: string; unit: string; size_id: string | null; qty_per_unit: number; waste_percent: number }[];
  route: { name: string; norm_minutes: number; piece_rate: number; currency: string }[];
  prices: { price_list_id: string; name: string; currency: string; amount: number | null }[];
}
interface BomRow { materialId: string; sizeId: string; qtyPerUnit: string; wastePercent: string }
interface OpRow { name: string; normMinutes: string; pieceRate: string }

export function ModelPage() {
  const { id } = useParams();
  const { t } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"variants" | "bom" | "route" | "prices">("variants");
  const d = useQuery({ queryKey: ["model", id], queryFn: () => api<Detail>(`/models/${id}`) });
  const colors = useQuery({ queryKey: ["colors"], queryFn: () => api<Color[]>("/colors") });
  const grids = useQuery({ queryKey: ["grids"], queryFn: () => api<Grid[]>("/size-grids") });
  const materials = useQuery({ queryKey: ["materials"], queryFn: () => api<{ id: string; name: string; unit: string }[]>("/materials"), enabled: can("materials.view") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["model", id] });
  const edit = can("models.edit");

  const [picked, setPicked] = useState<string[]>([]);
  const gen = useMutation({ mutationFn: () => api(`/models/${id}/variants/generate`, { method: "POST", body: JSON.stringify({ colorIds: picked }) }), onSuccess: () => { refresh(); setPicked([]); } });

  const [bom, setBom] = useState<BomRow[]>([]);
  const [ops, setOps] = useState<OpRow[]>([]);
  useEffect(() => {
    if (!d.data) return;
    setBom(d.data.bom.map((b) => ({ materialId: b.material_id, sizeId: b.size_id ?? "", qtyPerUnit: String(b.qty_per_unit), wastePercent: String(b.waste_percent) })));
    setOps(d.data.route.map((r) => ({ name: r.name, normMinutes: String(r.norm_minutes), pieceRate: String(r.piece_rate / 100) })));
  }, [d.data]);
  const saveBom = useMutation({
    mutationFn: () => api(`/models/${id}/bom`, { method: "PUT", body: JSON.stringify({ lines: bom.filter((b) => b.materialId).map((b) => ({
      materialId: b.materialId, sizeId: b.sizeId || null, qtyPerUnit: Number(b.qtyPerUnit) || 0, wastePercent: Number(b.wastePercent) || 0 })) }) }),
    onSuccess: refresh,
  });
  const saveRoute = useMutation({
    mutationFn: () => api(`/models/${id}/route`, { method: "PUT", body: JSON.stringify({ operations: ops.filter((o) => o.name).map((o) => ({
      name: o.name, normMinutes: Number(o.normMinutes) || 0, pieceRate: Math.round((Number(o.pieceRate) || 0) * 100) })) }) }),
    onSuccess: refresh,
  });

  // Калькулятор потребности: количество по размерам → материалы
  const [run, setRun] = useState<Record<string, string>>({});
  const calc = useMutation({
    mutationFn: () => api<{ materialId: string; name: string; unit: string; qty: number }[]>(`/models/${id}/requirement`, { method: "POST",
      body: JSON.stringify({ items: Object.entries(run).filter(([, v]) => Number(v) > 0).map(([sizeId, v]) => ({ sizeId, qty: Number(v) })) }) }),
  });

  if (!d.data) return <p>{t("loading")}</p>;
  const { model, variants } = d.data;
  const sizes = grids.data?.find((g) => g.id === model.size_grid_id)?.sizes ?? [];
  const sizeOpts = <><option value="">{t("allSizes")}</option>{sizes.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</>;

  return (
    <div>
      <p><Link to="/models">← {t("models")}</Link></p>
      <h1>{model.code} · {model.name}</h1>
      <p className="muted">{[model.category, model.collection, model.season, model.fabric_composition].filter(Boolean).join(" · ")}</p>
      <div className="tabs">
        {(["variants", "bom", "route", "prices"] as const).map((k) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{k === "variants" ? t("variants") : k === "bom" ? t("bom") : k === "route" ? t("route") : t("price")}</button>))}
      </div>

      {tab === "variants" && (<>
        <table>
          <thead><tr><th>{t("sku")}</th><th>{t("barcode")}</th><th>{t("size")}</th><th>{t("color")}</th></tr></thead>
          <tbody>{variants.map((v) => <tr key={v.id}><td className="mono">{v.sku}</td><td className="mono">{v.barcode}</td><td>{v.size}</td><td>{v.color}</td></tr>)}</tbody>
        </table>
        {edit && (
          <div className="inline">
            <h2>{t("generate")}</h2>
            {colors.data?.map((c) => (
              <label key={c.id} style={{ display: "inline-flex", gap: 4 }}>
                <input type="checkbox" checked={picked.includes(c.id)} onChange={() => setPicked(picked.includes(c.id) ? picked.filter((x) => x !== c.id) : [...picked, c.id])} />{c.name_ru}
              </label>))}
            <button disabled={!picked.length} onClick={() => gen.mutate()}>{t("generate")}</button>
            {gen.isError && <span className="err">{t("error")}</span>}
          </div>)}
      </>)}

      {tab === "bom" && (<>
        <table>
          <thead><tr><th>{t("material")}</th><th>{t("size")}</th><th>{t("qtyPerUnit")}</th><th>{t("waste")}</th><th></th></tr></thead>
          <tbody>{bom.map((b, i) => (
            <tr key={i}>
              <td><select disabled={!edit} value={b.materialId} onChange={(e) => setBom(bom.map((x, j) => j === i ? { ...x, materialId: e.target.value } : x))}>
                <option value="">…</option>{materials.data?.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.unit})</option>)}</select></td>
              <td><select disabled={!edit} value={b.sizeId} onChange={(e) => setBom(bom.map((x, j) => j === i ? { ...x, sizeId: e.target.value } : x))}>{sizeOpts}</select></td>
              <td><input disabled={!edit} type="number" step="0.0001" min="0" value={b.qtyPerUnit} onChange={(e) => setBom(bom.map((x, j) => j === i ? { ...x, qtyPerUnit: e.target.value } : x))} /></td>
              <td><input disabled={!edit} type="number" step="0.1" min="0" max="99" value={b.wastePercent} onChange={(e) => setBom(bom.map((x, j) => j === i ? { ...x, wastePercent: e.target.value } : x))} /></td>
              <td>{edit && <button onClick={() => setBom(bom.filter((_, j) => j !== i))}>✕</button>}</td>
            </tr>))}</tbody>
        </table>
        {edit && (<div className="inline">
          <button onClick={() => setBom([...bom, { materialId: "", sizeId: "", qtyPerUnit: "0", wastePercent: "0" }])}>{t("add")}</button>
          <button onClick={() => saveBom.mutate()}>{t("save")}</button>
          {saveBom.isError && <span className="err">{t("error")}</span>}
        </div>)}
        <h2>{t("requirement")}</h2>
        <div className="inline">
          {sizes.map((s) => <label key={s.id} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>{s.label}
            <input style={{ width: 70 }} type="number" min="0" value={run[s.id] ?? ""} onChange={(e) => setRun({ ...run, [s.id]: e.target.value })} /></label>)}
          <button onClick={() => calc.mutate()}>{t("calculate")}</button>
        </div>
        {calc.data && <table><tbody>{calc.data.map((r) => <tr key={r.materialId}><td>{r.name}</td><td className="num">{r.qty} {r.unit}</td></tr>)}</tbody></table>}
      </>)}

      {tab === "route" && (<>
        <table>
          <thead><tr><th>#</th><th>{t("operation")}</th><th>{t("normMinutes")}</th><th>{t("pieceRate")} (UZS)</th><th></th></tr></thead>
          <tbody>{ops.map((o, i) => (
            <tr key={i}>
              <td>{i + 1}</td>
              <td><input disabled={!edit} value={o.name} onChange={(e) => setOps(ops.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} /></td>
              <td><input disabled={!edit} type="number" min="0" step="0.1" value={o.normMinutes} onChange={(e) => setOps(ops.map((x, j) => j === i ? { ...x, normMinutes: e.target.value } : x))} /></td>
              <td><input disabled={!edit} type="number" min="0" step="1" value={o.pieceRate} onChange={(e) => setOps(ops.map((x, j) => j === i ? { ...x, pieceRate: e.target.value } : x))} /></td>
              <td>{edit && <button onClick={() => setOps(ops.filter((_, j) => j !== i))}>✕</button>}</td>
            </tr>))}</tbody>
        </table>
        {edit && (<div className="inline">
          <button onClick={() => setOps([...ops, { name: "", normMinutes: "0", pieceRate: "0" }])}>{t("add")}</button>
          <button onClick={() => saveRoute.mutate()}>{t("save")}</button>
          {saveRoute.isError && <span className="err">{t("error")}</span>}
        </div>)}
      </>)}

      {tab === "prices" && (
        <table>
          <thead><tr><th>{t("pricing")}</th><th>{t("price")}</th></tr></thead>
          <tbody>{d.data.prices.map((p) => <tr key={p.price_list_id}><td>{p.name}</td><td className="num">{p.amount === null ? "—" : `${(p.amount / 100).toLocaleString()} ${p.currency}`}</td></tr>)}</tbody>
        </table>
      )}
    </div>
  );
}
