import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useMe, useUi } from "../state";

interface P { id: string; code: string; kind: string; measures: number }
interface Detail { code: string; measures: { name: string; tolerance: string | null; vals: Record<string, number> }[] }
interface Imp { dryRun: boolean; patterns: { code: string; kind: string; measures: number }[]; warnings: string[] }
const SIZES = ["122", "128", "134", "140", "146", "152", "158"];
const toB64 = (f: File) => new Promise<string>((res, rej) => {
  const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] ?? ""); r.onerror = () => rej(r.error); r.readAsDataURL(f);
});

/** Выкройки и табели мер (импорт из Excel, просмотр мерок по размерам). */
export function PatternsPage() {
  const { t } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["patterns"], queryFn: () => api<P[]>("/patterns") });
  const [sel, setSel] = useState("");
  const det = useQuery({ queryKey: ["pattern", sel], queryFn: () => api<Detail>(`/patterns/${sel}`), enabled: !!sel });
  const [file, setFile] = useState<File | null>(null);
  const [prev, setPrev] = useState<Imp | null>(null);
  const run = (dryRun: boolean) => async () => api<Imp>("/patterns/import", { method: "POST", body: JSON.stringify({ xlsxBase64: await toB64(file!), dryRun }) });
  const preview = useMutation({ mutationFn: run(true), onSuccess: setPrev });
  const apply = useMutation({ mutationFn: run(false), onSuccess: () => { setPrev(null); setFile(null); qc.invalidateQueries({ queryKey: ["patterns"] }); } });
  return (
    <div>
      <h1>{t("patterns")}</h1>
      {can("patterns.manage") && (
        <div className="toolbar">
          <input type="file" accept=".xlsx" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPrev(null); }} />
          <button disabled={!file || preview.isPending} onClick={() => preview.mutate()}>{t("importPreview")}</button>
          {(preview.isError || apply.isError) && <span className="err">{((preview.error ?? apply.error) as Error)?.message || t("error")}</span>}
        </div>
      )}
      {prev && (
        <div>
          {prev.warnings.map((w, i) => <div key={i} className="err">{w}</div>)}
          <p>{prev.patterns.map((p) => `${p.code} (${p.measures})`).join(", ")}</p>
          <button disabled={apply.isPending} onClick={() => apply.mutate()}>{t("confirmImport")}</button>
        </div>
      )}
      <table>
        <thead><tr><th>{t("pattern")}</th><th>{t("kind")}</th><th>{t("measures")}</th></tr></thead>
        <tbody>{list.data?.map((p) => (
          <tr key={p.id} onClick={() => setSel(p.id)} style={{ cursor: "pointer", fontWeight: p.id === sel ? 600 : 400 }}><td>{p.code}</td><td>{p.kind}</td><td>{p.measures}</td></tr>))}</tbody>
      </table>
      {det.data && (
        <>
          <h2>{det.data.code}</h2>
          <table>
            <thead><tr><th>{t("measure")}</th><th>±</th>{SIZES.map((s) => <th key={s}>{s}</th>)}</tr></thead>
            <tbody>{det.data.measures.map((m) => <tr key={m.name}><td>{m.name}</td><td>{m.tolerance ?? ""}</td>{SIZES.map((s) => <td key={s}>{m.vals[s] ?? ""}</td>)}</tr>)}</tbody>
          </table>
        </>
      )}
    </div>
  );
}
