import { Photos } from "./photos";
import { useCallback, useEffect, useState } from "react";
import { api, setToken } from "./api";
import { enqueue, flush, onQueue, queueSize, lastErrors } from "./queue";
import { Lang, tr, Key } from "./i18n";
import { Deals } from "./sales";
import { Stock } from "./stock";
import { Contractors } from "./contractors";
import { ClientApp } from "./client";

declare global { interface Window { Telegram?: { WebApp: any } } }
const tg = window.Telegram?.WebApp;
const initData: string = tg?.initData ?? "";
const params = new URLSearchParams(location.search);
const startParam: string | undefined = tg?.initDataUnsafe?.start_param ?? params.get("link") ?? undefined;
// start_param вида "<фабрика>_<случайная часть>"; фабрика может быть и в адресе (?t=demo-a) или сохранена ранее
const tenantOf = () => params.get("t") ?? (startParam ? startParam.slice(0, startParam.lastIndexOf("_")) : null) ?? localStorage.getItem("tenant") ?? "";
const lang: Lang = (tg?.initDataUnsafe?.user?.language_code === "uz" || params.get("lang") === "uz") ? "uz" : "ru";

type Mode = "staff" | "client";
/** Вход из Telegram: сначала как сотрудник, затем как клиент; по ссылке-приглашению — привязка аккаунта. */
async function telegramSignIn(): Promise<Mode | null> {
  const tenant = tenantOf();
  if (!initData || !tenant) return null;
  const tries: [string, Mode, object][] = [
    ["/auth/telegram", "staff", { tenant, initData }], ["/client/auth/telegram", "client", { tenant, initData }],
    ...(startParam ? [["/auth/telegram/link", "staff", { tenant, initData, token: startParam }], ["/client/auth/link", "client", { tenant, initData, token: startParam }]] as [string, Mode, object][] : []),
  ];
  for (const [path, mode, body] of tries) {
    try {
      const r = await api<{ accessToken: string }>(path, { method: "POST", body: JSON.stringify(body) });
      setToken(r.accessToken); localStorage.setItem("tenant", tenant); localStorage.setItem("mode", mode);
      return mode;
    } catch { /* пробуем следующий способ */ }
  }
  return null;
}

export function App() {
  const t = (k: Key) => tr(lang, k);
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [mode, setMode] = useState<Mode>("staff");
  const [perms, setPerms] = useState<string[]>([]);
  const [tab, setTab] = useState<"tasks" | "qc" | "pay" | "deals" | "stock" | "contractors" | "">("");
  const [pending, setPending] = useState(queueSize());
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => { tg?.ready?.(); tg?.expand?.(); (async () => { const m = await telegramSignIn(); if (m) setMode(m); setSignedIn(!!m); setReady(true); })(); }, []);
  const reauth = useCallback(async () => !!(await telegramSignIn()), []);
  useEffect(() => {
    const sync = () => setPending(queueSize());
    const off = onQueue(sync);
    const go = () => { setOnline(true); void flush(reauth); };
    const stop = () => setOnline(false);
    window.addEventListener("online", go); window.addEventListener("offline", stop);
    const timer = setInterval(() => { if (queueSize()) void flush(reauth); }, 15000);
    return () => { off(); window.removeEventListener("online", go); window.removeEventListener("offline", stop); clearInterval(timer); };
  }, [reauth]);
  useEffect(() => { if (signedIn) void flush(reauth); }, [signedIn, reauth]);
  // Вкладки определяются правами пользователя: бригадир, ОТК, менеджер, кладовщик видят своё
  useEffect(() => { if (signedIn && mode === "staff") api<{ permissions: string[] }>("/mini/me").then((m) => setPerms(m.permissions)).catch(() => {}); }, [signedIn, mode]);
  const can = useCallback((p: string) => perms.includes(p), [perms]);
  const tabs = ([["tasks", "production.view"], ["qc", "production.qc"], ["pay", "production.view"], ["contractors", "production.manage"], ["deals", "deals.view"], ["stock", "warehouse.view"]] as const)
    .filter(([, p]) => perms.includes(p)).map(([k]) => k);
  const current = tabs.includes(tab as never) ? tab : tabs[0] ?? "";

  if (!ready) return <p className="muted" style={{ padding: 20 }}>…</p>;
  if (!signedIn) return <Login t={t} onDone={(m) => { setMode(m); setSignedIn(true); }} inTelegram={!!initData} />;
  return (
    <>
      <div className="top"><b>Textile</b><span className="muted">{pending ? `${t("queue")}: ${pending}` : ""}</span></div>
      {(!online || pending > 0) && <div className="banner">{t("offline")}</div>}
      {lastErrors.slice(-2).map((e, i) => <div key={i} className="banner err">{e}</div>)}
      {mode === "client" && <ClientApp t={t} lang={lang} />}
      {mode === "staff" && current === "tasks" && <Tasks t={t} />}
      {mode === "staff" && current === "qc" && <Qc t={t} />}
      {mode === "staff" && current === "pay" && <Pay t={t} />}
      {mode === "staff" && current === "deals" && <Deals t={t} lang={lang} can={can} />}
      {mode === "staff" && current === "contractors" && <Contractors t={t} canAccept={can("production.qc")} />}
      {mode === "staff" && current === "stock" && <Stock t={t} canWrite={can("warehouse.write")} />}
      {mode === "staff" && <nav className="tabs">{tabs.map((k) => <button key={k} className={current === k ? "on" : ""} onClick={() => setTab(k)}>{t(k)}</button>)}</nav>}
    </>
  );
}

function Login({ t, onDone, inTelegram }: { t: (k: Key) => string; onDone: (m: Mode) => void; inTelegram: boolean }) {
  const [f, setF] = useState({ tenant: localStorage.getItem("tenant") ?? "demo-a", email: "", password: "" });
  const [err, setErr] = useState("");
  const [asClient, setAsClient] = useState(false);
  if (inTelegram) return <p className="card err">{t("notLinked")}</p>;
  const go = async () => {
    try { const r = await api<{ accessToken: string }>(asClient ? "/client/auth/login" : "/auth/login", { method: "POST", body: JSON.stringify(f) }); setToken(r.accessToken); localStorage.setItem("tenant", f.tenant); onDone(asClient ? "client" : "staff"); }
    catch { setErr(t("error")); }
  };
  return (
    <div className="form">
      <p className="muted">{t("devLogin")}</p>
      <input placeholder={t("factory")} value={f.tenant} onChange={(e) => setF({ ...f, tenant: e.target.value })} />
      <input placeholder={t("email")} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
      <input type="password" placeholder={t("password")} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
      <label className="muted"><input type="checkbox" style={{ width: "auto" }} checked={asClient} onChange={(e) => setAsClient(e.target.checked)} /> {t("asClient")}</label>
      <button onClick={go}>{t("login")}</button>{err && <span className="err">{err}</span>}
    </div>
  );
}

function useList<T>(path: string): [T[] | null, () => void] {
  const [d, setD] = useState<T[] | null>(null);
  const load = useCallback(() => { api<T[]>(path).then(setD).catch(() => {}); }, [path]);
  useEffect(() => { load(); const off = onQueue(load); return off; }, [load]);
  return [d, load];
}
const pendingFor = (stepId: string) => JSON.parse(localStorage.getItem("queue.v1") ?? "[]")
  .filter((q: any) => q.path === `/production-steps/${stepId}/report`).reduce((a: number, q: any) => a + q.body.qty, 0);

function Tasks({ t }: { t: (k: Key) => string }) {
  const [rows] = useList<any>("/mini/tasks");
  if (!rows) return <p className="muted" style={{ padding: 20 }}>…</p>;
  if (!rows.length) return <p className="muted" style={{ padding: 20 }}>{t("empty")}</p>;
  return <>{rows.map((r) => <TaskCard key={r.id} r={r} t={t} />)}</>;
}

function TaskCard({ r, t }: { r: any; t: (k: Key) => string }) {
  const [qty, setQty] = useState("");
  const [, bump] = useState(0);
  const waiting = pendingFor(r.id);
  const left = Math.max(0, r.plan - r.reported - waiting);
  const n = Math.min(Number(qty) || 0, left);
  const send = () => {
    if (n <= 0) return;
    enqueue({ path: `/production-steps/${r.id}/report`, method: "POST", body: { qty: n }, label: `${r.number} ${r.name}` });
    tg?.HapticFeedback?.notificationOccurred?.("success");
    setQty(""); bump((x) => x + 1);
  };
  const pct = Math.min(100, Math.round(((r.reported + waiting) / r.plan) * 100));
  return (
    <div className="card">
      <h3>{r.name}</h3>
      <div className="muted">{r.number} · {r.model_code}{r.deadline ? ` · ${t("deadline")} ${String(r.deadline).slice(0, 10)}` : ""}</div>
      <div className="bar"><i style={{ width: `${pct}%` }} /></div>
      <div className="muted">{r.reported + waiting} / {r.plan} · {t("left")} {left}{waiting ? ` (${t("queue")}: ${waiting})` : ""}</div>
      <div className="row" style={{ marginTop: 10 }}>
        <input className="qty" inputMode="numeric" value={qty} placeholder="0" onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))} />
        {[1, 5, 10].map((k) => <button key={k} className="ghost" onClick={() => setQty(String(Math.min(left, (Number(qty) || 0) + k)))}>+{k}</button>)}
        <button className="ghost" onClick={() => setQty(String(left))}>{t("all")}</button>
      </div>
      <button style={{ width: "100%", marginTop: 10 }} disabled={n <= 0} onClick={send}>{t("done")} {n || ""}</button>
    </div>
  );
}

function Qc({ t }: { t: (k: Key) => string }) {
  const [rows, reload] = useList<any>("/mini/qc");
  const [vals, setVals] = useState<Record<string, { good: string; defect: string }>>({});
  if (!rows) return <p className="muted" style={{ padding: 20 }}>…</p>;
  if (!rows.length) return <p className="muted" style={{ padding: 20 }}>{t("empty")}</p>;
  return <>{rows.map((p) => (
    <div className="card" key={p.id}>
      <h3>{p.number} · {p.model_code}</h3>
      <Photos entityId={p.id} label={t("defectPhoto")} />
      {p.items.map((i: any) => {
        const v = vals[i.variant_id] ?? { good: String(i.planned_qty), defect: "0" };
        const set = (x: Partial<typeof v>) => setVals({ ...vals, [i.variant_id]: { ...v, ...x } });
        return <div key={i.variant_id} style={{ margin: "10px 0" }}>
          <div className="muted">{i.sku} · {i.planned_qty}</div>
          <div className="row"><input className="qty" inputMode="numeric" value={v.good} onChange={(e) => set({ good: e.target.value.replace(/\D/g, "") })} aria-label={t("good")} />
            <input className="qty" inputMode="numeric" value={v.defect} onChange={(e) => set({ defect: e.target.value.replace(/\D/g, "") })} aria-label={t("defect")} /></div>
          <div className="muted">{t("good")} / {t("defect")}</div></div>;
      })}
      <button style={{ width: "100%" }} onClick={() => {
        enqueue({ path: `/production-orders/${p.id}/qc`, method: "POST", label: `ОТК ${p.number}`,
          body: { lines: p.items.map((i: any) => { const v = vals[i.variant_id] ?? { good: String(i.planned_qty), defect: "0" }; return { variantId: i.variant_id, good: Number(v.good) || 0, defect: Number(v.defect) || 0, action: "writeoff" }; }) } });
        reload();
      }}>{t("accept")}</button>
    </div>))}</>;
}

function Pay({ t }: { t: (k: Key) => string }) {
  const [rows] = useList<any>("/mini/earnings");
  if (!rows) return <p className="muted" style={{ padding: 20 }}>…</p>;
  return <div className="card"><h3>{t("month")}</h3>
    {rows.length ? rows.map((r) => <p key={r.currency}><b style={{ fontSize: 24 }}>{(r.amount / 100).toLocaleString("ru-RU")} {r.currency}</b><br /><span className="muted">{r.pieces} {t("pieces")}</span></p>) : <p className="muted">0</p>}</div>;
}
