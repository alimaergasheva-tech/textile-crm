import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useMe, useUi } from "../state";

/** Бригады, их состав и ссылки для привязки Telegram сотрудников. */
export function BrigadesPage() {
  const { t } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const brigades = useQuery({ queryKey: ["brigades"], queryFn: () => api<any[]>("/brigades") });
  const users = useQuery({ queryKey: ["users-all"], queryFn: () => api<{ items: any[] }>("/users?limit=200"), enabled: can("users.view") });
  const [name, setName] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [userId, setUserId] = useState("");
  const [link, setLink] = useState("");
  const members = useQuery({ queryKey: ["members", open], enabled: !!open, queryFn: () => api<any[]>(`/brigades/${open}/members`) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["members", open] }); qc.invalidateQueries({ queryKey: ["brigades"] }); };
  const addB = useMutation({ mutationFn: () => api("/brigades", { method: "POST", body: JSON.stringify({ name }) }), onSuccess: () => { setName(""); refresh(); } });
  const addM = useMutation({ mutationFn: () => api(`/brigades/${open}/members`, { method: "POST", body: JSON.stringify({ userId }) }), onSuccess: refresh });
  const rmM = useMutation({ mutationFn: (uid: string) => api(`/brigades/${open}/members/${uid}/remove`, { method: "POST" }), onSuccess: refresh });
  const invite = useMutation({
    mutationFn: (uid: string) => api<{ token: string; link: string | null }>(`/users/${uid}/telegram-invite`, { method: "POST" }),
    onSuccess: (r) => setLink(r.link ?? `Задайте TELEGRAM_BOT_USERNAME в .env. Токен приглашения: ${r.token}`),
  });
  return (
    <div>
      <h1>{t("brigades")}</h1>
      <table><thead><tr><th>{t("name")}</th></tr></thead>
        <tbody>{brigades.data?.map((b) => <tr key={b.id} onClick={() => setOpen(open === b.id ? null : b.id)} style={{ cursor: "pointer" }}><td>{b.name}</td></tr>)}</tbody></table>
      {can("production.manage") && <p><input placeholder={t("name")} value={name} onChange={(e) => setName(e.target.value)} /> <button disabled={!name} onClick={() => addB.mutate()}>{t("add")}</button></p>}
      {open && <div>
        <h2>{brigades.data?.find((b) => b.id === open)?.name}</h2>
        <ul>{members.data?.map((m) => <li key={m.id}>{m.full_name} {m.linked ? "✅ Telegram" : ""}{" "}
          {can("users.edit") && <button onClick={() => invite.mutate(m.id)}>Telegram</button>}{" "}
          {can("production.manage") && <button onClick={() => rmM.mutate(m.id)}>×</button>}</li>)}</ul>
        {can("production.manage") && <p><select value={userId} onChange={(e) => setUserId(e.target.value)}><option value="">{t("users")}</option>{users.data?.items.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</select> <button disabled={!userId} onClick={() => addM.mutate()}>{t("add")}</button></p>}
        {link && <p className="mono" style={{ wordBreak: "break-all" }}>{link}</p>}
      </div>}
    </div>
  );
}
