import { useEffect, useState } from "react";
import { api, blobUrl } from "./api";

async function shrink(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.8).split(",")[1];
}
function Thumb({ id }: { id: string }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => { let on = true; blobUrl(`/files/${id}/raw`).then((u) => on && setSrc(u)).catch(() => {}); return () => { on = false; }; }, [id]);
  return src ? <img src={src} alt="" style={{ height: 64, borderRadius: 6, marginRight: 6 }} /> : null;
}

/** Фото брака к заданию: снять камерой и отправить (нужна связь; без неё покажет ошибку). */
export function Photos({ entityId, label }: { entityId: string; label: string }) {
  const [ids, setIds] = useState<string[]>([]);
  const [msg, setMsg] = useState("");
  const load = () => api<{ id: string }[]>(`/files?entity=production_order&entityId=${entityId}`).then((r) => setIds(r.map((x) => x.id))).catch(() => {});
  useEffect(() => { void load(); }, [entityId]);
  const pick = async (f?: File) => {
    if (!f) return; setMsg("…");
    try { await api("/files/upload", { method: "POST", body: JSON.stringify({ name: f.name || "photo.jpg", mime: "image/jpeg", data: await shrink(f), entity: "production_order", entityId }) }); setMsg(""); await load(); }
    catch (e) { setMsg((e as Error).message); }
  };
  return <div style={{ margin: "8px 0" }}>
    <div>{ids.map((id) => <Thumb key={id} id={id} />)}</div>
    <label className="muted" style={{ cursor: "pointer" }}>📷 {label}<input type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} /></label>
    {msg && <span className="muted"> {msg}</span>}
  </div>;
}
