import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useMe, useUi } from "../state";

export function OrdersPage() {
  const { t, formatMoney } = useUi() as any;
  const { can } = useMe();
  const nav = useNavigate();
  const list = useQuery({ queryKey: ["orders"], queryFn: () => api<any[]>("/orders") });
  return (
    <div>
      <h1>{t("orders")}</h1>
      {can("orders.create") && <p><button onClick={() => nav("/orders/new")}>+ {t("orderNew")}</button></p>}
      <table>
        <thead><tr><th>{t("number")}</th><th>{t("client")}</th><th>{t("status")}</th><th>{t("qty")}</th><th>{t("amount")}</th><th>{t("dueDate")}</th></tr></thead>
        <tbody>{list.data?.map((o) => <tr key={o.id}><td className="mono"><Link to={`/orders/${o.id}`}>{o.number}</Link></td><td>{o.client}</td><td>{o.status}</td><td className="num">{o.qty}</td>
          <td className="num">{formatMoney ? formatMoney(o.total, o.currency) : `${o.total} ${o.currency}`}</td><td>{o.due_date?.slice(0, 10)}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

export function OrderNew() {
  const { t } = useUi();
  const nav = useNavigate();
  const deals = useQuery({ queryKey: ["won-deals"], queryFn: () => api<any[]>("/orders/won-deals") });
  const models = useQuery({ queryKey: ["models"], queryFn: () => api<any[]>("/models") });
  const [dealId, setDealId] = useState("");
  const [due, setDue] = useState("");
  const [modelId, setModelId] = useState("");
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [lines, setLines] = useState<{ variantId: string; label: string; qty: number }[]>([]);
  const det = useQuery({ queryKey: ["model", modelId], enabled: !!modelId, queryFn: () => api<any>(`/models/${modelId}`) });
  const addLines = () => {
    const add = (det.data?.variants ?? []).filter((v: any) => Number(qtys[v.id]) > 0).map((v: any) => ({ variantId: v.id, label: `${det.data.model.code} ${v.color} ${v.size}`, qty: Number(qtys[v.id]) }));
    setLines([...lines, ...add]); setQtys({});
  };
  const create = useMutation({
    mutationFn: () => api<{ id: string }>(`/orders/from-deal/${dealId}`, { method: "POST", body: JSON.stringify({ items: lines.map((l) => ({ variantId: l.variantId, qty: l.qty })), dueDate: due || undefined }) }),
    onSuccess: (r) => nav(`/orders/${r.id}`),
  });
  return (
    <div>
      <h1>{t("orderNew")}</h1>
      <p><select value={dealId} onChange={(e) => setDealId(e.target.value)}><option value="">{t("wonDeal")}</option>{deals.data?.map((d) => <option key={d.id} value={d.id}>{d.title} — {d.client}</option>)}</select>{" "}
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></p>
      <p><select value={modelId} onChange={(e) => setModelId(e.target.value)}><option value="">{t("models")}</option>{models.data?.map((m) => <option key={m.id} value={m.id}>{m.code} {m.name}</option>)}</select></p>
      {det.data && <div>
        <table><thead><tr><th>{t("color")}</th><th>{t("size")}</th><th>{t("qty")}</th></tr></thead>
          <tbody>{det.data.variants.map((v: any) => <tr key={v.id}><td>{v.color}</td><td>{v.size}</td><td><input type="number" min="0" style={{ width: 80 }} value={qtys[v.id] ?? ""} onChange={(e) => setQtys({ ...qtys, [v.id]: e.target.value })} /></td></tr>)}</tbody></table>
        <button onClick={addLines}>{t("addLines")}</button>
      </div>}
      <h2>{t("order")}</h2>
      <ul>{lines.map((l, i) => <li key={i}>{l.label} × {l.qty} <a href="#" onClick={(e) => { e.preventDefault(); setLines(lines.filter((_, j) => j !== i)); }}>×</a></li>)}</ul>
      <button disabled={!dealId || !lines.length} onClick={() => create.mutate()}>{t("confirmIt")}</button>
      {create.isError && <span className="err"> {t("error")}: {(create.error as Error).message}</span>}
    </div>
  );
}

export function OrderView() {
  const { id } = useParams();
  const { t } = useUi();
  const { can } = useMe();
  const qc = useQueryClient();
  const o = useQuery({ queryKey: ["order", id], queryFn: () => api<any>(`/orders/${id}`) });
  const act = useMutation({ mutationFn: (a: string) => api(`/orders/${id}/${a}`, { method: "POST" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["order", id] }); qc.invalidateQueries({ queryKey: ["orders"] }); } });
  const [ship, setShip] = useState<Record<string, string>>({});
  const [paid, setPaid] = useState("");
  const shipIt = useMutation({
    mutationFn: async () => {
      const items = Object.entries(ship).filter(([, v]) => Number(v) > 0).map(([orderItemId, v]) => ({ orderItemId, qty: Number(v) }));
      const r = await api<{ id: string }>("/shipments", { method: "POST", body: JSON.stringify({ orderId: id, items }) });
      await api(`/shipments/${r.id}/ship`, { method: "POST" });
    },
    onSuccess: () => { setShip({}); qc.invalidateQueries({ queryKey: ["order", id] }); qc.invalidateQueries({ queryKey: ["shipments"] }); },
  });
  const setPaidM = useMutation({ mutationFn: () => api(`/orders/${id}/paid`, { method: "POST", body: JSON.stringify({ paid: Math.round(Number(paid) * 100) }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["order", id] }) });
  if (!o.data) return <p>{t("loading")}</p>;
  const d = o.data;
  return (
    <div>
      <h1>{d.number} · {d.client}</h1>
      <p><b>{d.status}</b> · {d.total} {d.currency} {d.due_date && `· ${d.due_date.slice(0, 10)}`}</p>
      {d.status === "pending_approval" && <p className="err">{t("pendingApproval")}</p>}
      {can("orders.create") && <p>
        {["draft", "pending_approval"].includes(d.status) && (d.status === "draft" || can("orders.approve")) && <button onClick={() => act.mutate("confirm")}>{t("confirmIt")}</button>}{" "}
        {!["shipped", "cancelled"].includes(d.status) && <button onClick={() => act.mutate("cancel")}>{t("cancelIt")}</button>}
        {act.isError && <span className="err"> {(act.error as Error).message}</span>}</p>}
      <table>
        <thead><tr><th>SKU</th><th>{t("qty")}</th><th>{t("reserved")}</th><th>{t("shipped")}</th><th>{t("shortage")}</th><th>{t("price")}</th>{can("shipments.create") && <th>{t("toShip")}</th>}</tr></thead>
        <tbody>{d.items.map((i: any) => <tr key={i.id}><td>{i.sku}</td><td className="num">{i.qty}</td><td className="num">{i.reserved}</td><td className="num">{i.shipped}</td><td className="num">{i.qty - i.reserved - i.shipped}</td><td className="num">{i.unit_price}</td>{can("shipments.create") && <td>{i.reserved > 0 && <input type="number" min="0" max={i.reserved} style={{ width: 70 }} value={ship[i.id] ?? ""} onChange={(e) => setShip({ ...ship, [i.id]: e.target.value })} />}</td>}</tr>)}</tbody>
      </table>
      {can("shipments.create") && <p><button disabled={!Object.values(ship).some((v) => Number(v) > 0)} onClick={() => shipIt.mutate()}>{t("shipNow")}</button>{shipIt.isError && <span className="err"> {(shipIt.error as Error).message}</span>}</p>}
      <p>{t("paid")}: {d.paid / 100} {d.currency} {can("orders.approve") && <><input type="number" min="0" style={{ width: 120 }} value={paid} onChange={(e) => setPaid(e.target.value)} /> <button onClick={() => setPaidM.mutate()}>{t("save")}</button></>}</p>
      {!!d.shipments.length && <><h2>{t("shipments")}</h2><ul>{d.shipments.map((x: any) => <li key={x.id}><Link to={`/shipments/${x.id}`}>{x.number}</Link> · {x.status}</li>)}</ul></>}
      {!!d.production.length && <><h2>{t("productionOrders")}</h2>
        <ul>{d.production.map((p: any) => <li key={p.id}><Link to={`/production/${p.id}`}>{p.number}</Link> · {p.model_code} · {p.status}</li>)}</ul></>}
    </div>
  );
}
