import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useMe, useUi } from "../state";
import type { Key } from "../i18n";
import { ExportConsumption } from "./ExportConsumption";
import { ExportQuotes } from "./ExportQuotes";
import { ExportPurchases } from "./ExportPurchases";
import { ExportSamples } from "./ExportSamples";
import { ExportInspections } from "./ExportInspections";
import { ExportProduction, ExportShipments } from "./ExportProduction";
import { ExportLogistics } from "./ExportLogistics";

interface Row { id: string; number: string; brand: string | null; collection: string | null; status: string; target_exfactory: string | null; client_name: string; models: number; qty: number }
const SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "2XL", "3XL"];
/** Размеры модели «размер: количество»: детские 122–158 по возрастанию, взрослые XS–3XL по порядку. */
function sizesText(sq: Record<string, number>): string {
  const keys = Object.keys(sq);
  if (!keys.length) return "—";
  const num = keys.every((k) => !Number.isNaN(Number(k)));
  const sorted = num ? keys.sort((a, b) => Number(a) - Number(b)) : keys.sort((a, b) => SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b));
  return sorted.map((k) => `${k}: ${sq[k]}`).join(" · ");
}
/** Расход полотна на изделие, заданный вручную (для моделей без выкройки). */
const manualKg = (m: Model): number => Number(m.spec?.kg_per_piece_top) || 0;

interface Model { id: string; code: string; qty: number; size_qty: Record<string, number>; spec?: Record<string, unknown>; ex_factory: string | null; pack_size: string | null;
  tee_pattern: string | null; skirt_pattern: string | null; fabric_top: string | null; fabric_bottom: string | null; fabric_rib: string | null }
interface Order { id: string; number: string; client_name: string; brand: string | null; collection: string | null; status: string; target_exfactory: string | null; version: number; notes: string | null; models: Model[] }
interface Preview { dryRun: boolean; totalQty: number; warnings: string[]; models: { code: string; qty: number; tee: string | null; skirt: string | null; top: string | null; bottom: string | null; rib: string | null; exFactory: string | null }[] }

const fmtDate = (d: string | null) => (d ? d.slice(0, 10) : "—");
const toB64 = (f: File) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(",")[1] ?? "");
  r.onerror = () => rej(r.error);
  r.readAsDataURL(f);
});

/** Список экспортных заказов + создание. */
export function ExportOrdersPage() {
  const { t } = useUi();
  const { can } = useMe();
  const nav = useNavigate();
  const list = useQuery({ queryKey: ["export-orders"], queryFn: () => api<Row[]>("/export-orders"), refetchInterval: 15000 });
  const clients = useQuery({ queryKey: ["clients", "pick"], queryFn: () => api<{ items: { id: string; name: string }[] }>("/clients?limit=100"), enabled: can("exportorders.create") });
  const [f, setF] = useState({ clientId: "", brand: "", collection: "", targetExfactory: "" });
  const create = useMutation({
    mutationFn: () => api<{ id: string }>("/export-orders", { method: "POST", body: JSON.stringify({ clientId: f.clientId, brand: f.brand || null, collection: f.collection || null, targetExfactory: f.targetExfactory || null }) }),
    onSuccess: (r) => nav(`/export-orders/${r.id}`),
  });
  return (
    <div>
      <h1>{t("exportOrders")}</h1>
      {can("exportorders.create") && (
        <div className="toolbar">
          <select value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })}>
            <option value="">{t("client")}…</option>
            {clients.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input placeholder={t("brand")} value={f.brand} onChange={(e) => setF({ ...f, brand: e.target.value })} />
          <input placeholder={t("collection")} value={f.collection} onChange={(e) => setF({ ...f, collection: e.target.value })} />
          <input type="date" title={t("targetExFactory")} value={f.targetExfactory} onChange={(e) => setF({ ...f, targetExfactory: e.target.value })} />
          <button disabled={!f.clientId || create.isPending} onClick={() => create.mutate()}>{t("create")}</button>
          {create.isError && <span className="err">{t("error")}</span>}
        </div>
      )}
      <table>
        <thead><tr><th>№</th><th>{t("client")}</th><th>{t("brand")}</th><th>{t("collection")}</th><th>{t("models")}</th><th>{t("qty")}</th><th>{t("targetExFactory")}</th><th>{t("status")}</th></tr></thead>
        <tbody>{list.data?.map((o) => (
          <tr key={o.id}>
            <td><Link to={`/export-orders/${o.id}`}>{o.number}</Link></td><td>{o.client_name}</td><td>{o.brand}</td><td>{o.collection}</td>
            <td>{o.models}</td><td>{o.qty.toLocaleString()}</td><td>{fmtDate(o.target_exfactory)}</td><td>{t(`xs_${o.status}` as Key)}</td>
          </tr>))}</tbody>
      </table>
    </div>
  );
}

/** Карточка заказа: модели, импорт файла Status с предпросмотром. */
export function ExportOrderCard() {
  const { id } = useParams();
  const { t } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const o = useQuery({ queryKey: ["export-order", id], queryFn: () => api<Order>(`/export-orders/${id}`), refetchInterval: 10000 });
  const [file, setFile] = useState<File | null>(null);
  const [qpm, setQpm] = useState("3500");
  const [reserve, setReserve] = useState(false);
  const [prev, setPrev] = useState<Preview | null>(null);
  const body = async (dryRun: boolean) => JSON.stringify({ xlsxBase64: await toB64(file!), dryRun, useReserve: reserve, ...(qpm ? { qtyPerModel: Number(qpm) } : {}) });
  const preview = useMutation({ mutationFn: async () => api<Preview>(`/export-orders/${id}/import-status`, { method: "POST", body: await body(true) }), onSuccess: setPrev });
  const apply = useMutation({
    mutationFn: async () => api<Preview>(`/export-orders/${id}/import-status`, { method: "POST", body: await body(false) }),
    onSuccess: () => { setPrev(null); setFile(null); qc.invalidateQueries({ queryKey: ["export-order", id] }); qc.invalidateQueries({ queryKey: ["export-fabrics"] }); },
  });
  if (!o.data) return <div className="muted">…</div>;
  const d = o.data;
  const total = d.models.reduce((a, m) => a + m.qty, 0);
  const editable = ["draft", "calculated"].includes(d.status);
  return (
    <div>
      <p><Link to="/export-orders">← {t("exportOrders")}</Link></p>
      <h1>{d.number} · {d.client_name}</h1>
      <p className="muted">{d.brand} {d.collection} · {t("targetExFactory")}: {fmtDate(d.target_exfactory)} · {t(`xs_${d.status}` as Key)} · {t("qty")}: {total.toLocaleString()}</p>
      {can("exportorders.create") && editable && (
        <div className="toolbar">
          <input type="file" accept=".xlsx" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPrev(null); }} />
          <label>{t("qtyPerModel")} <input style={{ width: 90 }} type="number" min={1} value={qpm} onChange={(e) => setQpm(e.target.value)} /></label>
          <label><input type="checkbox" checked={reserve} onChange={(e) => setReserve(e.target.checked)} /> {t("useReserve")}</label>
          <button disabled={!file || preview.isPending} onClick={() => preview.mutate()}>{t("importPreview")}</button>
          {(preview.isError || apply.isError) && <span className="err">{((preview.error ?? apply.error) as Error)?.message || t("error")}</span>}
        </div>
      )}
      {prev && (
        <div>
          <h2>{t("importPreview")}: {prev.models.length} {t("models").toLowerCase()}, {prev.totalQty.toLocaleString()} {t("pcs")}</h2>
          {prev.warnings.map((w, i) => <div key={i} className="err">{w}</div>)}
          <table>
            <thead><tr><th>{t("model")}</th><th>{t("qty")}</th><th>{t("tee")}</th><th>{t("skirt")}</th><th>{t("fabricTop")}</th><th>{t("fabricBottom")}</th><th>{t("fabricRib")}</th></tr></thead>
            <tbody>{prev.models.map((m) => <tr key={m.code}><td>{m.code}</td><td>{m.qty}</td><td>{m.tee ?? "—"}</td><td>{m.skirt ?? "—"}</td><td>{m.top}</td><td>{m.bottom}</td><td>{m.rib}</td></tr>)}</tbody>
          </table>
          <button disabled={apply.isPending} onClick={() => apply.mutate()}>{t("confirmImport")}</button>
        </div>
      )}
      <h2>{t("models")}</h2>
      <table>
        <thead><tr><th>{t("model")}</th><th>{t("qty")}</th><th>{t("sizes")}</th><th>{t("tee")}</th><th>{t("skirt")}</th><th>{t("fabricTop")}</th><th>{t("fabricBottom")}</th><th>{t("fabricRib")}</th><th>{t("exFactory")}</th></tr></thead>
        <tbody>{d.models.map((m) => (
          <tr key={m.id}>
            <td>{m.code}</td><td>{m.qty.toLocaleString()}</td>
            <td className="muted">{sizesText(m.size_qty)}</td>
            {manualKg(m) ? <td colSpan={2} className="muted">{manualKg(m)} кг/шт ({String(m.spec?.kind ?? "")})</td> : <><td>{m.tee_pattern ?? "—"}</td><td>{m.skirt_pattern ?? "—"}</td></>}<td>{m.fabric_top}</td><td>{m.fabric_bottom}</td><td>{m.fabric_rib}</td><td>{fmtDate(m.ex_factory)}</td>
          </tr>))}</tbody>
      </table>
      {can("exportorders.view") && d.models.length > 0 && <ExportConsumption orderId={d.id} />}
      {can("exportquotes.view") && d.models.length > 0 && <ExportQuotes orderId={d.id} />}
      {can("exportpurchases.view") && d.models.length > 0 && <ExportPurchases orderId={d.id} />}
      {can("exportsamples.view") && d.models.length > 0 && <ExportSamples orderId={d.id} />}
      {can("exportinspections.view") && d.models.length > 0 && <ExportInspections orderId={d.id} models={d.models.map((m) => ({ id: m.id, code: m.code, qty: m.qty }))} />}
      {can("exportproduction.view") && d.models.length > 0 && <ExportProduction orderId={d.id} />}
      {can("exportlogistics.view") && d.models.length > 0 && <ExportLogistics orderId={d.id} />}
      {can("exportshipments.view") && d.models.length > 0 && <ExportShipments orderId={d.id} />}
    </div>
  );
}
