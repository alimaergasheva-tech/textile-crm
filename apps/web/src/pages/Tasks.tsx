import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { localeOf } from "../i18n";
import { useMe, useUi } from "../state";

interface T {
  id: string; title: string; due_at: string | null; done_at: string | null; entity: string | null; version: number;
  status: "todo" | "in_progress" | "blocked" | "done"; blocked_reason: string | null; department_id: string | null;
  department_name: string | null; assignee_name: string | null; is_overdue: boolean; delay_days: number;
}
interface Dept { id: string; code: string; name: string }
interface Summary { overdue: number; today: number; in_progress: number; blocked: number; open: number }
const STATUSES = ["todo", "in_progress", "blocked", "done"] as const;

/** «Мои задачи» и «Задачи отдела» в одном экране; изменения других людей приходят без перезагрузки (useRealtime в оболочке). */
export function TasksPage() {
  const { t, lang } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const [scope, setScope] = useState<"mine" | "dept">("mine");
  const [dept, setDept] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [msg, setMsg] = useState("");
  const [f, setF] = useState({ title: "", due: "", dept: "" });
  const depts = useQuery({ queryKey: ["departments"], queryFn: () => api<Dept[]>("/departments"), enabled: can("departments.view") });
  const q = new URLSearchParams({ done: showDone ? "1" : "0" });
  if (scope === "mine") q.set("mine", "1");
  if (scope === "dept" && dept) q.set("department", dept);
  const tasks = useQuery({ queryKey: ["tasks", scope, dept, showDone], queryFn: () => api<T[]>(`/tasks?${q}`) });
  const sq = scope === "dept" && dept ? `?department=${dept}` : "";
  const summary = useQuery({ queryKey: ["tasksSummary", scope, dept], queryFn: () => api<Summary>(`/tasks/summary${sq}`) });

  const refresh = () => { void qc.invalidateQueries({ queryKey: ["tasks"] }); void qc.invalidateQueries({ queryKey: ["tasksSummary"] }); };
  const add = useMutation({
    mutationFn: () => api("/tasks", { method: "POST", body: JSON.stringify({
      title: f.title, dueAt: f.due ? new Date(f.due).toISOString() : undefined, departmentId: f.dept || undefined }) }),
    onSuccess: () => { refresh(); setF({ title: "", due: "", dept: "" }); },
  });
  // Отправляем версию, которую видел пользователь: если задачу уже изменил коллега, сервер вернёт 409
  const patch = useMutation({
    mutationFn: ({ x, body }: { x: T; body: Record<string, unknown> }) =>
      api(`/tasks/${x.id}`, { method: "PATCH", body: JSON.stringify({ version: x.version, ...body }) }),
    onSuccess: () => setMsg(""),
    onError: (e: Error) => setMsg(e.message.startsWith("409") ? t("conflictMsg") : t("error")),
    onSettled: refresh,
  });
  const submit = (e: FormEvent) => { e.preventDefault(); add.mutate(); };
  const statusLabel = (s: T["status"]) => ({ todo: t("statusTodo"), in_progress: t("statusInProgress"), blocked: t("statusBlocked"), done: t("statusDone") })[s];
  const canEdit = can("tasks.edit");

  return (
    <div>
      <h1>{t("tasks")}</h1>
      <div className="inline">
        <button className={scope === "mine" ? "on" : ""} onClick={() => setScope("mine")}>{t("myTasks")}</button>
        {can("departments.view") && <button className={scope === "dept" ? "on" : ""} onClick={() => setScope("dept")}>{t("deptTasks")}</button>}
        {scope === "dept" && (
          <select value={dept} onChange={(e) => setDept(e.target.value)}>
            <option value="">{t("allDepartments")}</option>
            {depts.data?.filter((d) => d).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>)}
        <label style={{ display: "inline-flex", gap: 6 }}>
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />{t("done")}
        </label>
      </div>
      {summary.data && (
        <p className="muted">
          <b className={summary.data.overdue ? "err" : ""}>{t("overdue")}: {summary.data.overdue}</b> · {t("todayCount")}: {summary.data.today} · {t("statusInProgress")}: {summary.data.in_progress} · {t("statusBlocked")}: {summary.data.blocked} · {t("openCount")}: {summary.data.open}
        </p>)}
      {msg && <p className="err">{msg}</p>}
      <table>
        <thead><tr><th></th><th>{t("title")}</th><th>{t("department")}</th><th>{t("assignee")}</th><th>{t("status")}</th><th>{t("dueDate")}</th></tr></thead>
        <tbody>{tasks.data?.map((x) => (
          <tr key={x.id}>
            <td><input type="checkbox" checked={x.status === "done"} disabled={!canEdit} onChange={() => patch.mutate({ x, body: { done: x.status !== "done" } })} /></td>
            <td>{x.title}{x.status === "blocked" && x.blocked_reason ? <span className="muted"> — {x.blocked_reason}</span> : null}</td>
            <td className="muted">{x.department_name ?? ""}</td>
            <td className="muted">{x.assignee_name ?? ""}</td>
            <td>
              <select value={x.status} disabled={!canEdit} onChange={(e) => {
                const status = e.target.value as T["status"];
                const blockedReason = status === "blocked" ? (window.prompt(t("blockedReason")) ?? "") : undefined;
                if (status === "blocked" && !blockedReason) return;
                patch.mutate({ x, body: { status, ...(blockedReason ? { blockedReason } : {}) } });
              }}>
                {STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
              </select>
            </td>
            <td className={x.is_overdue ? "err" : "muted"}>
              {x.due_at ? new Date(x.due_at).toLocaleString(localeOf(lang)) : ""}
              {x.is_overdue ? ` (+${x.delay_days} ${t("daysShort")})` : ""}
            </td>
          </tr>))}</tbody>
      </table>
      {tasks.data && !tasks.data.length && <p className="muted">{t("noData")}</p>}
      {can("tasks.create") && (
        <form className="inline" onSubmit={submit}>
          <h2>{t("newTask")}</h2>
          <input required placeholder={t("title")} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          <input type="datetime-local" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} />
          {can("departments.view") && (
            <select value={f.dept} onChange={(e) => setF({ ...f, dept: e.target.value })}>
              <option value="">{t("noDepartment")}</option>
              {depts.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>)}
          <button type="submit">{t("add")}</button>
        </form>
      )}
    </div>
  );
}
