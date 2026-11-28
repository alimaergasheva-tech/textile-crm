import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useMe, useUi } from "../state";

interface Dept { id: string; code: string; name: string; head_user_id: string | null; telegram_chat_id: string | null; member_ids: string[] }
interface U { id: string; full_name: string }

/** Отделы фабрики: состав, руководитель, Telegram-чат отдела (для уведомлений об опозданиях). */
export function DepartmentsPage() {
  const { t } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const manage = can("departments.manage");
  const depts = useQuery({ queryKey: ["departments"], queryFn: () => api<Dept[]>("/departments") });
  const users = useQuery({ queryKey: ["users", "all"], queryFn: () => api<{ items: U[] }>("/users?limit=200"), enabled: can("users.view") });
  const [sel, setSel] = useState("");
  const [members, setMembers] = useState<Set<string>>(new Set());
  const [chat, setChat] = useState("");
  const d = depts.data?.find((x) => x.id === sel);
  useEffect(() => { if (!sel && depts.data?.[0]) setSel(depts.data[0].id); }, [depts.data, sel]);
  useEffect(() => { setMembers(new Set(d?.member_ids ?? [])); setChat(d?.telegram_chat_id ?? ""); }, [d?.id, d?.member_ids.join(","), d?.telegram_chat_id]);
  const save = useMutation({
    mutationFn: async () => {
      await api(`/departments/${sel}/members`, { method: "PUT", body: JSON.stringify({ userIds: [...members] }) });
      await api(`/departments/${sel}`, { method: "PATCH", body: JSON.stringify({ telegramChatId: chat ? Number(chat) : null }) });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["departments"] }),
  });
  const head = useMutation({
    mutationFn: (id: string) => api(`/departments/${sel}`, { method: "PATCH", body: JSON.stringify({ headUserId: id || null }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["departments"] }),
  });
  const flip = (id: string) => { const m = new Set(members); m.has(id) ? m.delete(id) : m.add(id); setMembers(m); };

  return (
    <div>
      <h1>{t("departments")}</h1>
      <select value={sel} onChange={(e) => setSel(e.target.value)}>
        {depts.data?.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.member_ids.length})</option>)}
      </select>
      {d && (
        <>
          <h2>{t("head")}</h2>
          <select value={d.head_user_id ?? ""} disabled={!manage} onChange={(e) => head.mutate(e.target.value)}>
            <option value="">—</option>
            {users.data?.items.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </select>
          <h2>{t("telegramChat")}</h2>
          <input value={chat} disabled={!manage} placeholder="-1001234567890" onChange={(e) => setChat(e.target.value)} />
          <h2>{t("members")}</h2>
          <table>
            <tbody>{users.data?.items.map((u) => (
              <tr key={u.id}>
                <td><input type="checkbox" disabled={!manage} checked={members.has(u.id)} onChange={() => flip(u.id)} /></td>
                <td>{u.full_name}</td>
              </tr>))}</tbody>
          </table>
          {manage && <button onClick={() => save.mutate()}>{t("save")}</button>}
          {save.isError && <span className="err">{t("error")}</span>}
        </>
      )}
    </div>
  );
}
