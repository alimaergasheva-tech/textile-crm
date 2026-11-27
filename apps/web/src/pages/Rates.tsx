import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useMe, useUi } from "../state";

interface Rate { id: string; valid_from: string; uzs_per_usd: number }

export function RatesPage() {
  const { t } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const rates = useQuery({ queryKey: ["rates"], queryFn: () => api<Rate[]>("/exchange-rates") });
  const [f, setF] = useState({ validFrom: new Date().toISOString().slice(0, 10), uzsPerUsd: "" });
  const save = useMutation({
    mutationFn: () => api("/exchange-rates", { method: "PUT",
      body: JSON.stringify({ validFrom: f.validFrom, uzsPerUsd: Number(f.uzsPerUsd) }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["rates"] }); setF({ ...f, uzsPerUsd: "" }); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(); };
  return (
    <div>
      <h1>{t("rates")}</h1>
      <table>
        <thead><tr><th>{t("date")}</th><th>{t("rate")}</th></tr></thead>
        <tbody>{rates.data?.map((r) => <tr key={r.id}><td>{r.valid_from}</td><td>{r.uzs_per_usd.toLocaleString()}</td></tr>)}</tbody>
      </table>
      {can("settings.manage") && (
        <form className="inline" onSubmit={submit}>
          <input type="date" required value={f.validFrom} onChange={(e) => setF({ ...f, validFrom: e.target.value })} />
          <input type="number" required min="1" step="0.01" placeholder={t("rate")} value={f.uzsPerUsd}
            onChange={(e) => setF({ ...f, uzsPerUsd: e.target.value })} />
          <button type="submit">{t("save")}</button>
          {save.isError && <span className="err">{t("error")}</span>}
        </form>
      )}
    </div>
  );
}
