import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useUi } from "../state";

export interface Grid { id: string; name: string; sizes: { id: string; label: string }[] }
export interface Color { id: string; code: string; name_ru: string; name_uz: string | null; name_en: string | null; name_tr: string | null; hex: string | null }

export function CatalogSettingsPage() {
  const { t } = useUi();
  const qc = useQueryClient();
  const colors = useQuery({ queryKey: ["colors"], queryFn: () => api<Color[]>("/colors") });
  const grids = useQuery({ queryKey: ["grids"], queryFn: () => api<Grid[]>("/size-grids") });
  const [c, setC] = useState({ code: "", nameRu: "", nameUz: "", nameEn: "", nameTr: "", hex: "#3366cc" });
  const [g, setG] = useState({ name: "", sizes: "" });
  const addColor = useMutation({
    mutationFn: () => api("/colors", { method: "POST", body: JSON.stringify({ code: c.code, nameRu: c.nameRu, nameUz: c.nameUz || undefined, nameEn: c.nameEn || undefined, nameTr: c.nameTr || undefined, hex: c.hex }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["colors"] }); setC({ ...c, code: "", nameRu: "", nameUz: "", nameEn: "", nameTr: "" }); },
  });
  const addGrid = useMutation({
    mutationFn: () => api("/size-grids", { method: "POST", body: JSON.stringify({ name: g.name, sizes: g.sizes.split(",").map((x) => x.trim()).filter(Boolean) }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["grids"] }); setG({ name: "", sizes: "" }); },
  });
  const sc = (e: FormEvent) => { e.preventDefault(); addColor.mutate(); };
  const sg = (e: FormEvent) => { e.preventDefault(); addGrid.mutate(); };
  return (
    <div>
      <h1>{t("catalogSettings")}</h1>
      <div className="row2">
        <section>
          <h2>{t("color")}</h2>
          <table><tbody>{colors.data?.map((x) => (
            <tr key={x.id}><td><span style={{ display: "inline-block", width: 14, height: 14, background: x.hex ?? "#ccc", borderRadius: 3 }} /></td>
              <td>{x.code}</td><td>{x.name_ru}</td><td>{x.name_uz}</td><td>{x.name_en}</td><td>{x.name_tr}</td></tr>))}</tbody></table>
          <form className="inline" onSubmit={sc}>
            <input required placeholder={t("code")} value={c.code} onChange={(e) => setC({ ...c, code: e.target.value })} />
            <input required placeholder={t("nameRu")} value={c.nameRu} onChange={(e) => setC({ ...c, nameRu: e.target.value })} />
            <input placeholder={t("nameUz")} value={c.nameUz} onChange={(e) => setC({ ...c, nameUz: e.target.value })} />
            <input placeholder={t("nameEn")} value={c.nameEn} onChange={(e) => setC({ ...c, nameEn: e.target.value })} />
            <input placeholder={t("nameTr")} value={c.nameTr} onChange={(e) => setC({ ...c, nameTr: e.target.value })} />
            <input type="color" value={c.hex} onChange={(e) => setC({ ...c, hex: e.target.value })} />
            <button type="submit">{t("add")}</button>
            {addColor.isError && <span className="err">{t("error")}</span>}
          </form>
        </section>
        <section>
          <h2>{t("grid")}</h2>
          <table><tbody>{grids.data?.map((x) => <tr key={x.id}><td>{x.name}</td><td>{x.sizes.map((s) => s.label).join(", ")}</td></tr>)}</tbody></table>
          <form className="inline" onSubmit={sg}>
            <input required placeholder={t("name")} value={g.name} onChange={(e) => setG({ ...g, name: e.target.value })} />
            <input required placeholder={t("sizesList")} value={g.sizes} onChange={(e) => setG({ ...g, sizes: e.target.value })} />
            <button type="submit">{t("add")}</button>
            {addGrid.isError && <span className="err">{t("error")}</span>}
          </form>
        </section>
      </div>
    </div>
  );
}
