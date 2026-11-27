import { FormEvent, useCallback, useEffect, useState } from "react";

const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

/** Панель владельца платформы: отдельный вход, отдельные токены, не связана с фабриками. */
export function PlatformApp() {
  const [token, setToken] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [tenants, setTenants] = useState<any[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const [created, setCreated] = useState<any>(null);

  const call = useCallback(async (path: string, method = "GET", body?: unknown) => {
    const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${r.status}: ${Array.isArray(j.message) ? j.message.join("; ") : j.message ?? ""}`);
    return j;
  }, [token]);
  const reload = useCallback(async () => {
    try { setTenants(await call("/platform/tenants")); setAudit(await call("/platform/audit")); } catch (e) { setErr((e as Error).message); }
  }, [call]);
  useEffect(() => { if (token) void reload(); }, [token, reload]);

  const act = async (fn: () => Promise<unknown>) => { setErr(""); try { await fn(); await reload(); } catch (e) { setErr((e as Error).message); } };

  if (!token) return <Login onToken={setToken} />;
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    void act(async () => setCreated(await call("/platform/tenants", "POST", {
      slug: d.get("slug"), name: d.get("name"), ownerEmail: d.get("email"), plan: d.get("plan") || "start",
      maxUsers: Number(d.get("maxUsers")) || 10, maxStorageMb: Number(d.get("maxStorageMb")) || 1024 })));
  };
  return (
    <div style={{ padding: 24 }}>
      <h1>Платформа: фабрики</h1>
      {err && <p className="err">{err}</p>}
      <table>
        <thead><tr><th>Код</th><th>Название</th><th>Тариф</th><th>Польз.</th><th>Файлы, МБ</th><th>Заказов за 30 дн.</th><th>Оплачено до</th><th>Статус</th><th /></tr></thead>
        <tbody>{tenants.map((t) => <tr key={t.id}>
          <td>{t.slug}</td><td>{t.name}</td><td>{t.plan}</td>
          <td className={t.users >= t.max_users ? "err" : ""}>{t.users} / {t.max_users}</td>
          <td>{Math.round(t.storage_mb)} / {t.max_storage_mb}</td><td>{t.orders_30d}</td><td>{t.paid_until?.slice(0, 10) ?? "—"}</td>
          <td>{t.status}{t.blocked_reason ? ` (${t.blocked_reason})` : ""}</td>
          <td>
            <button onClick={() => { const u = prompt("Макс. пользователей", t.max_users); const s = prompt("Хранилище, МБ", t.max_storage_mb); const p = prompt("Тариф", t.plan); const pd = prompt("Оплачено до (ГГГГ-ММ-ДД, пусто — нет)", t.paid_until?.slice(0, 10) ?? "");
              if (u && s && p) void act(() => call(`/platform/tenants/${t.id}`, "PATCH", { maxUsers: Number(u), maxStorageMb: Number(s), plan: p, paidUntil: pd || null })); }}>Лимиты</button>{" "}
            {t.status === "active"
              ? <button onClick={() => { const r = prompt("Причина блокировки", "не оплачен тариф"); if (r) void act(() => call(`/platform/tenants/${t.id}/block`, "POST", { reason: r })); }}>Блок</button>
              : <button onClick={() => act(() => call(`/platform/tenants/${t.id}/unblock`, "POST"))}>Разблок</button>}{" "}
            <button disabled={t.status !== "active"} onClick={() => act(async () => {
              const { token: tk } = await call(`/platform/tenants/${t.id}/support-token`, "POST");
              window.open(`/#support=${tk}`, "_blank");
            })}>Войти (поддержка)</button>
          </td></tr>)}</tbody>
      </table>
      <h2>Новая фабрика</h2>
      <form className="inline" onSubmit={submit}>
        <input name="slug" required placeholder="код (латиница)" /><input name="name" required placeholder="Название" />
        <input name="email" type="email" required placeholder="email директора" /><input name="plan" placeholder="тариф (start)" />
        <input name="maxUsers" type="number" placeholder="польз. (10)" /><input name="maxStorageMb" type="number" placeholder="МБ (1024)" />
        <button type="submit">Создать</button>
      </form>
      {created && <p>Создана «{created.slug}». Директор: {created.ownerEmail}, временный пароль: <b>{created.tempPassword}</b> (покажите один раз, затем смените).</p>}
      <h2>Журнал платформы</h2>
      <table>
        <thead><tr><th>Время</th><th>Админ</th><th>Фабрика</th><th>Действие</th><th>Детали</th></tr></thead>
        <tbody>{audit.map((a) => <tr key={a.id}><td>{a.created_at.slice(0, 19).replace("T", " ")}</td><td>{a.admin}</td><td>{a.tenant ?? "—"}</td><td>{a.action}</td><td>{a.details ? JSON.stringify(a.details) : ""}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function Login({ onToken }: { onToken: (t: string) => void }) {
  const [err, setErr] = useState("");
  return (
    <form className="center" style={{ gap: 10, display: "grid", alignContent: "center", justifyItems: "center" }} onSubmit={async (e) => {
      e.preventDefault(); const d = new FormData(e.currentTarget);
      const r = await fetch(BASE + "/platform/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: d.get("email"), password: d.get("password") }) });
      if (!r.ok) return setErr("Неверные данные для входа");
      onToken((await r.json()).token);
    }}>
      <h2>Платформа</h2>
      <input name="email" type="email" placeholder="email" required /><input name="password" type="password" placeholder="пароль" required />
      <button type="submit">Войти</button>{err && <span className="err">{err}</span>}
    </form>
  );
}
