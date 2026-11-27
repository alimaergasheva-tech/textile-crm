// Нагрузочный тест без внешних пакетов: node scripts/loadtest.mjs [API_URL] [пользователей] [секунд]
// Для каждой демо-фабрики входит владельцем и в цикле запрашивает основные списки; считает ошибки и p50/p95/p99.
const API = process.argv[2] ?? "http://localhost:3000";
const USERS = Number(process.argv[3] ?? 100);
const SECONDS = Number(process.argv[4] ?? 30);
const tenants = (process.env.TENANTS ?? "demo-a,demo-b").split(",");
const paths = ["/clients", "/deals", "/orders", "/warehouse/stock", "/production-orders", "/feedback", "/audit"];
const lat = []; let errors = 0, total = 0;
const login = async (t) => {
  const r = await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tenant: t, email: `owner@${t}.uz`, password: "demo12345" }) });
  if (!r.ok) throw new Error(`вход ${t}: ${r.status}`);
  return (await r.json()).accessToken;
};
const tokens = await Promise.all(tenants.map(login));
const end = Date.now() + SECONDS * 1000;
await Promise.all(Array.from({ length: USERS }, async (_, i) => {
  const tok = tokens[i % tokens.length];
  while (Date.now() < end) {
    const p = paths[Math.floor(Math.random() * paths.length)];
    const t0 = performance.now();
    try { const r = await fetch(API + p, { headers: { authorization: `Bearer ${tok}` } }); await r.arrayBuffer(); if (r.status >= 500) errors++; } catch { errors++; }
    lat.push(performance.now() - t0); total++;
    await new Promise((r) => setTimeout(r, 200 + Math.random() * 800)); // «человеческая» пауза
  }
}));
lat.sort((a, b) => a - b);
const q = (x) => lat[Math.min(lat.length - 1, Math.floor(lat.length * x))].toFixed(0);
console.log(`Запросов: ${total}, ошибок 5xx/сети: ${errors}, p50=${q(0.5)} мс, p95=${q(0.95)} мс, p99=${q(0.99)} мс`);
console.log(q(0.95) <= 500 && errors === 0 ? "OK: p95 ≤ 500 мс, ошибок нет" : "ВНИМАНИЕ: превышен порог p95 500 мс или есть ошибки");
