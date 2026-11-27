import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useMe, useUi } from "../state";

interface Perm { code: string; module: string; action: string; description: string }
interface Role { id: string; name: string; permissions: { code: string; ownOnly: boolean }[] }

export function RolesPage() {
  const { t } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api<Role[]>("/roles") });
  const perms = useQuery({ queryKey: ["perms"], queryFn: () => api<Perm[]>("/permissions") });
  const [sel, setSel] = useState<string>("");
  const [draft, setDraft] = useState<Map<string, boolean>>(new Map());
  const role = roles.data?.find((r) => r.id === sel);
  useEffect(() => {
    if (!sel && roles.data?.[0]) setSel(roles.data[0].id);
  }, [roles.data, sel]);
  useEffect(() => { setDraft(new Map(role?.permissions.map((p) => [p.code, p.ownOnly]) ?? [])); }, [role]);
  const save = useMutation({
    mutationFn: () => api(`/roles/${sel}/permissions`, { method: "PUT",
      body: JSON.stringify({ permissions: [...draft].map(([code, ownOnly]) => ({ code, ownOnly })) }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["roles"] }),
  });
  const editable = can("roles.manage");
  const flip = (code: string) => { const m = new Map(draft); m.has(code) ? m.delete(code) : m.set(code, false); setDraft(m); };
  const own = (code: string) => { const m = new Map(draft); m.set(code, !m.get(code)); setDraft(m); };

  return (
    <div>
      <h1>{t("roles")}</h1>
      <select value={sel} onChange={(e) => setSel(e.target.value)}>
        {roles.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
      <table>
        <thead><tr><th>{t("code")}</th><th></th><th>{t("ownOnly")}</th></tr></thead>
        <tbody>{perms.data?.map((p) => (
          <tr key={p.code}>
            <td title={p.description}>{p.code}</td>
            <td><input type="checkbox" disabled={!editable} checked={draft.has(p.code)} onChange={() => flip(p.code)} /></td>
            <td><input type="checkbox" disabled={!editable || !draft.has(p.code)} checked={!!draft.get(p.code)} onChange={() => own(p.code)} /></td>
          </tr>))}</tbody>
      </table>
      {editable && <button onClick={() => save.mutate()}>{t("save")}</button>}
      {save.isError && <span className="err">{t("error")}</span>}
    </div>
  );
}
