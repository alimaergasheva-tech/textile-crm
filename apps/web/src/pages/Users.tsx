import { FormEvent, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useMe, useUi } from "../state";

interface U { id: string; email: string; full_name: string; is_active: boolean; role_ids: string[] }
interface Role { id: string; name: string }

export function UsersPage() {
  const { t } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const [sp] = useSearchParams();
  const [page, setPage] = useState(1);
  const [form, setForm] = useState({ fullName: "", email: "", password: "", roleId: "" });
  const users = useQuery({ queryKey: ["users", page], queryFn: () => api<{ items: U[]; total: number }>(`/users?page=${page}&limit=20`) });
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api<Role[]>("/roles"), enabled: can("roles.view") });
  const add = useMutation({
    mutationFn: () => api("/users", { method: "POST", body: JSON.stringify({
      fullName: form.fullName, email: form.email, password: form.password, roleIds: form.roleId ? [form.roleId] : [] }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["users"] }); setForm({ fullName: "", email: "", password: "", roleId: "" }); },
  });
  const toggle = useMutation({
    mutationFn: (u: U) => api(`/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ isActive: !u.is_active }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
  const filter = (sp.get("q") ?? "").toLowerCase();
  const rows = (users.data?.items ?? []).filter((u) => !filter || `${u.full_name} ${u.email}`.toLowerCase().includes(filter));
  const roleName = (id: string) => roles.data?.find((r) => r.id === id)?.name ?? "";
  const submit = (e: FormEvent) => { e.preventDefault(); add.mutate(); };

  return (
    <div>
      <h1>{t("users")}</h1>
      {users.isLoading ? <p>{t("loading")}</p> : (
        <table>
          <thead><tr><th>{t("name")}</th><th>{t("email")}</th><th>{t("role")}</th><th>{t("active")}</th></tr></thead>
          <tbody>{rows.map((u) => (
            <tr key={u.id}>
              <td>{u.full_name}</td><td>{u.email}</td><td>{u.role_ids.map(roleName).join(", ")}</td>
              <td><input type="checkbox" checked={u.is_active} disabled={!can("users.edit")} onChange={() => toggle.mutate(u)} /></td>
            </tr>))}</tbody>
        </table>
      )}
      <div className="pager">
        <button disabled={page <= 1} onClick={() => setPage(page - 1)}>{t("previous")}</button>
        <span>{page}</span>
        <button disabled={(users.data?.total ?? 0) <= page * 20} onClick={() => setPage(page + 1)}>{t("next")}</button>
      </div>
      {can("users.create") && (
        <form className="inline" onSubmit={submit}>
          <h2>{t("newUser")}</h2>
          <input required placeholder={t("name")} value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
          <input required type="email" placeholder={t("email")} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input required minLength={8} type="password" placeholder={t("password")} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <select value={form.roleId} onChange={(e) => setForm({ ...form, roleId: e.target.value })}>
            <option value="">—</option>{roles.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <button type="submit">{t("add")}</button>
          {add.isError && <span className="err">{t("error")}</span>}
        </form>
      )}
    </div>
  );
}
