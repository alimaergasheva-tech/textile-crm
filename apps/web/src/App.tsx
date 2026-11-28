import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, logout, refresh, setToken } from "./api";
import { MeProvider, Me, useMe, useUi } from "./state";
import { formatMoney, LANGS, Lang, localeOf } from "./i18n";
import { Login } from "./pages/Login";
import { UsersPage } from "./pages/Users";
import { RolesPage } from "./pages/Roles";
import { ReferencesPage } from "./pages/References";
import { AuditPage } from "./pages/Audit";
import { ClientsPage, ClientCard } from "./pages/Clients";
import { ExportCatalogPage } from "./pages/ExportCatalog";
import { ExportOrdersPage, ExportOrderCard } from "./pages/ExportOrders";
import { ExportDashboardPage } from "./pages/ExportDashboard";
import { ExportVedPage } from "./pages/ExportVed";
import { ExportGtdPage } from "./pages/ExportGtd";
import { ExportQuotePrint } from "./pages/ExportQuotePrint";
import { PatternsPage } from "./pages/Patterns";
import { ExportInspectionReport } from "./pages/ExportInspectionReport";
import { LeadsPage } from "./pages/Leads";
import { DealsPage } from "./pages/Deals";
import { TasksPage } from "./pages/Tasks";
import { DepartmentsPage } from "./pages/Departments";
import { useRealtime } from "./realtime";
import { OrdersPage, OrderNew, OrderView } from "./pages/Orders";
import { ProductionPage, ProductionView } from "./pages/Production";
import { FeedbackPage, RatePage } from "./pages/Feedback";
import { PlatformApp } from "./pages/Platform";
import { ExportPage } from "./pages/Export";
import { ShipmentsPage, ShipmentView } from "./pages/Shipments";
import { MovesPage, InventoryPage } from "./pages/Warehouse";
import { MaterialsPage } from "./pages/Materials";
import { PricingPage } from "./pages/Pricing";
import { QuotesPage, QuoteNew, QuoteView } from "./pages/Quotes";

/** Публичная страница оценки открывается без входа; всё остальное — для сотрудников. */
export function App() {
  const path = useLocation().pathname;
  if (path.startsWith("/platform")) return <PlatformApp />;
  return path.startsWith("/rate/") ? <Routes><Route path="/rate/:token" element={<RatePage />} /></Routes> : <Staff />;
}

function Staff() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const qc = useQueryClient();
  const load = async () => {
    try { setMe(await api<Me>("/auth/me")); } catch { setMe(null); }
  };
  useEffect(() => {
    // Вход поддержки: короткий токен из панели платформы приходит в адресе (#support=...), сразу убираем его из строки.
    const m = location.hash.match(/^#support=(.+)$/);
    if (m) { setToken(m[1]); history.replaceState(null, "", location.pathname); void load(); return; }
    refresh().then((ok) => (ok ? load() : setMe(null)));
  }, []);

  if (me === undefined) return <div className="center">…</div>;
  if (me === null) return <Login onDone={load} />;
  const ctx = { me, can: (c: string) => me.permissions.includes(c),
    signOut: async () => { await logout(); qc.clear(); setMe(null); } };
  return <MeProvider value={ctx}><Shell /></MeProvider>;
}

function Shell() {
  const { t, lang, setLang, theme, toggleTheme, currency, setCurrency } = useUi();
  const { can, signOut } = useMe();
  const nav = useNavigate();
  useRealtime();                      // живое обновление: изменения коллег приходят без перезагрузки
  const [q, setQ] = useState("");
  // Пункты меню: каждый следующий модуль добавляет свой. Пока доступны только настройки.
  const items = [
    { to: "/", label: t("home"), show: true },
    { to: "/deals", label: t("deals"), show: can("deals.view") },
    { to: "/leads", label: t("leads"), show: can("leads.view") },
    { to: "/clients", label: t("clients"), show: can("clients.view") },
    { to: "/tasks", label: t("tasks"), show: can("tasks.view") },
    { to: "/quotes", label: t("quotes"), show: can("quotes.view") },
    { to: "/materials", label: t("materials"), show: can("materials.view") },
    { to: "/orders", label: t("orders"), show: can("orders.view") },
    { to: "/export", label: t("exportData"), show: can("data.export") },
    { to: "/feedback", label: t("feedback"), show: can("feedback.view") },
    { to: "/export-dashboard", label: t("exportDashboard"), show: can("exportorders.view") },
    { to: "/export-orders", label: t("exportOrders"), show: can("exportorders.view") },
    { to: "/patterns", label: t("patterns"), show: can("patterns.view") },
    { to: "/export-catalog", label: t("exportFabrics"), show: can("patterns.view") },
    { to: "/shipments", label: t("shipments"), show: can("shipments.view") },
    { to: "/production", label: t("productionOrders"), show: can("production.view") },
    { to: "/movements", label: t("stockMoves"), show: can("warehouse.view") },
    { to: "/inventory", label: t("inventory"), show: can("warehouse.view") },
    { to: "/pricing", label: t("pricing"), show: can("pricing.view") },
    { to: "/departments", label: t("departments"), show: can("departments.view") },
    { to: "/users", label: t("users"), show: can("users.view") },
    { to: "/roles", label: t("roles"), show: can("roles.view") },
    { to: "/references", label: t("references"), show: can("settings.view") },
    { to: "/audit", label: t("audit"), show: can("audit.view") },
  ].filter((i) => i.show);

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">{t("appName")}</div>
        {items.map((i) => <NavLink key={i.to} to={i.to} end className={({ isActive }) => (isActive ? "on" : "")}>{i.label}</NavLink>)}
      </aside>
      <div className="main">
        <header className="top">
          <input className="search" placeholder={t("search")} value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && q) nav(`/clients?q=${encodeURIComponent(q)}`); }} />
          <select value={lang} onChange={(e) => setLang(e.target.value as Lang)} aria-label="language">
            {LANGS.map((l) => <option key={l.code} value={l.code}>{l.code.toUpperCase()}</option>)}
          </select>
          <select value={currency} onChange={(e) => setCurrency(e.target.value as "UZS" | "USD")} aria-label={t("currency")}>
            <option value="UZS">UZS</option><option value="USD">USD</option>
          </select>
          <button onClick={toggleTheme}>{t("theme")}: {theme === "light" ? "☀" : "☾"}</button>
          <button onClick={signOut}>{t("signOut")}</button>
        </header>
        <main className="content">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/deals" element={can("deals.view") ? <DealsPage /> : <Denied />} />
            <Route path="/leads" element={can("leads.view") ? <LeadsPage /> : <Denied />} />
            <Route path="/clients" element={can("clients.view") ? <ClientsPage /> : <Denied />} />
            <Route path="/clients/:id" element={can("clients.view") ? <ClientCard /> : <Denied />} />
            <Route path="/tasks" element={can("tasks.view") ? <TasksPage /> : <Denied />} />
            <Route path="/export-dashboard" element={can("exportorders.view") ? <ExportDashboardPage /> : <Denied />} />
            <Route path="/export-orders" element={can("exportorders.view") ? <ExportOrdersPage /> : <Denied />} />
            <Route path="/export-orders/:id/inspections/:iid/report" element={can("exportinspections.view") ? <ExportInspectionReport /> : <Denied />} />
            <Route path="/export-orders/:id/quotes/:qid/print" element={can("exportquotes.view") ? <ExportQuotePrint /> : <Denied />} />
            <Route path="/export-orders/:id/shipments/:sid/gtd" element={can("exportved.view") ? <ExportGtdPage /> : <Denied />} />
            <Route path="/export-orders/:id/shipments/:sid/docs" element={can("exportved.view") ? <ExportVedPage /> : <Denied />} />
            <Route path="/export-orders/:id" element={can("exportorders.view") ? <ExportOrderCard /> : <Denied />} />
            <Route path="/patterns" element={can("patterns.view") ? <PatternsPage /> : <Denied />} />
            <Route path="/export-catalog" element={can("patterns.view") ? <ExportCatalogPage /> : <Denied />} />
            <Route path="/departments" element={can("departments.view") ? <DepartmentsPage /> : <Denied />} />
            <Route path="/quotes" element={can("quotes.view") ? <QuotesPage /> : <Denied />} />
            <Route path="/quotes/new" element={can("quotes.create") ? <QuoteNew /> : <Denied />} />
            <Route path="/quotes/:id" element={can("quotes.view") ? <QuoteView /> : <Denied />} />
            <Route path="/materials" element={can("materials.view") ? <MaterialsPage /> : <Denied />} />
            <Route path="/orders" element={can("orders.view") ? <OrdersPage /> : <Denied />} />
            <Route path="/orders/new" element={can("orders.create") ? <OrderNew /> : <Denied />} />
            <Route path="/orders/:id" element={can("orders.view") ? <OrderView /> : <Denied />} />
            <Route path="/export" element={can("data.export") ? <ExportPage /> : <Denied />} />
            <Route path="/feedback" element={can("feedback.view") ? <FeedbackPage /> : <Denied />} />
            <Route path="/shipments" element={can("shipments.view") ? <ShipmentsPage /> : <Denied />} />
            <Route path="/shipments/:id" element={can("shipments.view") ? <ShipmentView /> : <Denied />} />
            <Route path="/production" element={can("production.view") ? <ProductionPage /> : <Denied />} />
            <Route path="/production/:id" element={can("production.view") ? <ProductionView /> : <Denied />} />
            <Route path="/movements" element={can("warehouse.view") ? <MovesPage /> : <Denied />} />
            <Route path="/inventory" element={can("warehouse.view") ? <InventoryPage /> : <Denied />} />
            <Route path="/pricing" element={can("pricing.view") ? <PricingPage /> : <Denied />} />
            <Route path="/users" element={can("users.view") ? <UsersPage /> : <Denied />} />
            <Route path="/roles" element={can("roles.view") ? <RolesPage /> : <Denied />} />
            <Route path="/references" element={can("settings.view") ? <ReferencesPage /> : <Denied />} />
            <Route path="/audit" element={can("audit.view") ? <AuditPage /> : <Denied />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

const Denied = () => <p>{useUi().t("noAccess")}</p>;
function Home() {
  const { t, lang, currency } = useUi();
  return (
    <div>
      <h1>{t("welcome")}</h1>
      <p>{t("comingSoon")}</p>
      <p className="muted">{t("currency")}: {formatMoney(12_345_600, currency, lang)}</p>
    </div>
  );
}
