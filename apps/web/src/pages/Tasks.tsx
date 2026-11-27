import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { localeOf } from "../i18n";
import { useMe, useUi } from "../state";

interface T { id: string; title: string; due_at: string | null; done_at: string | null; entity: string | null }

export function TasksPage() {
  const { t, lang } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const [showDone, setShowDone] = useState(false);
  const [f, setF] = useState({ title: "", due: "" });
  const tasks = useQuery({ queryKey: ["tasks", showDone], queryFn: () => api<T[]>(`/tasks?done=${showDone ? 1 : 0}`) });
  const add = useMutation({
    mutationFn: () => api("/tasks", { method: "POST", body: JSON.stringify({ title: f.title, dueAt: f.due ? new Date(f.due).toISOString() : undefined }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["tasks"] }); setF({ title: "", due: "" }); },
  });
  const toggle = useMutation({
    mutationFn: (x: T) => api(`/tasks/${x.id}`, { method: "PATCH", body: JSON.stringify({ done: !x.done_at }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); add.mutate(); };
  const late = (x: T) => !x.done_at && x.due_at && new Date(x.due_at) < new Date();
  return (
    <div>
      <h1>{t("tasks")}</h1>
      <label style={{ display: "inline-flex", gap: 6 }}>
        <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />{t("done")}
      </label>
      <table>
        <tbody>{tasks.data?.map((x) => (
          <tr key={x.id}>
            <td><input type="checkbox" checked={!!x.done_at} disabled={!can("tasks.edit")} onChange={() => toggle.mutate(x)} /></td>
            <td>{x.title}</td>
            <td className={late(x) ? "err" : "muted"}>{x.due_at ? new Date(x.due_at).toLocaleString(localeOf(lang)) : ""}</td>
          </tr>))}</tbody>
      </table>
      {tasks.data && !tasks.data.length && <p className="muted">{t("noData")}</p>}
      {can("tasks.create") && (
        <form className="inline" onSubmit={submit}>
          <h2>{t("newTask")}</h2>
          <input required placeholder={t("title")} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          <input type="datetime-local" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} />
          <button type="submit">{t("add")}</button>
        </form>
      )}
    </div>
  );
}
