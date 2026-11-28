import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useMe, useUi } from "../state";

type Sev = "critical" | "major" | "minor";
interface Defect { defect: string; severity: Sev; qty: number; note?: string | null }
interface Insp { id: string; model_id: string; model: string; round: number; status: "draft" | "final"; inspected_on: string | null; inspector: string | null; lot_qty: number; sample_size: number;
  aql_major: number; aql_minor: number; ac_major: number; re_major: number; ac_minor: number; re_minor: number; notes: string | null; version: number;
  defects: (Defect & { id: string })[]; photos: { id: string; caption: string | null }[]; verdict: { critical: number; major: number; minor: number; result: "pass" | "fail"; reasons: string[] } }
interface Report extends Omit<Insp, "photos"> { photos: { id: string; caption: string | null; src: string }[] }
interface Model { id: string; code: string; qty: number }
/** Правки формы: дефекты без id (id присваивает сервер). */
type Form = Omit<Partial<Insp>, "defects"> & { defects?: Defect[] };

/** Сжатие снимка перед отправкой: длинная сторона до 1280 px, JPEG 0,8 — отчёт остаётся лёгким. */
async function compress(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("Не удалось прочитать снимок")); i.src = url; });
    const k = Math.min(1, 1280 / Math.max(img.width, img.height));
    const cv = document.createElement("canvas"); cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
    cv.getContext("2d")!.drawImage(img, 0, 0, cv.width, cv.height);
    return cv.toDataURL("image/jpeg", 0.8);
  } finally { URL.revokeObjectURL(url); }
}

/** Финальная инспекция AQL по моделям: план выборки, дефекты, фото, итог и печатный отчёт. */
export function ExportInspections({ orderId, models }: { orderId: string; models: Model[] }) {
  const { t } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const manage = can("exportinspections.manage");
  const q = useQuery({ queryKey: ["export-inspections", orderId], queryFn: () => api<Insp[]>(`/export-orders/${orderId}/inspections`) });
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, Form>>({});
  const [err, setErr] = useState("");
  const refresh = () => { qc.invalidateQueries({ queryKey: ["export-inspections", orderId] }); qc.invalidateQueries({ queryKey: ["export-inspection-report"] }); };
  const fail = (e: unknown) => setErr((e as Error)?.message || t("error"));
  const rows = q.data ?? [];
  const latest = (mid: string) => rows.filter((r) => r.model_id === mid).sort((a, b) => b.round - a.round)[0];
  const start = useMutation({ mutationFn: (modelId: string) => api<Insp>(`/export-orders/${orderId}/inspections`, { method: "POST", body: JSON.stringify({ modelId }) }), onSuccess: (r) => { setOpen(r.id); setErr(""); refresh(); }, onError: fail });
  const save = useMutation({
    mutationFn: async (i: Insp) => {
      const f = form[i.id] ?? {};
      let cur = i;
      if (["inspected_on", "inspector", "lot_qty", "aql_major", "aql_minor", "notes"].some((k) => k in f))
        cur = await api<Insp>(`/export-inspections/${i.id}`, { method: "PATCH", body: JSON.stringify({ version: i.version, inspectedOn: f.inspected_on || null, inspector: f.inspector ?? i.inspector,
          lotQty: f.lot_qty ?? undefined, aqlMajor: f.aql_major ?? undefined, aqlMinor: f.aql_minor ?? undefined, notes: f.notes ?? i.notes }) });
      if (f.defects) await api(`/export-inspections/${i.id}/defects`, { method: "PUT", body: JSON.stringify({ defects: f.defects.map((d) => ({ defect: d.defect, severity: d.severity, qty: d.qty, note: d.note || null })) }) });
      return cur;
    },
    onSuccess: (_r, i) => { const { [i.id]: _x, ...rest } = form; setForm(rest); setErr(""); refresh(); }, onError: fail,
  });
  const finalize = useMutation({ mutationFn: async (i: Insp) => { if (form[i.id]) await save.mutateAsync(i); return api(`/export-inspections/${i.id}/finalize`, { method: "POST" }); }, onSuccess: () => { setErr(""); refresh(); }, onError: fail });
  const photo = useMutation({
    mutationFn: async (v: { id: string; files: File[] }) => { for (const f of v.files) await api(`/export-inspections/${v.id}/photos`, { method: "POST", body: JSON.stringify({ mime: "image/jpeg", data: await compress(f), caption: f.name.replace(/\.[^.]+$/, "") }) }); },
    onSuccess: () => { setErr(""); refresh(); }, onError: fail,
  });
  const delPhoto = useMutation({ mutationFn: (id: string) => api(`/export-inspection-photos/${id}`, { method: "DELETE" }), onSuccess: refresh, onError: fail });

  return (
    <div>
      <h2>{t("aqTitle")}</h2>
      {err && <div className="err">{err}</div>}
      {models.map((m) => {
        const i = latest(m.id);
        return (
          <div key={m.id} style={{ border: "1px solid #3a4256", borderRadius: 6, padding: 10, margin: "8px 0" }}>
            <b>{m.code}</b> · {m.qty.toLocaleString()} {t("aqPcs")}
            {!i && manage && <> <button disabled={start.isPending} onClick={() => start.mutate(m.id)}>{t("aqStart")}</button></>}
            {i && (
              <>
                {" "}· {t("aqRound")} {i.round} · <b style={{ color: i.verdict.result === "pass" ? "#3a9d5d" : "#c0392b" }}>{i.verdict.result === "pass" ? t("aqPass") : t("aqFail")}</b> · {i.status === "final" ? t("aqFinal") : t("aqDraft")}
                {" "}<button className="secondary" onClick={() => setOpen(open === i.id ? null : i.id)}>{open === i.id ? t("aqHide") : t("aqOpen")}</button>
                {i.status === "final" && <> <a href={`/export-orders/${orderId}/inspections/${i.id}/report`} target="_blank" rel="noreferrer">{t("aqReport")}</a></>}
                {i.status === "final" && i.verdict.result === "fail" && manage && <> <button onClick={() => start.mutate(m.id)}>{t("aqNewRound")}</button></>}
                {open === i.id && <Editor i={i} f={form[i.id] ?? {}} manage={manage} t={t}
                  setF={(p) => setForm({ ...form, [i.id]: { ...form[i.id], ...p } })} dirty={!!form[i.id]}
                  onSave={() => save.mutate(i)} onFinalize={() => finalize.mutate(i)} onPhotos={(files) => photo.mutate({ id: i.id, files })} onDelPhoto={(id) => delPhoto.mutate(id)} busy={save.isPending || finalize.isPending || photo.isPending} />}
              </>)}
          </div>);
      })}
    </div>
  );
}

function Editor({ i, f, setF, manage, dirty, onSave, onFinalize, onPhotos, onDelPhoto, busy, t }: {
  i: Insp; f: Form; setF: (p: Form) => void; manage: boolean; dirty: boolean;
  onSave: () => void; onFinalize: () => void; onPhotos: (f: File[]) => void; onDelPhoto: (id: string) => void; busy: boolean; t: (k: any) => string;
}) {
  const draft = i.status === "draft" && manage;
  const defects: Defect[] = f.defects ?? i.defects;
  const rep = useQuery({ queryKey: ["export-inspection-report", i.id, i.photos.length], queryFn: () => api<Report>(`/export-inspections/${i.id}/report`) });
  const upd = (k: number, p: Partial<Defect>) => setF({ defects: defects.map((d, n) => (n === k ? { ...d, ...p } : d)) });
  const sum = (s: Sev) => defects.filter((d) => d.severity === s).reduce((a, d) => a + (Number(d.qty) || 0), 0);
  return (
    <div style={{ marginTop: 10 }}>
      <div className="muted">{t("aqPlan")}: {i.lot_qty} → {t("aqSample")} <b>{i.sample_size}</b> · major (AQL {i.aql_major}): Ac {i.ac_major} / Re {i.re_major} · minor (AQL {i.aql_minor}): Ac {i.ac_minor} / Re {i.re_minor} · critical: Ac 0</div>
      <div className="toolbar">
        <label>{t("aqDate")} <input type="date" disabled={!draft} value={(f.inspected_on ?? i.inspected_on ?? "").slice(0, 10)} onChange={(e) => setF({ inspected_on: e.target.value })} /></label>
        <label>{t("aqInspector")} <input disabled={!draft} value={f.inspector ?? i.inspector ?? ""} onChange={(e) => setF({ inspector: e.target.value })} /></label>
        <label>{t("aqLot")} <input type="number" min={1} disabled={!draft} style={{ width: 90 }} value={f.lot_qty ?? i.lot_qty} onChange={(e) => setF({ lot_qty: Number(e.target.value) })} /></label>
        <label>AQL major <select disabled={!draft} value={f.aql_major ?? i.aql_major} onChange={(e) => setF({ aql_major: Number(e.target.value) })}><option value={2.5}>2.5</option><option value={4}>4.0</option></select></label>
        <label>AQL minor <select disabled={!draft} value={f.aql_minor ?? i.aql_minor} onChange={(e) => setF({ aql_minor: Number(e.target.value) })}><option value={2.5}>2.5</option><option value={4}>4.0</option></select></label>
      </div>
      <table>
        <thead><tr><th>{t("aqDefect")}</th><th>{t("aqSeverity")}</th><th>{t("qty")}</th><th>{t("aqNote")}</th><th /></tr></thead>
        <tbody>
          {defects.map((d, k) => (
            <tr key={k}>
              <td><input disabled={!draft} value={d.defect} onChange={(e) => upd(k, { defect: e.target.value })} /></td>
              <td><select disabled={!draft} value={d.severity} onChange={(e) => upd(k, { severity: e.target.value as Sev })}><option value="critical">critical</option><option value="major">major</option><option value="minor">minor</option></select></td>
              <td><input type="number" min={1} disabled={!draft} style={{ width: 70 }} value={d.qty} onChange={(e) => upd(k, { qty: Number(e.target.value) })} /></td>
              <td><input disabled={!draft} value={d.note ?? ""} onChange={(e) => upd(k, { note: e.target.value })} /></td>
              <td>{draft && <button className="secondary" onClick={() => setF({ defects: defects.filter((_, n) => n !== k) })}>×</button>}</td>
            </tr>))}
          <tr><td colSpan={5}>
            {draft && <button className="secondary" onClick={() => setF({ defects: [...defects, { defect: "", severity: "minor", qty: 1, note: "" }] })}>+ {t("aqAddDefect")}</button>}
            {" "}<b>critical {sum("critical")} · major {sum("major")} / {i.ac_major} · minor {sum("minor")} / {i.ac_minor}</b>
          </td></tr>
        </tbody>
      </table>
      {i.verdict.reasons.map((r, k) => <div key={k} className="err">⚠ {r}</div>)}
      <label>{t("aqNotes")}<br /><textarea disabled={!draft} rows={2} style={{ width: "100%" }} value={f.notes ?? i.notes ?? ""} onChange={(e) => setF({ notes: e.target.value })} /></label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "8px 0" }}>
        {rep.data?.photos.map((p) => (
          <div key={p.id} style={{ width: 120 }}>
            <img src={p.src} alt={p.caption ?? ""} style={{ width: 120, height: 90, objectFit: "cover", borderRadius: 4 }} />
            <div className="muted" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.caption}</div>
            {draft && <button className="secondary" onClick={() => onDelPhoto(p.id)}>×</button>}
          </div>))}
      </div>
      {draft && (
        <div className="toolbar">
          <label>{t("aqPhotos")} <input type="file" accept="image/*" multiple onChange={(e) => { const fl = Array.from(e.target.files ?? []); e.target.value = ""; if (fl.length) onPhotos(fl); }} /></label>
          <button disabled={busy || !dirty} onClick={onSave}>{t("save")}</button>
          <button disabled={busy} onClick={() => { if (window.confirm(t("aqConfirmFinal"))) onFinalize(); }}>{t("aqFinalize")}</button>
        </div>)}
    </div>
  );
}
