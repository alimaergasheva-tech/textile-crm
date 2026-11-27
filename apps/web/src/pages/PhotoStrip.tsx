import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, blobUrl } from "../api";

/** Уменьшает снимок до 1280 px по длинной стороне и отдаёт JPEG в base64 (без префикса data:). */
export async function shrink(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.8).split(",")[1];
}

function Thumb({ id }: { id: string }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => { let on = true; blobUrl(`/files/${id}/raw`).then((u) => on && setSrc(u)).catch(() => {}); return () => { on = false; }; }, [id]);
  return src ? <a href={src} target="_blank" rel="noreferrer"><img src={src} alt="" style={{ height: 56, borderRadius: 4, marginRight: 6 }} /></a> : <span className="muted">…</span>;
}

/** Фото к заданию (брак) или рекламации: превью и кнопка «снять / выбрать». */
export function PhotoStrip({ entity, entityId, canAdd }: { entity: "production_order" | "complaint"; entityId: string; canAdd: boolean }) {
  const qc = useQueryClient();
  const key = ["photos", entity, entityId];
  const list = useQuery({ queryKey: key, queryFn: () => api<{ id: string }[]>(`/files?entity=${entity}&entityId=${entityId}`) });
  const [err, setErr] = useState("");
  const pick = async (f?: File) => {
    if (!f) return; setErr("");
    try {
      await api("/files/upload", { method: "POST", body: JSON.stringify({ name: f.name || "photo.jpg", mime: "image/jpeg", data: await shrink(f), entity, entityId }) });
      qc.invalidateQueries({ queryKey: key });
    } catch (e) { setErr((e as Error).message); }
  };
  return <span style={{ display: "inline-flex", alignItems: "center", flexWrap: "wrap" }}>
    {list.data?.map((f) => <Thumb key={f.id} id={f.id} />)}
    {canAdd && <label title="Добавить фото" style={{ cursor: "pointer" }}>📷<input type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} /></label>}
    {err && <span className="err"> {err}</span>}
  </span>;
}
