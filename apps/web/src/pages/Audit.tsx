import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { localeOf } from "../i18n";
import { useUi } from "../state";

interface A { id: number; user_id: string | null; entity: string; entity_id: string | null; action: string; created_at: string }

export function AuditPage() {
  const { t, lang } = useUi();
  const q = useQuery({ queryKey: ["audit"], queryFn: () => api<A[]>("/audit?limit=100") });
  return (
    <div>
      <h1>{t("audit")}</h1>
      {q.isLoading ? <p>{t("loading")}</p> : (
        <table>
          <thead><tr><th>{t("when")}</th><th>{t("who")}</th><th>{t("entity")}</th><th>{t("action")}</th></tr></thead>
          <tbody>{q.data?.map((a) => (
            <tr key={a.id}>
              <td>{new Date(a.created_at).toLocaleString(localeOf(lang))}</td>
              <td>{a.user_id?.slice(0, 8) ?? "—"}</td><td>{a.entity} {a.entity_id?.slice(0, 8)}</td><td>{a.action}</td>
            </tr>))}</tbody>
        </table>
      )}
    </div>
  );
}
