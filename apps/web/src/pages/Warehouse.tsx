import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useMe, useUi } from "../state";

interface Loc { id: string; code: string; name: string | null }
interface Wh { id: string; name: string; kind: string; locations: Loc[] }
const useWh = () => useQuery({ queryKey: ["warehouses"], queryFn: () => api<Wh[]>("/warehouses") });
const allLocs = (w?: Wh[]) => (w ?? []).flatMap((x) => x.locations.map((l) => ({ id: l.id, label: `${x.name} · ${l.code}` })));

export function StockPage() {
  const { t } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const [kind, setKind] = useState<"material" | "variant">("material");
  const [q, setQ] = useState("");
  const rows = useQuery({ queryKey: ["balances", kind, q], queryFn: () => api<any[]>(`/stock/balances?kind=${kind}&q=${encodeURIComponent(q)}`) });
  const low = useQuery({ queryKey: ["low"], queryFn: () => api<any[]>("/stock/low") });
  const wh = useWh();
  const locs = allLocs(wh.data);
  const [op, setOp] = useState({ type: "receipts", itemId: "", locationId: "", toLocationId: "", qty: "", comment: "" });
  const [msg, setMsg] = useState("");
  const mats = useQuery({ queryKey: ["materials"], queryFn: () => api<any[]>("/materials") });
  const run = useMutation({
    mutationFn: () => {
      const body: any = { qty: Number(op.qty), comment: op.comment || undefined };
      if (kind === "material") body.materialId = op.itemId; else body.variantId = op.itemId;
      if (op.type === "transfers") { body.fromLocationId = op.locationId; body.toLocationId = op.toLocationId; } else body.locationId = op.locationId;
      return api(`/stock/${op.type}`, { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: () => { setMsg(t("done")); setOp({ ...op, qty: "", comment: "" }); qc.invalidateQueries({ queryKey: ["balances"] }); qc.invalidateQueries({ queryKey: ["low"] }); qc.invalidateQueries({ queryKey: ["moves"] }); },
    onError: (e: Error) => setMsg(t("error") + " " + e.message),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); setMsg(""); run.mutate(); };
  return (
    <div>
      <h1>{t("stockBalances")}</h1>
      {!!low.data?.length && <div className="err">{t("lowStock")}: {low.data.map((m) => `${m.code} (${m.qty}/${m.min_stock})`).join(", ")}</div>}
      <p>
        <select value={kind} onChange={(e) => { setKind(e.target.value as any); setOp({ ...op, itemId: "" }); }}>
          <option value="material">{t("rawMaterials")}</option><option value="variant">{t("finishedGoods")}</option>
        </select>{" "}
        <input placeholder={t("search")} value={q} onChange={(e) => setQ(e.target.value)} />
      </p>
      <table>
        <thead><tr>{kind === "material"
          ? <><th>{t("code")}</th><th>{t("name")}</th><th>{t("unit")}</th><th>{t("qty")}</th><th>{t("minStock")}</th></>
          : <><th>{t("models")}</th><th>SKU</th><th>{t("qty")}</th><th>{t("reserved")}</th><th>{t("available")}</th></>}</tr></thead>
        <tbody>{rows.data?.map((r) => kind === "material"
          ? <tr key={r.id}><td>{r.code}</td><td>{r.name}</td><td>{r.unit}</td><td className="num">{r.qty}</td><td className="num">{r.min_stock}</td></tr>
          : <tr key={r.id}><td>{r.model_code} {r.model_name}</td><td>{r.sku}</td><td className="num">{r.qty}</td><td className="num">{r.reserved}</td><td className="num">{r.qty - r.reserved}</td></tr>)}</tbody>
      </table>
      {can("warehouse.write") && (
        <form className="inline" onSubmit={submit}>
          <h2>{t("receipt")} / {t("issue")} / {t("transfer")} / {t("writeoff")}</h2>
          <select value={op.type} onChange={(e) => setOp({ ...op, type: e.target.value })}>
            <option value="receipts">{t("receipt")}</option><option value="issues">{t("issue")}</option>
            <option value="transfers">{t("transfer")}</option><option value="writeoffs">{t("writeoff")}</option>
          </select>
          {kind === "material"
            ? <select required value={op.itemId} onChange={(e) => setOp({ ...op, itemId: e.target.value })}><option value="">{t("material")}</option>{mats.data?.map((m) => <option key={m.id} value={m.id}>{m.code} {m.name}</option>)}</select>
            : <input required placeholder="variant id (scan)" value={op.itemId} onChange={(e) => setOp({ ...op, itemId: e.target.value })} />}
          <select required value={op.locationId} onChange={(e) => setOp({ ...op, locationId: e.target.value })}><option value="">{op.type === "transfers" ? t("fromLoc") : t("location")}</option>{locs.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</select>
          {op.type === "transfers" && <select required value={op.toLocationId} onChange={(e) => setOp({ ...op, toLocationId: e.target.value })}><option value="">{t("toLoc")}</option>{locs.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</select>}
          <input required type="number" min="0.001" step="0.001" placeholder={t("qty")} value={op.qty} onChange={(e) => setOp({ ...op, qty: e.target.value })} />
          <input required={op.type === "writeoffs"} placeholder={t("reason")} value={op.comment} onChange={(e) => setOp({ ...op, comment: e.target.value })} />
          <button type="submit">OK</button> <span className={run.isError ? "err" : ""}>{msg}</span>
        </form>
      )}
    </div>
  );
}

export function MovesPage() {
  const { t } = useUi();
  const { can } = useMe();
  const [diff, setDiff] = useState<number | null>(null);
  const moves = useQuery({ queryKey: ["moves"], queryFn: () => api<any[]>("/stock/movements?limit=200") });
  const rec = useMutation({
    mutationFn: (fix: boolean) => api<{ discrepancies: any[] }>("/stock/reconcile", { method: "POST", body: JSON.stringify({ fix }) }),
    onSuccess: (r) => setDiff(r.discrepancies.length),
  });
  return (
    <div>
      <h1>{t("stockMoves")}</h1>
      {can("warehouse.manage") && <p><button onClick={() => rec.mutate(false)}>{t("reconcile")}</button> {diff !== null && <b>{t("diffs")}: {diff}</b>} {!!diff && <button onClick={() => rec.mutate(true)}>Fix</button>}</p>}
      <table>
        <thead><tr><th>#</th><th>{t("date")}</th><th>{t("type")}</th><th>{t("name")}</th><th>{t("lot")}</th><th>{t("location")}</th><th>{t("qty")}</th><th>{t("users")}</th></tr></thead>
        <tbody>{moves.data?.map((m) => <tr key={m.id}><td>{m.id}</td><td>{new Date(m.created_at).toLocaleString()}</td><td>{m.type}</td><td>{m.item} {m.item_name}</td><td>{m.lot_number ?? ""}</td><td>{m.warehouse} · {m.location}</td><td className="num">{m.qty > 0 ? "+" : ""}{m.qty}</td><td>{m.user_name ?? ""}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

export function LotsPage() {
  const { t } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const lots = useQuery({ queryKey: ["lots"], queryFn: () => api<any[]>("/fabric-lots") });
  const mats = useQuery({ queryKey: ["materials"], queryFn: () => api<any[]>("/materials") });
  const wh = useWh();
  const [open, setOpen] = useState<string | null>(null);
  const rolls = useQuery({ queryKey: ["rolls", open], enabled: !!open, queryFn: () => api<any[]>(`/fabric-lots/${open}/rolls`) });
  const [f, setF] = useState({ materialId: "", locationId: "", lotNumber: "", colorName: "", shade: "", widthCm: "", densityGsm: "", supplier: "", rolls: "" });
  const add = useMutation({
    mutationFn: () => api("/fabric-lots", { method: "POST", body: JSON.stringify({
      materialId: f.materialId, locationId: f.locationId, lotNumber: f.lotNumber, colorName: f.colorName || undefined, shade: f.shade || undefined,
      widthCm: Number(f.widthCm) || undefined, densityGsm: Number(f.densityGsm) || undefined, supplier: f.supplier || undefined,
      rolls: f.rolls.split(/[\s,;]+/).filter(Boolean).map(Number) }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["lots"] }); qc.invalidateQueries({ queryKey: ["balances"] }); setF({ ...f, lotNumber: "", rolls: "" }); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); add.mutate(); };
  return (
    <div>
      <h1>{t("fabricLots")}</h1>
      <table>
        <thead><tr><th>{t("lot")}</th><th>{t("material")}</th><th>{t("color")}</th><th>{t("shade")}</th><th>{t("rolls")}</th><th>{t("qty")}</th></tr></thead>
        <tbody>{lots.data?.map((l) => (<>
          <tr key={l.id} onClick={() => setOpen(open === l.id ? null : l.id)} style={{ cursor: "pointer" }}>
            <td>{l.lot_number}</td><td>{l.material_code} {l.material_name}</td><td>{l.color_name}</td><td>{l.shade}</td><td className="num">{l.rolls}</td><td className="num">{l.remaining} {l.unit}</td></tr>
          {open === l.id && <tr key={l.id + "r"}><td colSpan={6}>{rolls.data?.map((r) => <span key={r.id} className="chip">#{r.roll_no}: {r.qty_remaining}/{r.qty_initial} · {r.barcode}</span>)}</td></tr>}
        </>))}</tbody>
      </table>
      {can("warehouse.write") && (
        <form className="inline" onSubmit={submit}>
          <h2>{t("receipt")}: {t("fabricLots")}</h2>
          <select required value={f.materialId} onChange={(e) => setF({ ...f, materialId: e.target.value })}><option value="">{t("material")}</option>{mats.data?.filter((m) => m.type === "fabric").map((m) => <option key={m.id} value={m.id}>{m.code} {m.name}</option>)}</select>
          <select required value={f.locationId} onChange={(e) => setF({ ...f, locationId: e.target.value })}><option value="">{t("location")}</option>{allLocs(wh.data).map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</select>
          <input required placeholder={t("lot")} value={f.lotNumber} onChange={(e) => setF({ ...f, lotNumber: e.target.value })} />
          <input placeholder={t("color")} value={f.colorName} onChange={(e) => setF({ ...f, colorName: e.target.value })} />
          <input placeholder={t("shade")} value={f.shade} onChange={(e) => setF({ ...f, shade: e.target.value })} />
          <input type="number" placeholder={t("width")} value={f.widthCm} onChange={(e) => setF({ ...f, widthCm: e.target.value })} />
          <input type="number" placeholder={t("density")} value={f.densityGsm} onChange={(e) => setF({ ...f, densityGsm: e.target.value })} />
          <input required placeholder={t("rollsList")} value={f.rolls} onChange={(e) => setF({ ...f, rolls: e.target.value })} />
          <button type="submit">{t("add")}</button>{add.isError && <span className="err">{t("error")}</span>}
        </form>
      )}
    </div>
  );
}

export function InventoryPage() {
  const { t } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["inv"], queryFn: () => api<any[]>("/inventory") });
  const wh = useWh();
  const [whId, setWhId] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const det = useQuery({ queryKey: ["inv", open], enabled: !!open, queryFn: () => api<any>(`/inventory/${open}`) });
  const start = useMutation({ mutationFn: () => api<{ id: string }>("/inventory", { method: "POST", body: JSON.stringify({ warehouseId: whId }) }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["inv"] }); setOpen(r.id); } });
  const save = useMutation({
    mutationFn: () => api(`/inventory/${open}/lines`, { method: "PUT", body: JSON.stringify({ counts: Object.entries(counts).filter(([, v]) => v !== "").map(([lineId, v]) => ({ lineId, counted: Number(v) })) }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inv"] }) });
  const close = useMutation({ mutationFn: async () => { await save.mutateAsync(); return api(`/inventory/${open}/close`, { method: "POST" }); },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["inv"] }); qc.invalidateQueries({ queryKey: ["balances"] }); setCounts({}); } });
  return (
    <div>
      <h1>{t("inventory")}</h1>
      <table>
        <thead><tr><th>{t("date")}</th><th>{t("warehouse")}</th><th>{t("status")}</th><th>{t("counted")}</th></tr></thead>
        <tbody>{list.data?.map((s) => <tr key={s.id} onClick={() => { setOpen(s.id); setCounts({}); }} style={{ cursor: "pointer" }}><td>{new Date(s.created_at).toLocaleString()}</td><td>{s.warehouse}</td><td>{s.status}</td><td>{s.counted}/{s.lines}</td></tr>)}</tbody>
      </table>
      {can("warehouse.inventory") && <p><select value={whId} onChange={(e) => setWhId(e.target.value)}><option value="">{t("warehouse")}</option>{wh.data?.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select> <button disabled={!whId} onClick={() => start.mutate()}>{t("start")}</button></p>}
      {det.data && open && (
        <div>
          <h2>{det.data.status}</h2>
          <table>
            <thead><tr><th>{t("name")}</th><th>{t("lot")}</th><th>{t("location")}</th><th>{t("system")}</th><th>{t("counted")}</th></tr></thead>
            <tbody>{det.data.lines.map((l: any) => <tr key={l.id}><td>{l.item} {l.item_name}</td><td>{l.lot_number ?? ""}</td><td>{l.location}</td><td className="num">{l.qty_system}</td>
              <td>{det.data.status === "open" ? <input type="number" step="0.001" style={{ width: 90 }} defaultValue={l.qty_counted ?? ""} onChange={(e) => setCounts({ ...counts, [l.id]: e.target.value })} /> : l.qty_counted}</td></tr>)}</tbody>
          </table>
          {det.data.status === "open" && can("warehouse.inventory") && <p><button onClick={() => save.mutate()}>{t("save")}</button> <button onClick={() => close.mutate()}>{t("closeIt")}</button></p>}
        </div>
      )}
    </div>
  );
}
