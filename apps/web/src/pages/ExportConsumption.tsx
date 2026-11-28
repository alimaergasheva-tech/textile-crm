import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useMe, useUi } from "../state";

interface Part { part: "top" | "bottom" | "rib"; fabricName: string | null; gsm: number | null; pattern: string | null; kg: number }
interface Trims { cordM: number; tipsPcs: number; elastic25M: number; elastic35M: number; bowM: number; ttSmall: number; ttLarge: number; hangtag: number; polybag: number; cartons: number }
interface Result {
  version: number; params: Record<string, number>; warnings: string[]; trims: Trims;
  totals: { fabricKg: number; fabricCostUsd: number; trimsCostUsd: number };
  fabrics: { fabricId: string; name: string; gsm: number; kind: string; kg: number; kgOrder: number; meters: number; priceUsdKg: number; costUsd: number; models: string[] }[];
  models: { id: string; code: string; qty: number; tee: string | null; skirt: string | null; parts: Part[]; trims: Trims }[];
}
const PARAM_LABELS: [string, string, boolean][] = [
  ["wasteMain", "paramWasteMain", true], ["wasteRib", "paramWasteRib", true], ["ribStripCm", "paramRibStrip", false], ["sleeveAllowanceGkt11", "paramSleeve", true],
  ["fabricWidthM", "paramFabricWidth", false], ["fabricOrderReserve", "paramFabricReserve", true], ["trimsReserve", "paramTrimsReserve", true],
  ["bowCordCm", "paramBow", false], ["unitsPerCarton", "paramCarton", false],
  ["cmtUsd", "paramCmt", false], ["otherPerSetUsd", "paramOther", false], ["marginPct", "paramMargin", true], ["logisticsUsd", "paramLogistics", false],
];
const n = (x: number, d = 0) => x.toLocaleString(undefined, { maximumFractionDigits: d });

/** Расход полотна и фурнитуры по заказу: параметры, сводка для заказа Узтекс / Eren, расход по моделям. */
export function ExportConsumption({ orderId }: { orderId: string }) {
  const { t } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["export-consumption", orderId], queryFn: () => api<Result>(`/export-orders/${orderId}/consumption`) });
  const [form, setForm] = useState<Record<string, string>>({});
  useEffect(() => { if (q.data) setForm(Object.fromEntries(Object.entries(q.data.params).map(([k, v]) => [k, String(v)]))); }, [q.data?.version]);
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, number> = { version: q.data!.version };
      for (const [k, , pct] of PARAM_LABELS) { const v = Number(form[k]); if (Number.isFinite(v)) body[k] = pct ? v : v; }
      return api(`/export-orders/${orderId}/calc-params`, { method: "PUT", body: JSON.stringify(body) });
    },
    onSettled: () => { qc.invalidateQueries({ queryKey: ["export-consumption", orderId] }); qc.invalidateQueries({ queryKey: ["export-order", orderId] }); qc.invalidateQueries({ queryKey: ["export-costing", orderId] }); },
  });
  if (q.isLoading) return <div className="muted">…</div>;
  if (!q.data) return <div className="err">{t("error")}</div>;
  const d = q.data;
  const partName = (p: Part["part"]) => t(p === "top" ? "partTop" : p === "bottom" ? "partBottom" : "partRib");
  return (
    <div>
      <h2>{t("consumption")}</h2>
      {d.warnings.map((w, i) => <div key={i} className="err">⚠ {w}</div>)}
      <h3>{t("calcParams")}</h3>
      <div className="toolbar">
        {PARAM_LABELS.map(([k, label, pct]) => (
          <label key={k}>{t(label as any)}{pct ? " (0–1)" : ""} <input style={{ width: 80 }} disabled={!can("exportorders.edit")} value={form[k] ?? ""} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></label>
        ))}
        {can("exportorders.edit") && <button disabled={save.isPending} onClick={() => save.mutate()}>{t("save")}</button>}
        {save.isError && <span className="err">{t("conflictMsg")}</span>}
      </div>
      <h3>{t("fabricOrder")} — {n(d.totals.fabricKg, 1)} {t("kg")} · ${n(d.totals.fabricCostUsd)}</h3>
      <table>
        <thead><tr><th>{t("name")}</th><th>g/m²</th><th>{t("kg")}</th><th>{t("kgOrder")}</th><th>{t("meters")}</th><th>$/{t("kg")}</th><th>$</th><th>{t("models")}</th></tr></thead>
        <tbody>{d.fabrics.map((f) => (
          <tr key={f.fabricId}><td>{f.name}</td><td>{f.gsm}</td><td>{n(f.kg, 1)}</td><td><b>{n(f.kgOrder, 1)}</b></td><td>{n(f.meters)}</td><td>{f.priceUsdKg}</td><td>{n(f.costUsd)}</td><td className="muted">{f.models.map((m) => m.replace("SET44.", "")).join(", ")}</td></tr>))}</tbody>
      </table>
      <h3>{t("trimsOrder")} — ${n(d.totals.trimsCostUsd)}</h3>
      <table>
        <thead><tr><th>{t("name")}</th><th>{t("qty")}</th></tr></thead>
        <tbody>{([["cordM", "trimCord", "m"], ["tipsPcs", "trimTips", ""], ["elastic25M", "trimElastic25", "m"], ["elastic35M", "trimElastic35", "m"], ["bowM", "trimBow", "m"],
          ["ttSmall", "trimTtSmall", ""], ["ttLarge", "trimTtLarge", ""], ["hangtag", "trimHangtag", ""], ["polybag", "trimPolybag", ""], ["cartons", "trimCarton", ""]] as const)
          .map(([k, label, u]) => <tr key={k}><td>{t(label as any)}</td><td>{n(d.trims[k])} {u}</td></tr>)}</tbody>
      </table>
      <h3>{t("byModels")}</h3>
      <table>
        <thead><tr><th>{t("model")}</th><th>{t("qty")}</th><th>{t("partTop")}, {t("kg")}</th><th>{t("partBottom")}, {t("kg")}</th><th>{t("partRib")}, {t("kg")}</th><th>{t("trimCord")}/{t("trimBow")}, m</th><th>{t("trimElastic25")}/35, m</th></tr></thead>
        <tbody>{d.models.map((m) => {
          const g = (p: Part["part"]) => m.parts.find((x) => x.part === p);
          return (
            <tr key={m.id}>
              <td>{m.code}<div className="muted">{m.tee ?? "—"} / {m.skirt ?? "—"}</div></td><td>{n(m.qty)}</td>
              <td>{g("top") ? n(g("top")!.kg, 1) : "—"}<div className="muted">{g("top")?.fabricName}</div></td>
              <td>{g("bottom") ? n(g("bottom")!.kg, 1) : "—"}<div className="muted">{g("bottom")?.fabricName}</div></td>
              <td>{g("rib") ? n(g("rib")!.kg, 1) : "—"}</td>
              <td>{n(m.trims.cordM + m.trims.bowM)}</td><td>{n(m.trims.elastic25M + m.trims.elastic35M)}</td>
            </tr>);
        })}</tbody>
      </table>
      <p className="muted">{t("consumptionNote")}</p>
    </div>
  );
}
