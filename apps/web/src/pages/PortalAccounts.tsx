import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useUi } from "../state";

/** Аккаунты клиента для Mini App: создание, ссылка-приглашение, отключение. */
export function PortalAccounts({ clientId }: { clientId: string }) {
  const { t } = useUi();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["portal", clientId], queryFn: () => api<any[]>(`/clients/${clientId}/portal-accounts`) });
  const [f, setF] = useState({ name: "", email: "", password: "" });
  const [link, setLink] = useState<{ link: string | null; token: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["portal", clientId] });
  const add = useMutation({
    mutationFn: () => api(`/clients/${clientId}/portal-accounts`, { method: "POST", body: JSON.stringify({ name: f.name, email: f.email || undefined, password: f.password || undefined }) }),
    onSuccess: (r: any) => { setLink(r); setF({ name: "", email: "", password: "" }); refresh(); },
  });
  const inv = useMutation({ mutationFn: (id: string) => api(`/portal-accounts/${id}/invite`, { method: "POST" }), onSuccess: (r: any) => { setLink(r); refresh(); } });
  const off = useMutation({ mutationFn: (id: string) => api(`/portal-accounts/${id}/deactivate`, { method: "POST" }), onSuccess: refresh });
  return (
    <section>
      <h2>{t("portalAccess")}</h2>
      <table><tbody>{list.data?.map((a) => <tr key={a.id}>
        <td>{a.name}</td><td>{a.email}</td>
        <td>{!a.is_active ? "—" : a.linked ? t("linked") : a.invite_pending ? t("invitePending") : ""}</td>
        <td>{a.is_active && <><button onClick={() => inv.mutate(a.id)}>{t("newInvite")}</button> <button onClick={() => off.mutate(a.id)}>{t("deactivate")}</button></>}</td></tr>)}</tbody></table>
      {link && <p>{t("inviteLink")}: <code>{link.link ?? `start_param=${link.token}`}</code></p>}
      <form className="inline" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <input required placeholder={t("name")} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <input type="email" placeholder="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <input type="password" minLength={8} placeholder={t("password")} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        <button type="submit">{t("add")}</button>{add.isError && <span className="err"> {(add.error as Error).message}</span>}
      </form>
    </section>
  );
}
