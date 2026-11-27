import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useMe, useUi } from "../state";

interface V { id: string; dictionary: string; code: string; name_ru: string; name_uz: string | null; name_en: string | null; name_tr: string | null; is_active: boolean }

export function ReferencesPage() {
  const { t } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const vals = useQuery({ queryKey: ["refs"], queryFn: () => api<V[]>("/reference-values") });
  const [f, setF] = useState({ dictionary: "lead_source", code: "", nameRu: "", nameUz: "", nameEn: "", nameTr: "" });
  const save = useMutation({
    mutationFn: (v: { dictionary: string; code: string; nameRu: string; nameUz?: string; nameEn?: string; nameTr?: string; isActive?: boolean }) =>
      api("/reference-values", { method: "PUT", body: JSON.stringify(v) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["refs"] }); setF({ ...f, code: "", nameRu: "", nameUz: "", nameEn: "", nameTr: "" }); },
  });
  const groups = [...new Set(vals.data?.map((v) => v.dictionary))];
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate({ ...f, nameUz: f.nameUz || undefined, nameEn: f.nameEn || undefined, nameTr: f.nameTr || undefined }); };

  return (
    <div>
      <h1>{t("references")}</h1>
      {groups.map((g) => (
        <section key={g}>
          <h2>{g}</h2>
          <table><tbody>{vals.data!.filter((v) => v.dictionary === g).map((v) => (
            <tr key={v.id}>
              <td>{v.code}</td><td>{v.name_ru}</td><td>{v.name_uz}</td><td>{v.name_en}</td><td>{v.name_tr}</td>
              <td><input type="checkbox" checked={v.is_active} disabled={!can("settings.manage")}
                onChange={() => save.mutate({ dictionary: v.dictionary, code: v.code, nameRu: v.name_ru,
                  nameUz: v.name_uz ?? undefined, nameEn: v.name_en ?? undefined, nameTr: v.name_tr ?? undefined, isActive: !v.is_active })} /></td>
            </tr>))}</tbody></table>
        </section>
      ))}
      {can("settings.manage") && (
        <form className="inline" onSubmit={submit}>
          <input required placeholder={t("dictionary")} value={f.dictionary} onChange={(e) => setF({ ...f, dictionary: e.target.value })} />
          <input required placeholder={t("code")} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
          <input required placeholder={t("nameRu")} value={f.nameRu} onChange={(e) => setF({ ...f, nameRu: e.target.value })} />
          <input placeholder={t("nameUz")} value={f.nameUz} onChange={(e) => setF({ ...f, nameUz: e.target.value })} />
          <input placeholder={t("nameEn")} value={f.nameEn} onChange={(e) => setF({ ...f, nameEn: e.target.value })} />
          <input placeholder={t("nameTr")} value={f.nameTr} onChange={(e) => setF({ ...f, nameTr: e.target.value })} />
          <button type="submit">{t("add")}</button>
        </form>
      )}
    </div>
  );
}
