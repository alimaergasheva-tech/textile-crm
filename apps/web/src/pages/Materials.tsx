import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useMe, useUi } from "../state";

interface M { id: string; code: string; name: string; type: string; unit: string; min_stock: number; is_active: boolean }
export const MATERIAL_TYPES = ["fabric", "lining", "thread", "trim", "packaging"];
export const UNITS = ["m", "kg", "pcs", "roll", "set", "spool"];

export function MaterialsPage() {
  const { t } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["materials"], queryFn: () => api<M[]>("/materials") });
  const [f, setF] = useState({ code: "", name: "", type: "fabric", unit: "m", minStock: "0" });
  const add = useMutation({
    mutationFn: () => api("/materials", { method: "POST", body: JSON.stringify({ ...f, minStock: Number(f.minStock) || 0 }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["materials"] }); setF({ ...f, code: "", name: "" }); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); add.mutate(); };
  return (
    <div>
      <h1>{t("materials")}</h1>
      <table>
        <thead><tr><th>{t("code")}</th><th>{t("name")}</th><th>{t("type")}</th><th>{t("unit")}</th><th>{t("minStock")}</th></tr></thead>
        <tbody>{list.data?.map((m) => <tr key={m.id}><td>{m.code}</td><td>{m.name}</td><td>{m.type}</td><td>{m.unit}</td><td className="num">{m.min_stock}</td></tr>)}</tbody>
      </table>
      {can("materials.create") && (
        <form className="inline" onSubmit={submit}>
          <h2>{t("newMaterial")}</h2>
          <input required placeholder={t("code")} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
          <input required placeholder={t("name")} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{MATERIAL_TYPES.map((x) => <option key={x}>{x}</option>)}</select>
          <select value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })}>{UNITS.map((x) => <option key={x}>{x}</option>)}</select>
          <input type="number" min="0" step="0.001" placeholder={t("minStock")} value={f.minStock} onChange={(e) => setF({ ...f, minStock: e.target.value })} />
          <button type="submit">{t("add")}</button>
          {add.isError && <span className="err">{t("error")}</span>}
        </form>
      )}
    </div>
  );
}
