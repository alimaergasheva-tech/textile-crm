import { FormEvent, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useMe, useUi } from "../state";
import { toMinor } from "../i18n";

interface PL { id: string; name: string; price_type: string; currency: "UZS" | "USD"; items: number }
interface Row { model_id: string; code: string; name: string; amount: number | null }

export function PricingPage() {
  const { t } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const lists = useQuery({ queryKey: ["price-lists"], queryFn: () => api<PL[]>("/price-lists") });
  const [sel, setSel] = useState("");
  const rows = useQuery({ queryKey: ["prices", sel], queryFn: () => api<Row[]>(`/price-lists/${sel}/prices`), enabled: !!sel });
  const [vals, setVals] = useState<Record<string, string>>({});
  const [f, setF] = useState({ name: "", priceType: "wholesale", currency: "UZS" });
  useEffect(() => { if (!sel && lists.data?.[0]) setSel(lists.data[0].id); }, [lists.data, sel]);
  useEffect(() => { setVals(Object.fromEntries((rows.data ?? []).map((r) => [r.model_id, r.amount === null ? "" : String(r.amount / 100)]))); }, [rows.data]);
  const add = useMutation({
    mutationFn: () => api("/price-lists", { method: "POST", body: JSON.stringify(f) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["price-lists"] }); setF({ ...f, name: "" }); },
  });
  const save = useMutation({
    mutationFn: () => api(`/price-lists/${sel}/prices`, { method: "PUT", body: JSON.stringify({
      prices: Object.entries(vals).map(([modelId, v]) => ({ modelId, amount: v === "" ? null : toMinor(v) })) }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["prices", sel] }); qc.invalidateQueries({ queryKey: ["price-lists"] }); },
  });
  const cur = lists.data?.find((l) => l.id === sel);
  const submit = (e: FormEvent) => { e.preventDefault(); add.mutate(); };
  const edit = can("pricing.edit");
  return (
    <div>
      <h1>{t("pricing")}</h1>
      <select value={sel} onChange={(e) => setSel(e.target.value)}>
        {lists.data?.map((l) => <option key={l.id} value={l.id}>{l.name} · {l.price_type} · {l.currency}</option>)}
      </select>
      {cur && (<>
        <table>
          <thead><tr><th>{t("code")}</th><th>{t("name")}</th><th>{t("price")}, {cur.currency}</th></tr></thead>
          <tbody>{rows.data?.map((r) => (
            <tr key={r.model_id}><td>{r.code}</td><td>{r.name}</td>
              <td><input disabled={!edit} type="number" min="0" step="0.01" value={vals[r.model_id] ?? ""} onChange={(e) => setVals({ ...vals, [r.model_id]: e.target.value })} /></td></tr>))}</tbody>
        </table>
        {edit && <button onClick={() => save.mutate()}>{t("save")}</button>}
        {save.isError && <span className="err">{t("error")}</span>}
      </>)}
      {edit && (
        <form className="inline" onSubmit={submit}>
          <h2>{t("newPriceList")}</h2>
          <input required placeholder={t("name")} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <select value={f.priceType} onChange={(e) => setF({ ...f, priceType: e.target.value })}>{["retail", "wholesale", "large_wholesale"].map((x) => <option key={x}>{x}</option>)}</select>
          <select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}><option>UZS</option><option>USD</option></select>
          <button type="submit">{t("add")}</button>
          {add.isError && <span className="err">{t("error")}</span>}
        </form>
      )}
    </div>
  );
}
