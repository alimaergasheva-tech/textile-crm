import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useMe, useUi } from "../state";

interface F { id: string; code: string; name: string; composition: string | null; gsm: number; kind: string; is_aop: boolean; price_usd_kg: string; supplier: string | null; version: number }
interface A { id: string; code: string; name: string; unit: string; price_usd: string; supplier: string | null; version: number }

/** Редактор цены/поставщика одной строки справочника (оптимистичная блокировка по version). */
function PriceCell({ path, row, field, manage }: { path: string; row: { id: string; version: number } & Record<string, any>; field: string; manage: boolean }) {
  const { t } = useUi();
  const qc = useQueryClient();
  const [v, setV] = useState(String(row[field] ?? ""));
  const save = useMutation({
    mutationFn: () => api(`${path}/${row.id}`, { method: "PATCH", body: JSON.stringify({ [field === "price_usd_kg" ? "priceUsdKg" : field === "price_usd" ? "priceUsd" : field]: field.startsWith("price") ? Number(v) : v, version: row.version }) }),
    onSettled: () => qc.invalidateQueries(),
  });
  if (!manage) return <>{row[field]}</>;
  return <><input style={{ width: 100 }} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== String(row[field] ?? "") && save.mutate()} />{save.isError && <span className="err"> {t("conflictMsg")}</span>}</>;
}

/** Полотна (состав, плотность, цена за кг) и фурнитура (цена за единицу). */
export function ExportCatalogPage() {
  const { t } = useUi();
  const { can } = useMe();
  const manage = can("patterns.manage");
  const fabrics = useQuery({ queryKey: ["export-fabrics"], queryFn: () => api<F[]>("/export-fabrics") });
  const acc = useQuery({ queryKey: ["export-accessories"], queryFn: () => api<A[]>("/export-accessories") });
  return (
    <div>
      <h1>{t("exportFabrics")}</h1>
      <table>
        <thead><tr><th>{t("code")}</th><th>{t("name")}</th><th>{t("composition")}</th><th>g/m²</th><th>{t("kind")}</th><th>$/{t("kg")}</th><th>{t("supplier")}</th></tr></thead>
        <tbody>{fabrics.data?.map((f) => (
          <tr key={f.id + f.version}><td>{f.code}</td><td>{f.name}{f.is_aop ? " (AOP)" : ""}</td><td>{f.composition}</td><td>{f.gsm}</td><td>{f.kind}</td>
            <td><PriceCell path="/export-fabrics" row={f} field="price_usd_kg" manage={manage} /></td>
            <td><PriceCell path="/export-fabrics" row={f} field="supplier" manage={manage} /></td></tr>))}</tbody>
      </table>
      <h1>{t("exportAccessories")}</h1>
      <table>
        <thead><tr><th>{t("code")}</th><th>{t("name")}</th><th>{t("unit")}</th><th>$</th><th>{t("supplier")}</th></tr></thead>
        <tbody>{acc.data?.map((a) => (
          <tr key={a.id + a.version}><td>{a.code}</td><td>{a.name}</td><td>{a.unit}</td>
            <td><PriceCell path="/export-accessories" row={a} field="price_usd" manage={manage} /></td>
            <td><PriceCell path="/export-accessories" row={a} field="supplier" manage={manage} /></td></tr>))}</tbody>
      </table>
    </div>
  );
}
