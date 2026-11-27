// Сквозной тест цикла (Tasks 6.6): лид → клиент+сделка → КП → выигрыш → заказ → производство → ОТК → отгрузка → оценка и рекламация.
// Запуск: node scripts/e2e.mjs [API_URL]. Работает на фабрике demo-a под владельцем; создаёт данные с меткой E2E.
const API = process.argv[2] ?? "http://localhost:3000";
let token = "", okN = 0, failN = 0;
const log = (s) => console.log(s);
async function call(method, path, body, auth = true) {
  const r = await fetch(API + path, { method, headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}
async function step(name, fn) {
  try { const v = await fn(); okN++; log(`OK   ${name}`); return v ?? true; }
  catch (e) { failN++; log(`FAIL ${name}: ${e.message}`); return undefined; }
}
const need = (r, codes = [200, 201]) => { if (!codes.includes(r.status)) throw new Error(`HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`); return r.json; };
const tag = "E2E " + new Date().toISOString().slice(11, 19);

token = need(await call("POST", "/auth/login", { tenant: process.env.E2E_TENANT ?? "demo-a", email: process.env.E2E_EMAIL ?? "owner@demo-a.uz", password: process.env.E2E_PASSWORD ?? "demo12345" }, false)).accessToken;

const lead = await step("Лид создан", async () => need(await call("POST", "/leads", { name: tag, company: "Клиент " + tag, phone: "+998901112233", sourceCode: "call" })));
const conv = lead && await step("Лид → клиент и сделка", async () => need(await call("POST", `/leads/${lead.id}/convert`, { createDeal: true, dealTitle: "Сделка " + tag })));
const clientId = conv?.clientId, dealId = conv?.dealId;
if (!clientId || !dealId) { log("Нет клиента/сделки — дальше нельзя."); process.exit(1); }

const models = need(await call("GET", "/models"));
let model, variant;
for (const m of models) {
  const d = need(await call("GET", `/models/${m.id}`));
  if (d.variants.length && d.route.length && d.prices.some((p) => p.amount)) { model = d; variant = d.variants[0]; break; }
}
if (!variant) { log("FAIL Нет модели с маршрутом, вариантами и ценой — запустите db:seed-demo"); process.exit(1); }
log(`Модель: ${model.model.code} ${model.model.name}, вариант ${variant.sku}`);
const bal = need(await call("GET", "/stock/balances?kind=variant")).find((b) => b.id === variant.id);
const free = bal ? Math.max(0, bal.qty - bal.reserved) : 0;
const qty = free + 3;
log(`Свободный остаток варианта: ${free}, заказываем ${qty} (3 шт. уйдут в производство)`);

const quote = await step("КП создано", async () => need(await call("POST", "/quotes", { clientId, dealId, currency: "UZS", lines: [{ variantId: variant.id, qty }] })));
if (quote) await step("КП отправлено → принято", async () => { need(await call("PATCH", `/quotes/${quote.id}/status`, { status: "sent" })); need(await call("PATCH", `/quotes/${quote.id}/status`, { status: "accepted" })); });

const stages = need(await call("GET", "/pipeline-stages"));
const won = stages.find((s) => s.kind === "won");
await step("Сделка → «Выиграна»", async () => need(await call("PATCH", `/deals/${dealId}/stage`, { stageId: won.id })));
await step("Сделка видна в «выигранных»", async () => { if (!need(await call("GET", "/orders/won-deals")).some((d) => d.id === dealId)) throw new Error("нет в списке"); });

const order = await step("Заказ из сделки (резерв + задания)", async () => need(await call("POST", `/orders/from-deal/${dealId}`, { items: [{ variantId: variant.id, qty }], note: tag })));
if (!order) process.exit(1);
log(`Заказ ${order.number}: статус ${order.status}, производств создано ${order.productions}`);
if (order.status === "pending_approval") await step("Подтверждение руководителем", async () => need(await call("POST", `/orders/${order.id}/confirm`)));

const pos = need(await call("GET", "/production-orders")).filter((p) => p.order_number === order.number);
log(`Заданий по заказу: ${pos.length}`);
for (const po0 of pos) {
  await step(`${po0.number}: запланировать`, async () => need(await call("POST", `/production-orders/${po0.id}/plan`, {})));
  await step(`${po0.number}: запуск (списание материалов)`, async () => need(await call("POST", `/production-orders/${po0.id}/start`)));
  const po = need(await call("GET", `/production-orders/${po0.id}`));
  if (po.status !== "in_progress") { log(`  задание не в работе (${po.status}) — этапы пропущены`); continue; }
  for (const s of po.steps) await step(`${po0.number}: этап ${s.step} «${s.name}» выполнен`, async () => need(await call("POST", `/production-steps/${s.id}/report`, { qty: po.plannedTotal })));
  await step(`${po0.number}: передано в ОТК`, async () => need(await call("POST", `/production-orders/${po0.id}/to-qc`)));
  await step(`${po0.number}: приёмка ОТК (годные на склад)`, async () => need(await call("POST", `/production-orders/${po0.id}/qc`, { lines: po.items.map((i) => ({ variantId: i.variant_id, good: i.planned_qty, defect: 0 })) })));
}

const od = need(await call("GET", `/orders/${order.id}`));
const items = od.items ?? od.order?.items ?? [];
log(`Заказ после ОТК: статус ${od.status ?? od.order?.status}`);
const ship = await step("Отгрузка создана", async () => need(await call("POST", "/shipments", { orderId: order.id, items: items.map((i) => ({ orderItemId: i.id, qty: i.reserved })).filter((i) => i.qty > 0) })));
if (ship) await step("Отгрузка проведена (склад, резерв)", async () => need(await call("POST", `/shipments/${ship.id}/ship`)));
await step("Статус заказа после отгрузки", async () => { const o = need(await call("GET", `/orders/${order.id}`)); const st = o.status ?? o.order?.status; log(`  статус: ${st}`); if (!["shipped", "ready", "in_production", "confirmed"].includes(st)) throw new Error(st); });
if (ship) await step("PDF накладной", async () => { const r = await fetch(`${API}/shipments/${ship.id}/pdf`, { headers: { authorization: `Bearer ${token}` } }); if (!r.ok || !(r.headers.get("content-type") ?? "").includes("pdf")) throw new Error("HTTP " + r.status); });

const fb = need(await call("GET", "/feedback")).find((f) => f.order_number === order.number);
await step("Запрос оценки создан после отгрузки", async () => { if (!fb) throw new Error("нет записи feedback"); });
if (fb) await step("Клиент оценивает по ссылке (публично)", async () => {
  need(await call("GET", `/public/feedback/${fb.token}`, undefined, false));
  need(await call("POST", `/public/feedback/${fb.token}`, { rating: 5, comment: "e2e" }, false));
});
const cmp = await step("Рекламация заведена", async () => need(await call("POST", "/complaints", { orderId: order.id, variantId: variant.id, reasonCode: "defect", description: tag, qty: 1 })));
if (cmp && cmp !== true) await step("Рекламация → в работе", async () => need(await call("PATCH", `/complaints/${cmp.id}/status`, { status: "in_progress" })));

// Фото брака и рекламаций: загрузка, список, чтение, запрет не-фото
const JPG = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
const poId = pos[0]?.id;
for (const [entity, id] of [["production_order", poId], ["complaint", cmp && cmp !== true ? cmp.id : undefined]]) {
  if (!id) continue;
  const up = await step(`Фото к ${entity} загружено`, async () => need(await call("POST", "/files/upload", { name: "e2e.jpg", mime: "image/jpeg", data: JPG, entity, entityId: id })));
  await step(`Фото к ${entity} в списке и читается`, async () => {
    const l = need(await call("GET", `/files?entity=${entity}&entityId=${id}`));
    if (!l.some((f) => f.id === up?.id)) throw new Error("нет в списке");
    const r = await fetch(`${API}/files/${up.id}/raw`, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("image")) throw new Error("HTTP " + r.status);
    if ((await r.arrayBuffer()).byteLength < 50) throw new Error("пустой файл");
  });
}
await step("Не-фото отклоняется (400)", async () => { const r = await call("POST", "/files/upload", { name: "x.exe", mime: "application/octet-stream", data: "AAAA", entity: "complaint", entityId: cmp?.id ?? "00000000-0000-0000-0000-000000000000" }); if (r.status !== 400) throw new Error("HTTP " + r.status); });

for (const p of [ship ? `/shipments/${ship.id}` : "/shipments", "/clients", "/deals", "/orders", "/shipments", "/production-orders", "/production/board", "/stock/balances?kind=variant", "/feedback", "/feedback/stats", "/complaints", "/audit", "/mini/me"])
  await step(`GET ${p}`, async () => need(await call("GET", p)));

log(`\nИтого: ${okN} OK, ${failN} FAIL`);
log(failN === 0 ? "СКВОЗНОЙ ЦИКЛ ПРОЙДЕН" : "ЕСТЬ ОШИБКИ — см. FAIL выше");
